"use strict";
/**
 * Flow Forward - API gateway between the internet (Cloudflare Tunnel) and the local generation backend.
 *
 * - Forwards /api/* to the backend pool with timeouts, safe retries, health checks and circuit breaker.
 * - Submit limiter (queue) per task type so a big batch of video requests does not flood the backend.
 * - Task tracking: every generation task is stored in SQLite and polled in background until it is
 *   terminal, so failures are always recorded (with the backend's error body) even if the client stops polling.
 * - Batch API: POST /api/batch/video/generate, GET /api/batch/:id
 * - Full trace log (logs/trace/YYYY-MM-DD.jsonl[.gz]) + SQLite so any failure can be traced:
 *     GET /api/admin/trace?task_id=...  |  ?request_id=...  |  ?batch_id=...
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const crypto = require("crypto");
const { pipeline } = require("stream");
const db = require("./database");

// ============================================================
// CONFIG (override with environment variables)
// ============================================================
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const num = (k, d) => {
  const v = Number(env(k, d));
  return Number.isFinite(v) ? v : d;
};

const CONFIG = {
  port: num("PORT", 3456),
  apiKey: env("API_KEY", "PWPDUpYlq5GYmHheF2HEjGyybrrwhn9LfwmaiCdIeiU"),
  publicUrl: env("PUBLIC_URL", "https://bridge.topconsumerrank.com"),
  failureThreshold: num("FAILURE_THRESHOLD", 3),
  healthIntervalMs: num("HEALTH_INTERVAL_MS", 5000),
  healthProbeTimeoutMs: num("HEALTH_PROBE_TIMEOUT_MS", 5000),
  jsonTimeoutMs: num("UPSTREAM_TIMEOUT_MS", 120000), // response (headers + body) of a JSON call
  fileIdleTimeoutMs: num("FILE_IDLE_TIMEOUT_MS", 120000),
  maxAttempts: num("MAX_ATTEMPTS", 4),
  maxBodyBytes: num("MAX_BODY_MB", 256) * 1024 * 1024,
  // submit limiter: how many generate calls may be in flight to the backend / min gap between them
  limits: {
    video: { concurrency: num("VIDEO_SUBMIT_CONCURRENCY", 2), gapMs: num("VIDEO_SUBMIT_GAP_MS", 0), maxActive: num("VIDEO_MAX_ACTIVE", 0) },
    image: { concurrency: num("IMAGE_SUBMIT_CONCURRENCY", 4), gapMs: num("IMAGE_SUBMIT_GAP_MS", 0), maxActive: num("IMAGE_MAX_ACTIVE", 0) },
    other: { concurrency: num("OTHER_SUBMIT_CONCURRENCY", 8), gapMs: 0, maxActive: 0 },
  },
  clientQueueWaitMs: num("CLIENT_QUEUE_WAIT_MS", 80000), // direct (non-batch) callers sit behind Cloudflare's ~100s timeout
  clientBackendWaitMs: num("CLIENT_BACKEND_WAIT_MS", 60000),
  batchQueueWaitMs: num("BATCH_QUEUE_WAIT_MS", 6 * 3600 * 1000),
  batchBackendWaitMs: num("BATCH_BACKEND_WAIT_MS", 15 * 60 * 1000),
  batchMaxItems: num("BATCH_MAX_ITEMS", 500),
  queueMax: num("QUEUE_MAX", 5000),
  trackIntervalMs: num("TRACK_INTERVAL_MS", 20000), // background poll of open tasks nobody is polling
  trackMaxAgeMs: num("TRACK_MAX_AGE_MS", 3 * 3600 * 1000), // give up (abandoned) after this long
  trackConcurrency: num("TRACK_CONCURRENCY", 3),
  statusCacheMs: num("STATUS_CACHE_MS", 2000),
  minFreeDiskBytes: num("MIN_FREE_DISK_MB", 1024) * 1024 * 1024,
  traceGzipAfterDays: num("TRACE_GZIP_AFTER_DAYS", 1),
};

const LOG_DIR = db.LOG_DIR;
const TRACE_DIR = path.join(LOG_DIR, "trace");
const DASHBOARD_DIR = path.join(__dirname, "dashboard", "dist");

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(TRACE_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const newId = (prefix, bytes = 5) => `${prefix}${crypto.randomBytes(bytes).toString("hex")}`;

// ============================================================
// LOGGING: access/err text logs + structured trace (JSONL)
// ============================================================
function getLogDate() {
  return new Date().toISOString().slice(0, 10);
}

function writeLog(type, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(path.join(LOG_DIR, `${getLogDate()}.${type}.log`), line);
  } catch (e) {
    process.stderr.write(`log write failed: ${e.message}\n`);
  }
  if (type === "err") process.stderr.write(line);
  else process.stdout.write(line);
}

let traceBuf = [];
let traceTimer = null;

function trace(ev) {
  traceBuf.push(JSON.stringify({ ts: new Date().toISOString(), ...ev }) + "\n");
  if (!traceTimer) traceTimer = setTimeout(flushTrace, 200);
}

function flushTrace() {
  traceTimer = null;
  if (!traceBuf.length) return;
  const data = traceBuf.join("");
  traceBuf = [];
  fs.appendFile(path.join(TRACE_DIR, `${getLogDate()}.jsonl`), data, e => {
    if (e) process.stderr.write(`trace write failed: ${e.message}\n`);
  });
}

function flushTraceSync() {
  if (traceTimer) clearTimeout(traceTimer);
  traceTimer = null;
  if (!traceBuf.length) return;
  try {
    fs.appendFileSync(path.join(TRACE_DIR, `${getLogDate()}.jsonl`), traceBuf.join(""));
  } catch (e) { /* nothing else we can do */ }
  traceBuf = [];
}

const MAX_STR = 2000;
const SECRET_KEY = /^(x-)?api[-_]?key$|authorization|token|secret|password/i;

/** Shrink a JSON value for logging: long strings (base64 images...) are cut, secrets redacted. */
function clip(v, depth = 0) {
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, 200)}...[${v.length} chars]` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "[nested]";
  if (Array.isArray(v)) {
    const out = v.slice(0, 50).map(x => clip(x, depth + 1));
    if (v.length > 50) out.push(`...[${v.length} items]`);
    return out;
  }
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : clip(val, depth + 1);
  return out;
}

function clipText(s, max) {
  if (s == null) return null;
  s = String(s);
  return s.length > max ? `${s.slice(0, max)}...[${s.length} chars]` : s;
}

function safeDb(label, fn) {
  let p;
  try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
  return p.catch(e => {
    writeLog("err", `[DB ERROR] ${label}: ${e.message}`);
    trace({ ev: "db_error", label, error: e.message });
  });
}

// ============================================================
// BACKEND POOL, HEALTH CHECK & CIRCUIT BREAKER
// ============================================================
const DEFAULT_BACKENDS = [
  { id: "primary", name: "Local GPU Cluster (Primary)", url: "http://127.0.0.1:8765" },
  { id: "backup-1", name: "Failover Node 1 (Local Standby)", url: "http://127.0.0.1:8766" },
];
// Priority = order. The first backend that is "up" gets new work, so traffic returns to primary as soon as it recovers.
const BACKENDS = (env("BACKENDS_JSON", null) ? JSON.parse(env("BACKENDS_JSON")) : DEFAULT_BACKENDS).map(b => ({
  ...b,
  state: "up", // up | down
  active: false,
  status: "standby", // dashboard value: healthy | standby | error
  failures: 0, // consecutive
  totalRequests: 0,
  totalErrors: 0,
  lastError: null,
  lastSuccessAt: 0,
}));
// A backend that was never probed yet is assumed up; a standby that is not running is detected by the health loop.

const agent = new http.Agent({ keepAlive: false, maxSockets: 256 });
let backendsDirty = true;

function recomputeActive() {
  const first = BACKENDS.find(b => b.state === "up");
  for (const b of BACKENDS) {
    b.active = b === first;
    b.status = b.state === "down" ? "error" : b.active ? "healthy" : "standby";
  }
  backendsDirty = true;
}

function failoverEvent(msg) {
  writeLog("access", `[CIRCUIT BREAKER] ${msg}`);
  trace({ ev: "backend_state", msg });
  safeDb("addFailoverLog", () => db.addFailoverLog(msg));
}

function markFailure(backend, reason) {
  backend.failures++;
  backend.totalErrors++;
  backend.lastError = reason;
  backendsDirty = true;
  if (backend.state === "up" || backend.failures <= CONFIG.failureThreshold || backend.failures % 60 === 0) {
    writeLog("err", `[BACKEND FAILURE] ${backend.url} (${backend.failures}/${CONFIG.failureThreshold}): ${reason}`);
  }
  if (backend.state === "up" && backend.failures >= CONFIG.failureThreshold) {
    backend.state = "down";
    recomputeActive();
    const next = BACKENDS.find(b => b.state === "up");
    failoverEvent(`CIRCUIT BREAKER TRIPPED: ${backend.name} down after ${backend.failures} consecutive failures (${reason}). ` +
      (next ? `Routing new work to ${next.name}.` : "NO healthy backend left - requests will be queued/retried."));
  }
}

function markSuccess(backend) {
  backend.lastSuccessAt = Date.now();
  if (backend.failures > 0 || backend.state === "down") {
    const wasDown = backend.state === "down";
    backend.failures = 0;
    backend.lastError = null;
    if (wasDown) {
      backend.state = "up";
      recomputeActive();
      failoverEvent(`Auto-recovery: ${backend.name} is responding again.`);
    }
    backendsDirty = true;
  }
}

/** Any HTTP answer means the process is alive (the backend has no dedicated health route). */
function probeBackend(backend) {
  return new Promise(resolve => {
    const u = new URL("/", backend.url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: "/", method: "GET", agent, timeout: CONFIG.healthProbeTimeoutMs, headers: { "X-API-Key": CONFIG.apiKey } },
      res => { res.resume(); res.on("end", () => resolve(null)); res.on("error", () => resolve(null)); }
    );
    req.on("timeout", () => req.destroy(new Error("probe timeout")));
    req.on("error", e => resolve(e.code || e.message));
    req.end();
  });
}

async function healthLoop() {
  for (const b of BACKENDS) {
    // A busy-but-alive backend answers real requests; only probe when idle or when it is marked down.
    if (b.state === "up" && Date.now() - b.lastSuccessAt < 30000) continue;
    const err = await probeBackend(b);
    if (err) {
      markFailure(b, `health probe: ${err}`);
    } else {
      markSuccess(b);
    }
  }
  if (backendsDirty) {
    backendsDirty = false;
    safeDb("saveBackends", () => db.saveBackends(BACKENDS));
  }
}

function pickBackend(preferredId) {
  if (preferredId) {
    const p = BACKENDS.find(b => b.id === preferredId && b.state === "up");
    if (p) return p;
  }
  return BACKENDS.find(b => b.state === "up") || null;
}

// ============================================================
// UPSTREAM CALLS (timeouts, retry policy)
// ============================================================
function bridgeError(code, status, detail, extra = {}) {
  const e = new Error(detail);
  e.bridge = true;
  e.code = code;
  e.httpStatus = status;
  e.detail = detail;
  Object.assign(e, extra);
  return e;
}

const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);

function callOnce(backend, o) {
  return new Promise((resolve, reject) => {
    const target = new URL(o.url, backend.url);
    const headers = { ...o.headers, host: target.host, "X-API-Key": CONFIG.apiKey };
    delete headers["content-length"];
    delete headers["accept-encoding"]; // we rewrite JSON bodies, so keep them uncompressed
    if (o.body && o.body.length) headers["content-length"] = o.body.length;

    let connected = false;
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      e.phase = e.phase || (connected ? "response" : "connect");
      reject(e);
    };

    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: o.method, headers, agent },
      res => {
        if (settled) return res.destroy();
        clearTimeout(timer);
        if (o.stream) {
          settled = true;
          res.setTimeout(CONFIG.fileIdleTimeoutMs, () => res.destroy(new Error("upstream idle timeout")));
          return resolve({ status: res.statusCode, headers: res.headers, proxyRes: res });
        }
        const chunks = [];
        const bodyTimer = setTimeout(() => res.destroy(Object.assign(new Error(`upstream body timeout after ${o.timeoutMs}ms`), { code: "ETIMEDOUT" })), o.timeoutMs);
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          clearTimeout(bodyTimer);
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", e => { clearTimeout(bodyTimer); settled = false; fail(e); });
        res.on("close", () => {
          clearTimeout(bodyTimer);
          if (!res.complete && !settled) fail(Object.assign(new Error("upstream closed connection mid-response"), { code: "ECONNRESET" }));
        });
      }
    );
    const timer = setTimeout(
      () => req.destroy(Object.assign(new Error(`no response from backend within ${o.timeoutMs}ms`), { code: "ETIMEDOUT" })),
      o.timeoutMs
    );
    req.on("socket", s => {
      if (s.connecting) s.once("connect", () => { connected = true; });
      else connected = true;
    });
    req.on("error", fail);
    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}

const backoff = (attempt) => Math.min(500 * Math.pow(3, attempt - 1), 5000);

/**
 * Send a request to the pool, retrying only when it is safe:
 *  - GET/HEAD: on connection errors, timeouts and 502/503/504
 *  - POST: only when the request provably never reached the backend (connection refused/not established)
 * If no backend is up the call waits (up to waitMs) for recovery instead of failing immediately.
 */
async function dispatch(ctx, o) {
  const idempotent = ["GET", "HEAD", "OPTIONS"].includes(o.method);
  const deadline = Date.now() + (o.waitMs || 0);
  let attempt = 0;
  let lastErr = null;

  for (;;) {
    const strictId = o.strictId && BACKENDS.some(b => b.id === o.strictId) ? o.strictId : null;
    let backend = strictId ? BACKENDS.find(b => b.id === strictId && b.state === "up") : pickBackend(o.preferredId);
    if (!backend) {
      if (Date.now() < deadline) { await sleep(500); continue; }
      attempt++;
      if (attempt < CONFIG.maxAttempts) { await sleep(backoff(attempt)); continue; }
      throw bridgeError(
        strictId ? "owner_backend_down" : "all_backends_unavailable", 503,
        strictId ? `Backend ${strictId} that owns this task is down` : "No healthy backend available",
        { attempts: attempt, retryable: true, lastError: lastErr && lastErr.message }
      );
    }

    attempt++;
    backend.totalRequests++;
    const t0 = Date.now();
    try {
      const r = await callOnce(backend, o);
      const ms = Date.now() - t0;
      trace({ ev: "upstream", rid: ctx.rid, attempt, backend: backend.id, method: o.method, url: o.url, status: r.status, ms });
      if ([502, 503, 504].includes(r.status)) {
        markFailure(backend, `HTTP ${r.status}`);
        if (idempotent && attempt < CONFIG.maxAttempts) { await sleep(backoff(attempt)); continue; }
      } else {
        markSuccess(backend);
      }
      return { ...r, backend, attempts: attempt };
    } catch (e) {
      const ms = Date.now() - t0;
      lastErr = e;
      trace({ ev: "upstream", rid: ctx.rid, attempt, backend: backend.id, method: o.method, url: o.url, error: e.code || e.message, phase: e.phase, ms });
      markFailure(backend, e.code || e.message);
      const safe = idempotent || NEVER_SENT.has(e.code) || e.phase === "connect";
      if (safe && attempt < CONFIG.maxAttempts) { await sleep(backoff(attempt)); continue; }
      throw bridgeError(
        safe ? "upstream_unreachable" : "upstream_failed", 502,
        `${e.code || ""} ${e.message}`.trim(),
        {
          attempts: attempt,
          retryable: safe,
          // Not retried automatically: the backend may already have started this job
          mayHaveBeenProcessed: !safe,
          backendId: backend.id,
        }
      );
    }
  }
}

// ============================================================
// SUBMIT GATE (queue + concurrency + pacing per task type)
// ============================================================
const openTasks = new Map(); // task_id -> task (non-terminal)
const openCount = (type) => { let n = 0; for (const t of openTasks.values()) if (t.type === type) n++; return n; };

class Gate {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.queue = [];
    this.running = 0;
    this.lastStart = 0;
    this.timer = null;
  }

  enqueue(fn, { maxWaitMs, isAborted } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject, isAborted, maxWaitMs: maxWaitMs || CONFIG.clientQueueWaitMs, enqueuedAt: Date.now() });
      this.pump();
    });
  }

  later(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, ms);
  }

  pump() {
    while (this.queue.length && this.running < this.cfg.concurrency) {
      const now = Date.now();
      const item = this.queue[0];
      if (item.isAborted && item.isAborted()) { this.queue.shift(); item.reject(bridgeError("client_aborted", 499, "client disconnected while queued")); continue; }
      if (now - item.enqueuedAt > item.maxWaitMs) {
        this.queue.shift();
        item.reject(bridgeError("queue_timeout", 503, `Waited ${Math.round((now - item.enqueuedAt) / 1000)}s in the ${this.name} queue`, { retryable: true }));
        continue;
      }
      const wait = this.lastStart + this.cfg.gapMs - now;
      if (wait > 0) return this.later(wait);
      if (this.cfg.maxActive > 0 && openCount(this.name) >= this.cfg.maxActive) return this.later(1000);

      this.queue.shift();
      this.running++;
      this.lastStart = now;
      Promise.resolve()
        .then(item.fn)
        .then(item.resolve, item.reject)
        .finally(() => { this.running--; this.pump(); });
    }
    // Waiting items must still expire even when every slot is busy
    if (this.queue.length) this.later(2000);
  }

  stats() { return { queued: this.queue.length, running: this.running, ...this.cfg, openTasks: openCount(this.name) }; }
}

const gates = {
  video: new Gate("video", CONFIG.limits.video),
  image: new Gate("image", CONFIG.limits.image),
  other: new Gate("other", CONFIG.limits.other),
};
const totalQueued = () => Object.values(gates).reduce((n, g) => n + g.queue.length, 0);

// ============================================================
// TASK TRACKING
// ============================================================
const TERMINAL = new Set(["completed", "failed", "cancelled", "canceled", "error", "lost", "abandoned"]);
const finalized = new Set(); // recently finished task ids (avoid repeated DB writes for re-polls)
const lastErrRecorded = new Map(); // task_id -> ts of last 404/5xx row recorded
const statusCache = new Map();

function rememberFinal(id) {
  finalized.add(id);
  if (finalized.size > 5000) finalized.delete(finalized.values().next().value);
}

function extractError(respJson, bodyStr) {
  if (respJson && typeof respJson === "object") {
    for (const k of ["error", "message", "detail", "reason", "error_message", "failure_reason"]) {
      const v = respJson[k];
      if (v) return clipText(typeof v === "string" ? v : JSON.stringify(v), 2000);
    }
  }
  return bodyStr ? clipText(bodyStr, 500) : null;
}

function registerTask(info) {
  const t = {
    taskId: info.taskId, type: info.type, account: info.account, model: info.model, prompt: info.prompt,
    backendId: info.backendId, submittedAt: Date.now(), lastPollAt: 0, status: info.status || "pending",
    batchId: info.batchId || null, batchIndex: info.batchIndex ?? null, requestId: info.requestId,
    lastDbWrite: Date.now(), polls: 0, tracking: false,
  };
  openTasks.set(t.taskId, t);
  finalized.delete(t.taskId);
  safeDb("insertTask", () => db.insertTask({ ...t, requestJson: info.requestJson, status: t.status }));
  trace({ ev: "task_submit", rid: info.requestId, task_id: t.taskId, type: t.type, backend: t.backendId, batch_id: t.batchId, batch_index: t.batchIndex, model: t.model });
  return t;
}

/** Feed every status answer (client poll or background tracker) through here. */
function onStatusResult(taskId, result, respJson, bodyStr, ctx) {
  const now = Date.now();
  const rewritten = bodyStr == null ? null : bodyStr.replaceAll(result.backend.url, CONFIG.publicUrl);
  let task = openTasks.get(taskId);

  if (finalized.has(taskId) && !task) return; // already recorded, nothing new to learn

  const httpStatus = result.status;
  let status = null;
  if (httpStatus === 404) status = "lost";
  else if (httpStatus < 400 && respJson && typeof respJson.status === "string") status = respJson.status.toLowerCase();

  // 404 is only proof the task is gone when it comes from the backend that owns it
  if (status === "lost" && task && task.backendId && task.backendId !== result.backend.id) status = null;

  if (!task) {
    if (!status || status === "lost") {
      // Unknown task id: record the miss once in a while so it is visible, but never create a task for it
      if (httpStatus >= 400 && now - (lastErrRecorded.get(taskId) || 0) > 600000) {
        lastErrRecorded.set(taskId, now);
        if (lastErrRecorded.size > 5000) lastErrRecorded.delete(lastErrRecorded.keys().next().value);
        recordRequest({ ctx, taskId, type: "status", status: httpStatus, finalStatus: "failed", error: extractError(respJson, bodyStr) || "task not found", body: bodyStr, result, prompt: `Check status for ${taskId}` });
      }
      return;
    }
    // Task submitted before this bridge process started (or by someone else): adopt it
    task = registerTask({
      taskId, type: respJson.type || "other", account: ctx.account, model: respJson.model || "default_model",
      prompt: clipText(respJson.prompt, 4000) || `Task ${taskId}`, backendId: result.backend.id, requestId: ctx.rid,
      requestJson: JSON.stringify({ adopted: true }), status,
    });
    task.submittedAt = now;
  }

  task.polls++;
  task.lastPollAt = now;

  if (!status) {
    // 5xx or unparsable answer: not a verdict about the task. Keep it in the trace only.
    return;
  }

  const terminal = TERMINAL.has(status);
  const changed = status !== task.status;
  task.status = status;

  if (!terminal) {
    if (changed || now - task.lastDbWrite > 60000) {
      task.lastDbWrite = now;
      safeDb("updateTask", () => db.updateTask(taskId, { status, lastPollAt: now, pollCount: task.polls, lastBody: clipText(rewritten, 8000) }));
    }
    return;
  }

  // ---- terminal: persist everything needed to trace the failure ----
  const error = status === "completed" ? null
    : status === "lost" ? `Backend ${result.backend.id} has no record of this task (404). It was probably restarted and lost its in-memory tasks. ${extractError(respJson, bodyStr) || ""}`.trim()
    : extractError(respJson, bodyStr) || `task ended with status "${status}"`;
  openTasks.delete(taskId);
  rememberFinal(taskId);
  safeDb("finishTask", () => db.updateTask(taskId, { status, error, lastBody: clipText(rewritten, 8000), finishedAt: now, lastPollAt: now, pollCount: task.polls }));
  recordRequest({
    ctx, taskId, type: task.type, status: httpStatus, finalStatus: status === "completed" ? "completed" : "failed",
    error, body: bodyStr, result, prompt: task.prompt, model: task.model, account: task.account,
    latency: now - task.submittedAt, detailStatus: status,
  });
  trace({ ev: "task_final", rid: ctx.rid, task_id: taskId, type: task.type, status, error, backend: result.backend.id, ms: now - task.submittedAt, polls: task.polls, batch_id: task.batchId, body: clipText(bodyStr, 16000) });
  if (gates[task.type]) gates[task.type].pump();
}

function recordRequest({ ctx, taskId, type, status, finalStatus, error, body, result, prompt, model, account, latency, params, detailStatus }) {
  const failed = finalStatus === "failed";
  safeDb("insertRequest", () => db.insertRequest({
    taskId: taskId || "n/a",
    timestamp: new Date().toISOString(),
    account: account || ctx.account,
    type,
    model: model || ctx.model || "default_model",
    prompt: prompt || ctx.prompt || ctx.url,
    statusCode: status,
    finalStatus,
    latency: latency ?? (Date.now() - ctx.startedAt),
    targetBackend: result && result.backend ? `${result.backend.name} (${result.backend.url})` : "none",
    backendId: result && result.backend ? result.backend.id : null,
    attempts: result ? result.attempts : ctx.attempts,
    requestId: ctx.rid,
    method: ctx.method,
    url: ctx.url,
    error: error || null,
    responseBody: failed ? clipText(body, 16000) : clipText(body, 2000),
    params: params || (detailStatus ? { status: detailStatus } : {}),
    created_at: Date.now(),
  }));
}

// ---- Background tracker: polls tasks that no client is polling, so every outcome gets recorded ----
let trackerBusy = false;
async function trackerTick() {
  if (trackerBusy) return;
  trackerBusy = true;
  try {
    const now = Date.now();
    const due = [];
    for (const t of openTasks.values()) {
      if (t.tracking) continue;
      if (now - t.submittedAt > CONFIG.trackMaxAgeMs) {
        openTasks.delete(t.taskId);
        rememberFinal(t.taskId);
        const error = `No terminal status within ${Math.round(CONFIG.trackMaxAgeMs / 60000)} minutes (last status "${t.status}")`;
        safeDb("abandonTask", () => db.updateTask(t.taskId, { status: "abandoned", error, finishedAt: now }));
        recordRequest({ ctx: { rid: newId("trk_"), startedAt: now, method: "GET", url: `/api/status/${t.taskId}`, account: t.account }, taskId: t.taskId, type: t.type, status: 0, finalStatus: "failed", error, prompt: t.prompt, model: t.model, account: t.account, latency: now - t.submittedAt, detailStatus: "abandoned" });
        trace({ ev: "task_final", task_id: t.taskId, status: "abandoned", error, type: t.type });
        continue;
      }
      if (now - (t.lastPollAt || t.submittedAt) < CONFIG.trackIntervalMs) continue;
      const owner = BACKENDS.find(b => b.id === t.backendId);
      if (owner && owner.state === "down") continue;
      due.push(t);
    }
    for (let i = 0; i < due.length; i += CONFIG.trackConcurrency) {
      await Promise.all(due.slice(i, i + CONFIG.trackConcurrency).map(trackOne));
    }
  } catch (e) {
    writeLog("err", `[TRACKER] ${e.message}`);
  } finally {
    trackerBusy = false;
  }
}

async function trackOne(t) {
  t.tracking = true;
  t.lastPollAt = Date.now();
  const ctx = { rid: newId("trk_"), startedAt: Date.now(), method: "GET", url: `/api/status/${t.taskId}`, account: t.account };
  try {
    const r = await dispatch(ctx, { method: "GET", url: ctx.url, headers: {}, strictId: t.backendId, timeoutMs: CONFIG.jsonTimeoutMs });
    const bodyStr = r.body.toString("utf-8");
    let respJson = null;
    try { respJson = JSON.parse(bodyStr); } catch (e) { /* not json */ }
    trace({ ev: "track_poll", task_id: t.taskId, status: respJson && respJson.status, http: r.status });
    onStatusResult(t.taskId, r, respJson, bodyStr, ctx);
  } catch (e) {
    trace({ ev: "track_poll", task_id: t.taskId, error: e.message });
  } finally {
    t.tracking = false;
  }
}

// ============================================================
// HELPERS
// ============================================================
function extractAccount(req, bodyJson) {
  return (
    req.headers["x-account-id"] ||
    req.headers["x-user-id"] ||
    (bodyJson && (bodyJson.account_id || bodyJson.account || bodyJson.user)) ||
    req.headers["cf-connecting-ip"] ||
    req.headers["x-forwarded-for"] ||
    "acc_topconsumer_prod"
  );
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s), ...extraHeaders });
  res.end(s);
}

function sendBridgeError(res, rid, e) {
  const status = e.httpStatus || 502;
  const headers = status === 503 ? { "Retry-After": "5" } : {};
  sendJson(res, status, {
    error: e.code || "bridge_error",
    detail: e.detail || e.message,
    request_id: rid,
    attempts: e.attempts,
    retryable: Boolean(e.retryable),
    ...(e.mayHaveBeenProcessed ? { may_have_been_processed: true, note: "The backend may already be working on this request; check your task list before re-sending." } : {}),
  }, headers);
}

const MIME_TYPES = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("File not found");
  }
  res.writeHead(200, { "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > CONFIG.maxBodyBytes) { reject(bridgeError("payload_too_large", 413, `Body exceeds ${CONFIG.maxBodyBytes} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
    req.on("aborted", () => reject(bridgeError("client_aborted", 499, "client aborted upload")));
  });
}

function classify(req) {
  const u = req.url.split("?")[0];
  let m;
  if (req.method === "GET" && (m = u.match(/^\/api\/status\/([^/]+)$/))) return { kind: "status", taskId: decodeURIComponent(m[1]), type: "status" };
  if (req.method === "GET" && u.startsWith("/api/files/")) return { kind: "file", type: "file" };
  const type = u.includes("/video/") ? "video" : u.includes("/image/") ? "image" : "other";
  if (req.method === "POST") return { kind: "submit", type };
  return { kind: "other", type };
}

/** Forward the backend response to the client (JSON bodies get internal URLs rewritten to the public domain). */
function relay(res, ctx, r, bodyStr) {
  const headers = { ...r.headers };
  delete headers["transfer-encoding"];
  delete headers["connection"];
  delete headers["content-length"];
  headers["content-length"] = Buffer.byteLength(bodyStr);
  headers["x-request-id"] = ctx.rid;
  headers["x-bridge-backend"] = r.backend.id;
  headers["x-bridge-attempts"] = String(r.attempts);
  res.writeHead(r.status, headers);
  res.end(bodyStr);
}

function accessLine(ctx, r, extra = "") {
  writeLog("access", `${ctx.method} ${ctx.url} <- ${r.status} (${Date.now() - ctx.startedAt}ms) [${ctx.rid}${r.attempts > 1 ? ` attempts=${r.attempts}` : ""}]${extra}`);
}

// ============================================================
// REQUEST HANDLERS
// ============================================================
async function handleFile(req, res, ctx) {
  const r = await dispatch(ctx, { method: "GET", url: req.url, headers: req.headers, stream: true, timeoutMs: CONFIG.jsonTimeoutMs });
  const headers = { ...r.headers, "x-request-id": ctx.rid, "x-bridge-backend": r.backend.id };
  delete headers.connection;
  res.writeHead(r.status, headers);
  req.on("close", () => { if (!res.writableEnded) r.proxyRes.destroy(); });
  r.proxyRes.on("error", e => { writeLog("err", `[${ctx.rid}] file stream error: ${e.message}`); res.destroy(); });
  r.proxyRes.pipe(res);
  writeLog("access", `${ctx.method} ${ctx.url} <- ${r.status} (binary) [${ctx.rid}${r.attempts > 1 ? ` attempts=${r.attempts}` : ""}]`);
  trace({ ev: "client", rid: ctx.rid, method: ctx.method, url: ctx.url, status: r.status, backend: r.backend.id, attempts: r.attempts, ms: Date.now() - ctx.startedAt, binary: true });
  if (r.status >= 400) {
    recordRequest({ ctx, taskId: "n/a", type: "file", status: r.status, finalStatus: "failed", error: `file request failed with HTTP ${r.status}`, result: r, prompt: `Download ${req.url}` });
  }
}

async function handleStatus(req, res, ctx, route) {
  const id = route.taskId;
  const now = Date.now();
  const cached = statusCache.get(id);
  if (cached && now - cached.ts < (cached.terminal ? 60000 : CONFIG.statusCacheMs)) {
    const headers = { ...cached.headers, "x-request-id": ctx.rid, "x-bridge-cache": "hit", "content-length": Buffer.byteLength(cached.bodyStr) };
    res.writeHead(cached.status, headers);
    res.end(cached.bodyStr);
    writeLog("access", `${ctx.method} ${ctx.url} <- ${cached.status} (cache) [${ctx.rid}]`);
    return;
  }

  let owner = openTasks.get(id);
  let ownerId = owner ? owner.backendId : null;
  if (!ownerId) {
    const row = await db.getTask(id).catch(() => null);
    ownerId = row ? row.backend_id : null;
  }

  const r = await dispatch(ctx, { method: "GET", url: req.url, headers: req.headers, strictId: ownerId || undefined, timeoutMs: CONFIG.jsonTimeoutMs });
  const bodyStr = r.body.toString("utf-8");
  let respJson = null;
  try { respJson = JSON.parse(bodyStr); } catch (e) { /* not json */ }

  onStatusResult(id, r, respJson, bodyStr, ctx);
  const out = bodyStr.replaceAll(r.backend.url, CONFIG.publicUrl);
  relay(res, ctx, r, out);
  accessLine(ctx, r);

  const st = respJson && typeof respJson.status === "string" ? respJson.status.toLowerCase() : null;
  const polling = r.status < 400 && st && !TERMINAL.has(st);
  trace({
    ev: "client", rid: ctx.rid, method: ctx.method, url: ctx.url, status: r.status, backend: r.backend.id, attempts: r.attempts, ms: Date.now() - ctx.startedAt,
    task_id: id, task_status: st, resp: polling ? undefined : clipText(bodyStr, 16000),
  });

  if (r.status === 200 && st) {
    statusCache.set(id, { ts: Date.now(), status: r.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, bodyStr: out, terminal: TERMINAL.has(st) });
    if (statusCache.size > 2000) statusCache.delete(statusCache.keys().next().value);
  }
}

async function handleSubmitOrOther(req, res, ctx, route, bodyBuffer, bodyJson, aborted) {
  const type = route.type;
  const run = () => dispatch(ctx, { method: req.method, url: req.url, headers: req.headers, body: bodyBuffer, timeoutMs: CONFIG.jsonTimeoutMs, waitMs: CONFIG.clientBackendWaitMs });
  let r;
  if (route.kind === "submit") {
    const gate = gates[type] || gates.other;
    if (totalQueued() >= CONFIG.queueMax) throw bridgeError("queue_full", 429, `Submit queue is full (${CONFIG.queueMax})`, { retryable: true });
    const qt = Date.now();
    r = await gate.enqueue(run, { maxWaitMs: CONFIG.clientQueueWaitMs, isAborted: aborted });
    ctx.queuedMs = Date.now() - qt;
  } else {
    r = await run();
  }

  const bodyStr = r.body.toString("utf-8");
  let respJson = null;
  try { respJson = JSON.parse(bodyStr); } catch (e) { /* not json */ }
  const out = bodyStr.replaceAll(r.backend.url, CONFIG.publicUrl);
  relay(res, ctx, r, out);
  accessLine(ctx, r, ctx.queuedMs > 1000 ? ` queued=${ctx.queuedMs}ms` : "");

  const ok = r.status < 400;
  const taskId = respJson && respJson.task_id ? String(respJson.task_id) : null;
  if (ok && taskId && route.kind === "submit") {
    registerTask({
      taskId, type, account: ctx.account, model: ctx.model, prompt: ctx.prompt, backendId: r.backend.id, requestId: ctx.rid,
      requestJson: JSON.stringify(clip(bodyJson || {})), status: (respJson.status || "pending").toLowerCase(),
    });
  }
  recordRequest({
    ctx, taskId, type, status: r.status, finalStatus: !ok ? "failed" : r.status === 202 || (respJson && ["pending", "running", "queued"].includes(respJson.status)) ? "pending" : "completed",
    error: ok ? null : extractError(respJson, bodyStr), body: bodyStr, result: r, params: clip(bodyJson || {}),
  });
  trace({
    ev: "client", rid: ctx.rid, method: ctx.method, url: ctx.url, status: r.status, backend: r.backend.id, attempts: r.attempts, ms: Date.now() - ctx.startedAt,
    queued_ms: ctx.queuedMs, account: ctx.account, task_id: taskId, req: clip(bodyJson), resp: clipText(bodyStr, ok ? 2000 : 16000),
  });
}

async function handleApi(req, res, ctx) {
  const route = classify(req);
  if (route.kind === "file") return handleFile(req, res, ctx);
  if (route.kind === "status") {
    ctx.account = extractAccount(req, null);
    ctx.prompt = `Check status for ${route.taskId}`;
    return handleStatus(req, res, ctx, route);
  }

  let aborted = false;
  res.on("close", () => { if (!res.writableEnded) aborted = true; });
  const bodyBuffer = await readBody(req);
  let bodyJson = null;
  try { if (bodyBuffer.length > 0) bodyJson = JSON.parse(bodyBuffer.toString("utf-8")); } catch (e) { /* not json */ }

  ctx.account = extractAccount(req, bodyJson);
  ctx.model = (bodyJson && bodyJson.model) || "default_model";
  ctx.prompt = clipText(bodyJson && bodyJson.prompt, 4000) || req.url;

  // /api/batch/<video|image>/generate : many requests in one call, processed through the limiter
  const bm = req.url.split("?")[0].match(/^\/api\/batch\/(video|image)\/generate$/);
  if (bm && req.method === "POST") return handleBatchSubmit(req, res, ctx, bm[1], bodyJson);

  return handleSubmitOrOther(req, res, ctx, route, bodyBuffer, bodyJson, () => aborted);
}

// ============================================================
// BATCH API
// ============================================================
async function handleBatchSubmit(req, res, ctx, type, body) {
  const items = body && body.requests;
  if (!Array.isArray(items) || items.length === 0) throw bridgeError("bad_request", 400, 'Body must be {"requests":[{...},{...}], "defaults":{...}}');
  if (items.length > CONFIG.batchMaxItems) throw bridgeError("bad_request", 400, `Max ${CONFIG.batchMaxItems} items per batch, got ${items.length}`);
  if (items.some(i => !i || typeof i !== "object" || Array.isArray(i))) throw bridgeError("bad_request", 400, "Every item of requests must be a JSON object");
  if (totalQueued() + items.length > CONFIG.queueMax) throw bridgeError("queue_full", 429, `Submit queue would exceed ${CONFIG.queueMax}`, { retryable: true });

  const defaults = body.defaults && typeof body.defaults === "object" ? body.defaults : {};
  const batchId = newId("b_");
  const itemRids = items.map(() => newId("req_"));
  await db.createBatch({ batchId, type, account: ctx.account, total: items.length, requestIds: itemRids });
  trace({ ev: "batch_create", rid: ctx.rid, batch_id: batchId, type, total: items.length, account: ctx.account, defaults: clip(defaults) });
  writeLog("access", `[BATCH] ${batchId} created: ${items.length} ${type} requests [${ctx.rid}]`);

  sendJson(res, 202, {
    batch_id: batchId, type, total: items.length, status: "queued",
    status_url: `/api/batch/${batchId}`,
    message: "Batch accepted. Items are submitted in the background respecting the concurrency limit. Poll status_url.",
  }, { "X-Request-Id": ctx.rid });

  const gate = gates[type];
  items.forEach((item, index) => {
    processBatchItem({ batchId, index, type, rid: itemRids[index], body: { ...defaults, ...item }, account: ctx.account, gate });
  });
}

async function processBatchItem({ batchId, index, type, rid, body, account, gate }) {
  const url = `/api/${type}/generate`;
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  const ictx = {
    rid, method: "POST", url, startedAt: Date.now(), account,
    model: body.model || "default_model", prompt: clipText(body.prompt, 4000) || url,
  };
  const headers = { "content-type": "application/json", "x-account-id": String(account) };
  try {
    const r = await gate.enqueue(
      () => dispatch(ictx, { method: "POST", url, headers, body: bodyBuffer, timeoutMs: CONFIG.jsonTimeoutMs, waitMs: CONFIG.batchBackendWaitMs }),
      { maxWaitMs: CONFIG.batchQueueWaitMs }
    );
    const bodyStr = r.body.toString("utf-8");
    let respJson = null;
    try { respJson = JSON.parse(bodyStr); } catch (e) { /* not json */ }
    const ok = r.status < 400 && respJson && respJson.task_id;
    const taskId = respJson && respJson.task_id ? String(respJson.task_id) : null;

    if (ok) {
      registerTask({
        taskId, type, account, model: ictx.model, prompt: ictx.prompt, backendId: r.backend.id, requestId: rid,
        requestJson: JSON.stringify(clip(body)), status: (respJson.status || "pending").toLowerCase(), batchId, batchIndex: index,
      });
    }
    const error = ok ? null : extractError(respJson, bodyStr) || `HTTP ${r.status}`;
    await safeDb("updateBatchItem", () => db.updateBatchItem(batchId, index, { taskId, state: ok ? "submitted" : "submit_failed", error, requestId: rid }));
    recordRequest({ ctx: ictx, taskId, type, status: r.status, finalStatus: ok ? "pending" : "failed", error, body: bodyStr, result: r, params: clip(body) });
    writeLog("access", `[BATCH] ${batchId}#${index} POST ${url} <- ${r.status} task=${taskId || "-"} (${Date.now() - ictx.startedAt}ms) [${rid}${r.attempts > 1 ? ` attempts=${r.attempts}` : ""}]${ok ? "" : ` ERROR: ${error}`}`);
    trace({ ev: "batch_item", rid, batch_id: batchId, index, ok: Boolean(ok), task_id: taskId, status: r.status, attempts: r.attempts, backend: r.backend.id, ms: Date.now() - ictx.startedAt, req: clip(body), resp: clipText(bodyStr, ok ? 1000 : 16000) });
  } catch (e) {
    const error = `${e.code || "error"}: ${e.detail || e.message}`;
    await safeDb("updateBatchItem", () => db.updateBatchItem(batchId, index, { state: "submit_failed", error, requestId: rid }));
    recordRequest({ ctx: ictx, taskId: null, type, status: e.httpStatus || 502, finalStatus: "failed", error, result: null, params: clip(body) });
    writeLog("err", `[BATCH] ${batchId}#${index} submit failed: ${error} [${rid}]`);
    trace({ ev: "batch_item", rid, batch_id: batchId, index, ok: false, error, mayHaveBeenProcessed: Boolean(e.mayHaveBeenProcessed), req: clip(body) });
  }
}

async function handleBatchStatus(req, res, ctx, batchId, query) {
  const data = await db.getBatch(batchId);
  if (!data) return sendJson(res, 404, { error: "batch_not_found", batch_id: batchId, request_id: ctx.rid });
  const counts = {};
  let pendingWork = 0;
  const items = data.items.map(i => {
    let state;
    if (i.submit_state === "queued") state = "queued";
    else if (i.submit_state === "submit_failed") state = "submit_failed";
    else state = i.status || "pending";
    counts[state] = (counts[state] || 0) + 1;
    if (!TERMINAL.has(state) && state !== "submit_failed") pendingWork++;

    let result;
    if (state === "completed" && i.last_body) { try { result = JSON.parse(i.last_body); } catch (e) { result = undefined; } }
    return {
      index: i.idx, task_id: i.task_id, state, request_id: i.request_id,
      error: i.submit_error || i.error || undefined,
      finished_at: i.finished_at ? new Date(i.finished_at).toISOString() : undefined,
      result,
    };
  });
  const only = query.get("only");
  const compact = query.get("compact") === "1";
  const shown = items
    .filter(i => !only || only === i.state || (only === "failed" && ["failed", "lost", "abandoned", "error", "submit_failed"].includes(i.state)))
    .map(i => (compact ? { ...i, result: undefined } : i));
  sendJson(res, 200, {
    batch_id: batchId, type: data.batch.type, total: data.batch.total,
    created_at: new Date(data.batch.created_at).toISOString(),
    done: pendingWork === 0, counts, items: shown,
  }, { "X-Request-Id": ctx.rid });
}

// ============================================================
// ADMIN: telemetry, tasks, trace
// ============================================================
async function searchTrace(needle, fromMs, maxLines = 1000) {
  const fromDate = new Date(fromMs).toISOString().slice(0, 10);
  const files = fs.readdirSync(TRACE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl(\.gz)?$/.test(f) && f.slice(0, 10) >= fromDate).sort();
  const out = [];
  for (const f of files) {
    const input = fs.createReadStream(path.join(TRACE_DIR, f));
    const stream = f.endsWith(".gz") ? input.pipe(zlib.createGunzip()) : input;
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.includes(needle)) {
          try { out.push(JSON.parse(line)); } catch (e) { out.push({ raw: line }); }
          if (out.length >= maxLines) { rl.close(); input.destroy(); return out; }
        }
      }
    } catch (e) {
      out.push({ ev: "trace_read_error", file: f, error: e.message });
    }
  }
  return out;
}

async function handleAdmin(req, res, ctx, urlObj) {
  const p = urlObj.pathname;
  const q = urlObj.searchParams;

  if (p === "/api/admin/telemetry") {
    const data = await db.getTelemetryData(q.get("timeline") || "24h", q.get("account") || "all", q.get("type") || "all");
    data.live = healthSnapshot();
    return sendJson(res, 200, data);
  }
  if (p === "/api/admin/health") return sendJson(res, 200, healthSnapshot());
  if (p === "/api/admin/tasks") {
    const rows = await db.listTasks({ status: q.get("status"), batchId: q.get("batch_id"), type: q.get("type"), since: q.get("since"), limit: q.get("limit") });
    return sendJson(res, 200, { count: rows.length, tasks: rows });
  }
  if (p === "/api/admin/trace") {
    const taskId = q.get("task_id");
    const requestId = q.get("request_id");
    const batchId = q.get("batch_id");
    const needle = taskId || requestId || batchId;
    if (!needle) return sendJson(res, 400, { error: "pass task_id, request_id or batch_id" });
    const task = taskId ? await db.getTask(taskId) : null;
    const requests = taskId ? await db.getRequestsByKey("task_id", taskId) : requestId ? await db.getRequestsByKey("request_id", requestId) : [];
    const batch = batchId ? await db.getBatch(batchId) : null;
    const from = task ? task.submitted_at - 60000 : batch ? batch.batch.created_at - 60000 : Date.now() - 3 * 86400 * 1000;
    const lines = await searchTrace(needle, from);
    return sendJson(res, 200, { task, requests, batch, trace: lines });
  }
  return sendJson(res, 404, { error: "unknown admin endpoint", endpoints: ["telemetry", "health", "tasks", "trace"] });
}

function healthSnapshot() {
  const active = BACKENDS.find(b => b.active) || null;
  return {
    status: active ? "ok" : "degraded",
    activeBackend: active ? active.url : null,
    backends: BACKENDS.map(b => ({ id: b.id, url: b.url, state: b.state, active: b.active, failures: b.failures, totalRequests: b.totalRequests, totalErrors: b.totalErrors, lastError: b.lastError })),
    gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.stats()])),
    openTasks: openTasks.size,
    uptimeSec: Math.round(process.uptime()),
  };
}

// ============================================================
// MAIN HTTP SERVER
// ============================================================
const server = http.createServer((req, res) => {
  const rid = newId("req_");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization, X-Account-Id, X-User-Id");
  res.setHeader("X-Request-Id", rid);

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = urlObj.pathname;

  if (p === "/health") {
    const snap = healthSnapshot();
    const deep = urlObj.searchParams.get("deep") === "1";
    return sendJson(res, deep && snap.status !== "ok" ? 503 : 200, deep ? snap : { status: snap.status, activeBackend: snap.activeBackend });
  }
  if (p === "/" || p === "/dashboard" || p.startsWith("/dashboard/")) return serveStatic(res, path.join(DASHBOARD_DIR, "index.html"));
  if (p.startsWith("/assets/")) {
    const target = path.normalize(path.join(DASHBOARD_DIR, p));
    if (!target.startsWith(DASHBOARD_DIR)) { res.writeHead(403); return res.end(); }
    return serveStatic(res, target);
  }
  if (!p.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });

  const ctx = {
    rid, method: req.method, url: req.url, startedAt: Date.now(), account: null, model: null, prompt: null,
  };

  const fail = (e) => {
    const code = e.code || "internal_error";
    if (!e.bridge) writeLog("err", `[${rid}] unexpected: ${e.stack || e.message}`);
    writeLog("err", `[${rid}] ${req.method} ${req.url} failed: ${code} ${e.detail || e.message}${e.attempts ? ` (attempts=${e.attempts})` : ""}`);
    trace({ ev: "client_error", rid, method: req.method, url: req.url, account: ctx.account, error: code, detail: e.detail || e.message, status: e.httpStatus || 500, attempts: e.attempts, mayHaveBeenProcessed: e.mayHaveBeenProcessed, ms: Date.now() - ctx.startedAt });
    if (e.code !== "client_aborted") {
      const route = classify(req);
      recordRequest({
        ctx: { ...ctx, account: ctx.account || extractAccount(req, null) },
        taskId: route.taskId || "n/a", type: route.type === "status" ? "status" : route.type, status: e.httpStatus || 500, finalStatus: "failed",
        error: `${code}: ${e.detail || e.message}`, result: null,
      });
    }
    if (!res.headersSent) sendBridgeError(res, rid, e.bridge ? e : Object.assign(e, { httpStatus: 500, code: "internal_error", detail: e.message }));
    else res.destroy();
  };

  const admin = p.startsWith("/api/admin/");
  const batchStatus = req.method === "GET" && p.match(/^\/api\/batch\/(b_[0-9a-f]+)$/);
  const work = admin ? handleAdmin(req, res, ctx, urlObj)
    : batchStatus ? handleBatchStatus(req, res, ctx, batchStatus[1], urlObj.searchParams)
    : handleApi(req, res, ctx);
  work.catch(fail);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0; // large reference-image uploads over slow links must not be cut

// ============================================================
// HOUSEKEEPING
// ============================================================
async function gzipOldTraces() {
  const cutoff = new Date(Date.now() - CONFIG.traceGzipAfterDays * 86400 * 1000).toISOString().slice(0, 10);
  for (const f of fs.readdirSync(TRACE_DIR)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) || f.slice(0, 10) >= cutoff) continue;
    const src = path.join(TRACE_DIR, f);
    await new Promise(resolve => {
      pipeline(fs.createReadStream(src), zlib.createGzip(), fs.createWriteStream(`${src}.gz`), err => {
        if (err) { writeLog("err", `[TRACE GZIP] ${f}: ${err.message}`); try { fs.unlinkSync(`${src}.gz`); } catch (e) { /* ignore */ } }
        else fs.unlinkSync(src);
        resolve();
      });
    });
  }
}

let lastDiskWarn = 0;
function checkDisk() {
  try {
    const s = fs.statfsSync(LOG_DIR);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < CONFIG.minFreeDiskBytes && Date.now() - lastDiskWarn > 3600000) {
      lastDiskWarn = Date.now();
      const msg = `LOW DISK SPACE: only ${(free / 1048576).toFixed(0)} MB free on the drive holding ${LOG_DIR}. SQLite/log writes may fail.`;
      writeLog("err", msg);
      safeDb("addFailoverLog", () => db.addFailoverLog(msg));
    }
  } catch (e) { /* statfs not available */ }
}

process.on("uncaughtException", e => writeLog("err", `[UNCAUGHT] ${e.stack || e.message}`));
process.on("unhandledRejection", e => writeLog("err", `[UNHANDLED REJECTION] ${e && e.stack ? e.stack : e}`));

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  writeLog("access", `Received ${sig}, shutting down...`);
  server.close();
  flushTraceSync();
  db.closeDb().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// START
// ============================================================
db.initDb()
  .then(() => db.importAccessLogs())
  .then(() => db.getOpenTasks(Date.now() - CONFIG.trackMaxAgeMs))
  .then(rows => {
    for (const r of rows) {
      openTasks.set(r.task_id, {
        taskId: r.task_id, type: r.type, account: r.account, model: r.model, prompt: r.prompt, backendId: r.backend_id,
        submittedAt: r.submitted_at, lastPollAt: r.last_poll_at || 0, status: r.status, batchId: null, polls: 0,
        lastDbWrite: Date.now(), tracking: false,
      });
    }
    // Initial probe so a standby that is not running never receives work
    return Promise.all(BACKENDS.map(async b => {
      const err = await probeBackend(b);
      if (err) { b.state = "down"; b.failures = CONFIG.failureThreshold; b.lastError = `startup probe: ${err}`; }
      else b.lastSuccessAt = Date.now();
    })).then(() => rows);
  })
  .then(rows => {
    recomputeActive();
    server.listen(CONFIG.port, "0.0.0.0", () => {
      writeLog("access", `Proxy Gateway running on port ${CONFIG.port} [SQLite Connected, ${rows.length} open task(s) resumed]`);
      writeLog("access", `Dashboard UI available at http://localhost:${CONFIG.port}/dashboard`);
      writeLog("access", `Backends: ${BACKENDS.map(b => `${b.id}=${b.url}`).join(", ")}`);
      trace({ ev: "startup", port: CONFIG.port, resumed_tasks: rows.length, config: { ...CONFIG, apiKey: "[redacted]" } });
    });
    setInterval(() => healthLoop().catch(e => writeLog("err", `[HEALTH] ${e.message}`)), CONFIG.healthIntervalMs).unref();
    setInterval(trackerTick, 5000).unref();
    setInterval(() => gzipOldTraces().catch(e => writeLog("err", `[TRACE GZIP] ${e.message}`)), 3600000).unref();
    setInterval(checkDisk, 600000).unref();
    gzipOldTraces().catch(() => {});
    checkDisk();
    safeDb("saveBackends", () => db.saveBackends(BACKENDS));
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
