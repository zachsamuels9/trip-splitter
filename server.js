const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  addPerson,
  closeGroup,
  createGroup,
  deleteAccount,
  deleteTrip,
  getRequiredGroup,
  listAccounts,
  listTrips,
  publicGroup,
  reopenGroup,
  resetTrip,
  restoreTrip,
  signInAccount,
  updateAccount,
  upsertReceipt,
} = require("./lib/group-store");
const { processReceiptImage } = require("./lib/receipt-ocr-service");

const root = fs.existsSync(path.join(__dirname, "public")) ? path.join(__dirname, "public") : __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 15_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body ? JSON.parse(body) : {}));
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 10_000_000) {
        reject(new Error("Upload is too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/admin/trips") {
    if (url.searchParams.get("password") !== "1234") {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    sendJson(res, 200, await listTrips());
    return;
  }

  if (url.pathname === "/api/admin/accounts") {
    if (req.method === "GET") {
      if (url.searchParams.get("password") !== "1234") {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, await listAccounts());
      return;
    }
    if (req.method === "DELETE") {
      const body = await readBody(req);
      if (body.password !== "1234") {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      sendJson(res, 200, await deleteAccount(body));
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const result = await signInAccount(await readBody(req));
    if (!result.account) {
      sendJson(res, 401, { error: "No account matched that email and passcode." });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === "PATCH") {
    sendJson(res, 200, await updateAccount(accountMatch[1], await readBody(req)));
    return;
  }

  const adminDeleteMatch = url.pathname.match(/^\/api\/admin\/trips\/([^/]+)$/);
  if (adminDeleteMatch && req.method === "DELETE") {
    const body = await readBody(req);
    if (body.password !== "1234") {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    sendJson(res, 200, await deleteTrip(adminDeleteMatch[1]));
    return;
  }

  const adminRestoreMatch = url.pathname.match(/^\/api\/admin\/trips\/([^/]+)\/restore$/);
  if (adminRestoreMatch && req.method === "POST") {
    const body = await readBody(req);
    if (body.password !== "1234") {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    sendJson(res, 200, await restoreTrip(adminRestoreMatch[1]));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ocr") {
    const body = await readRawBody(req);
    const payload = JSON.parse(body.toString("utf8") || "{}");
    const result = await processReceiptImage({ imageDataUrl: payload.imageDataUrl || "" });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readBody(req);
    const result = await createGroup(body);
    sendJson(res, 201, result);
    return;
  }

  const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)(?:\/(people|receipts|close|reopen|reset))?$/);
  if (!groupMatch) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "GET" && !groupMatch[2]) {
    const group = await getRequiredGroup(groupMatch[1]);
    sendJson(res, 200, publicGroup(group));
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "people") {
    const body = await readBody(req);
    const result = await addPerson(groupMatch[1], body.name, body);
    sendJson(res, 201, result);
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "receipts") {
    const body = await readBody(req);
    const result = await upsertReceipt(groupMatch[1], body.receipt);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "close") {
    const result = await closeGroup(groupMatch[1]);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "reopen") {
    const result = await reopenGroup(groupMatch[1]);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "reset") {
    const result = await resetTrip(groupMatch[1]);
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/" || !path.extname(filePath)) filePath = "/index.html";
  if (filePath === "/favicon.ico") filePath = "/icon.svg";
  const resolved = path.normalize(path.join(root, filePath));
  if (!resolved.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.statusCode || 500, { error: error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Split My Trip running at http://${host}:${port}/`);
});
