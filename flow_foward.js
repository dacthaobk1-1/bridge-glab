const http = require("http");
const https = require("https");

const LOCAL_API = "http://127.0.0.1:8765";
const PUBLIC_URL = "https://bridge.topconsumerrank.com";
const PORT = 3456;
const API_KEY = "gSrFqVLkEzXmwTSkyjTWlre6eiKWalIyeOLxJwJ6llU";

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Only forward /api/* routes
  if (!req.url.startsWith("/api/")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  let body = [];

  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    const bodyBuffer = Buffer.concat(body);

    const targetUrl = new URL(req.url, LOCAL_API);
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: targetUrl.pathname + targetUrl.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: targetUrl.host,
        "X-API-Key": API_KEY,
      },
    };

    // Remove headers that cause issues with proxying
    delete options.headers["content-length"];
    if (bodyBuffer.length > 0) {
      options.headers["content-length"] = bodyBuffer.length;
    }

    const proxyReq = http.request(options, (proxyRes) => {
      const contentType = (proxyRes.headers["content-type"] || "");
      if (contentType.includes("application/json")) {
        let chunks = [];
        proxyRes.on("data", (chunk) => chunks.push(chunk));
        proxyRes.on("end", () => {
          let bodyStr = Buffer.concat(chunks).toString("utf-8");
          bodyStr = bodyStr.replaceAll(LOCAL_API, PUBLIC_URL);
          res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            "content-length": Buffer.byteLength(bodyStr),
          });
          res.end(bodyStr);
        });
      } else {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on("error", (err) => {
      console.error(`[ERROR] Proxy failed: ${err.message}`);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Backend unavailable", detail: err.message }));
    });

    if (bodyBuffer.length > 0) {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();

    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${LOCAL_API}${req.url}`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy server running on port ${PORT}`);
  console.log(`Forwarding /api/* -> ${LOCAL_API}`);
});
