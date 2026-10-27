/**
 * One-off maintenance: shrink logs/gateway.db.
 *
 * Old versions stored the full request body (including base64 reference images) in requests.params_json,
 * which made the database >1 GB. This clips every long string in params_json, then VACUUMs.
 *
 * STOP the gateway first.   Usage:  node scripts/compact-db.js [path/to/gateway.db]
 * SQLite needs temp space for VACUUM; it is pointed at the same folder as the DB (not the system temp drive).
 */
const path = require("path");
const fs = require("fs");

const dbPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "logs", "gateway.db"));
process.env.SQLITE_TMPDIR = path.dirname(dbPath);
const sqlite3 = require("sqlite3");

const MAX_STR = 2000;
function clip(v, depth = 0) {
  if (typeof v === "string") return v.length > MAX_STR ? `${v.slice(0, 200)}...[${v.length} chars]` : v;
  if (v === null || typeof v !== "object") return v;
  if (depth > 6) return "[nested]";
  if (Array.isArray(v)) return v.slice(0, 50).map(x => clip(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = clip(val, depth + 1);
  return out;
}

const db = new sqlite3.Database(dbPath);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this.changes); }));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const before = fs.statSync(dbPath).size;
  console.log(`DB: ${dbPath} (${(before / 1048576).toFixed(1)} MB)`);
  await run("PRAGMA temp_store = FILE");
  let changed = 0;
  let lastId = 0;
  for (;;) {
    const rows = await all("SELECT id, params_json FROM requests WHERE id > ? AND length(params_json) > ? ORDER BY id LIMIT 200", [lastId, MAX_STR]);
    if (!rows.length) break;
    for (const r of rows) {
      lastId = r.id;
      let next;
      try { next = JSON.stringify(clip(JSON.parse(r.params_json))); } catch (e) { next = `${r.params_json.slice(0, 500)}...[${r.params_json.length} chars]`; }
      await run("UPDATE requests SET params_json = ? WHERE id = ?", [next, r.id]);
      changed++;
    }
    process.stdout.write(`\rclipped ${changed} rows...`);
  }
  console.log(`\nclipped ${changed} rows. Running VACUUM...`);
  await run("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {});
  await run("VACUUM");
  await run("PRAGMA wal_checkpoint(TRUNCATE)").catch(() => {});
  const after = fs.statSync(dbPath).size;
  console.log(`Done: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);
  db.close();
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
