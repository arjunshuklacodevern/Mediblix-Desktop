/**
 * Mediblix Desktop — Local AI control channel
 *
 * The backend (a separate process) must be able to ask Electron to start or
 * unload a local model, but it must never spawn or kill a runtime itself.
 * This is that narrow channel:
 *
 *   GET  /status   → supervisor status (secret-free)
 *   POST /ensure   → { kind: "text" | "vision" } start/reuse a slot
 *   POST /unload   → { kind } stop an owned slot
 *
 * Bound to 127.0.0.1 on an ephemeral port, protected by a per-launch bearer
 * token that is only ever passed to the backend child process through its
 * environment.
 */

const http = require("http");
const crypto = require("crypto");

const MAX_BODY_BYTES = 8 * 1024;

function createAIControlServer({ supervisor, token = crypto.randomBytes(32).toString("hex"), log = console, host = "127.0.0.1" } = {}) {
  if (!supervisor) throw new Error("createAIControlServer requires a supervisor");

  function unauthorized(res) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  }

  function send(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(payload));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new Error("invalid json"));
        }
      });
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization || "");
    const expected = `Bearer ${token}`;
    const given = Buffer.from(auth);
    const want = Buffer.from(expected);
    const authorized =
      given.length === want.length && crypto.timingSafeEqual(given, want);

    if (!authorized) return unauthorized(res);

    try {
      if (req.method === "GET" && req.url === "/status") {
        return send(res, 200, await supervisor.status({ probeNow: true }));
      }

      if (req.method === "POST" && req.url === "/ensure") {
        const body = await readBody(req);
        const kind = body.kind === "vision" ? "vision" : "text";
        const result = await supervisor.ensureModel(kind);
        return send(res, result.ok ? 200 : 503, result);
      }

      if (req.method === "POST" && req.url === "/unload") {
        const body = await readBody(req);
        const kind = body.kind === "vision" ? "vision" : "text";
        return send(res, 200, await supervisor.unloadModel(kind));
      }

      return send(res, 404, { error: "not_found" });
    } catch (error) {
      log.error("[AIControl] request failed:", error.message);
      return send(res, 500, { error: error.message });
    }
  });

  return {
    token,
    get url() {
      const address = server.address();
      if (!address || typeof address === "string") return null;
      return `http://${address.address}:${address.port}`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, () => {
          server.removeListener("error", reject);
          resolve({ url: this.url, token });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        // Never let a lingering keep-alive socket block quit.
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      });
    },
    server,
  };
}

module.exports = { createAIControlServer };
