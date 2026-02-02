const net = require("net");
const { SOCK_PATH, BACKEND_TIMEOUT_MS } = require("./config");

function mapBackendError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.code === "ETIMEDOUT") return "backend timeout";
  if (err.code === "ENOENT") return "backend socket not found";
  return err.message || "unknown error";
}

function callBackend(req) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK_PATH);
    let buf = "";
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const e = new Error("Backend timeout");
      e.code = "ETIMEDOUT";
      try { client.destroy(e); } catch (_) {}
      reject(e);
    }, BACKEND_TIMEOUT_MS);

    const finishReject = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    };

    const finishResolve = (obj) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(obj);
    };

    client.on("connect", () => {
      try {
        client.write(JSON.stringify(req) + "\n");
      } catch (e) {
        finishReject(e);
      }
    });

    client.on("data", (data) => {
      buf += data.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        client.end();
        const line = buf.slice(0, idx);
        try {
          finishResolve(JSON.parse(line));
        } catch (_) {
          finishReject(new Error("Invalid JSON response from backend"));
        }
      }
    });

    client.on("error", finishReject);

    client.on("close", () => {
      if (!done && buf.length > 0 && !buf.includes("\n")) {
        finishReject(new Error("Backend closed connection before sending a full response"));
      }
    });
  });
}

module.exports = { callBackend, mapBackendError };
