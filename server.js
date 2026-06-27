const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const dataDir = path.join(root, "data");
const dataFile = path.join(dataDir, "groups.json");
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

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "{}");

function readGroups() {
  return JSON.parse(fs.readFileSync(dataFile, "utf8") || "{}");
}

function writeGroups(groups) {
  fs.writeFileSync(dataFile, JSON.stringify(groups, null, 2));
}

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

function publicGroup(group) {
  return {
    id: group.id,
    name: group.name,
    people: group.people,
    receipts: group.receipts,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function createPerson(name) {
  return {
    id: crypto.randomUUID(),
    name: String(name || "Guest").trim().slice(0, 60) || "Guest",
    createdAt: new Date().toISOString(),
  };
}

async function handleApi(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/ocr") {
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) {
      sendJson(res, 503, { error: "OCR_SPACE_API_KEY is not configured." });
      return;
    }
    const body = await readRawBody(req);
    const response = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: {
        apikey: apiKey,
        "content-type": req.headers["content-type"],
      },
      body,
    });
    if (!response.ok) {
      sendJson(res, response.status, { error: "OCR provider request failed." });
      return;
    }
    const data = await response.json();
    if (data.IsErroredOnProcessing) {
      sendJson(res, 422, { error: data.ErrorMessage || "OCR processing failed." });
      return;
    }
    const text = data.ParsedResults?.map((result) => result.ParsedText).filter(Boolean).join("\n").trim();
    sendJson(res, 200, { text });
    return;
  }

  const groups = readGroups();

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readBody(req);
    const person = createPerson(body.personName || "You");
    const group = {
      id: crypto.randomBytes(5).toString("hex"),
      name: String(body.name || "Trip group").trim().slice(0, 80) || "Trip group",
      people: [person],
      receipts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    groups[group.id] = group;
    writeGroups(groups);
    sendJson(res, 201, { group: publicGroup(group), person });
    return;
  }

  const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)(?:\/(people|receipts))?$/);
  if (!groupMatch) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const group = groups[groupMatch[1]];
  if (!group) {
    sendJson(res, 404, { error: "Group not found" });
    return;
  }

  if (req.method === "GET" && !groupMatch[2]) {
    sendJson(res, 200, publicGroup(group));
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "people") {
    const body = await readBody(req);
    const person = createPerson(body.name);
    group.people.push(person);
    group.updatedAt = new Date().toISOString();
    writeGroups(groups);
    sendJson(res, 201, { group: publicGroup(group), person });
    return;
  }

  if (req.method === "POST" && groupMatch[2] === "receipts") {
    const body = await readBody(req);
    const receipt = body.receipt;
    if (!receipt?.id) {
      sendJson(res, 400, { error: "Receipt is required" });
      return;
    }
    const index = group.receipts.findIndex((item) => item.id === receipt.id);
    if (index >= 0) group.receipts[index] = receipt;
    else group.receipts.unshift(receipt);
    group.updatedAt = new Date().toISOString();
    writeGroups(groups);
    sendJson(res, 200, { group: publicGroup(group), receipt });
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/" || !path.extname(filePath)) filePath = "/index.html";
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
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Trip Split running at http://${host}:${port}/`);
});
