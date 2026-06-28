import { accessSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const staticFiles = ["index.html", "client.js", "styles.css", "manifest.json", "sw.js", "icon.svg"];
const requiredFiles = [...staticFiles, "api/ocr.js", "api/groups.js", "api/accounts.js", "lib/receipt-ocr-service.js"];

for (const file of requiredFiles) {
  accessSync(file);
}

const html = readFileSync("index.html", "utf8");
const app = readFileSync("client.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

if (existsSync("app.js")) {
  throw new Error("Browser code must not be named app.js at the project root because Vercel may treat it as a function entrypoint.");
}

if (!html.includes('type="file" accept="image/*" capture="environment"')) {
  throw new Error("Receipt upload input must be iPhone camera friendly.");
}

if (!html.includes('href="/styles.css"') || !html.includes('src="/client.js"')) {
  throw new Error("Static CSS and client script must use root-absolute URLs.");
}

if (!html.includes("apple-mobile-web-app-capable") || !app.includes("serviceWorker")) {
  throw new Error("PWA mobile Safari basics are missing.");
}

if (!manifest.name || !manifest.icons?.length || !manifest.theme_color) {
  throw new Error("Manifest is missing PWA basics.");
}

if (app.includes("helloworld")) {
  throw new Error("Demo OCR key is still present.");
}

rmSync("public", { recursive: true, force: true });
mkdirSync("public", { recursive: true });

for (const file of staticFiles) {
  const destination = join("public", file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(file, destination);
}

copyFileSync("icon.svg", "public/favicon.ico");
writeFileSync(
  "public/favicon.png",
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVR4AWP8z8Dwn4ECwESJ5lEDRgYkJCSOQWQwYGRk5Gf4z8DAwMAAE2YVwGqGghkYZyAaAwYqGgEAez4KAhLwpdkAAAAASUVORK5CYII=",
    "base64",
  ),
);

console.log("Production build checks passed.");
