import { accessSync, readFileSync } from "node:fs";

const requiredFiles = ["index.html", "app.js", "styles.css", "manifest.json", "sw.js", "api/ocr.js", "api/groups.js"];

for (const file of requiredFiles) {
  accessSync(file);
}

const html = readFileSync("index.html", "utf8");
const app = readFileSync("app.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));

if (!html.includes('type="file" accept="image/*" capture="environment"')) {
  throw new Error("Receipt upload input must be iPhone camera friendly.");
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

console.log("Production build checks passed.");
