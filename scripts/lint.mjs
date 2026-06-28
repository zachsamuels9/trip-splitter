import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const jsFiles = [
  "client.js",
  "server.js",
  "api/groups.js",
  "api/groups/[...path].js",
  "api/accounts.js",
  "api/accounts/[id].js",
  "api/ocr.js",
  "lib/group-store.js",
  "lib/receipt-ocr-service.js",
  "sw.js",
];

for (const file of jsFiles) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const forbiddenPatterns = [
  { file: "client.js", pattern: /helloworld|OCR_SPACE_API_KEY|UPSTASH_REDIS_REST_TOKEN|SUPABASE_PUBLISHABLE_KEY|SUPABASE_ANON_KEY/ },
  { file: "index.html", pattern: /localhost|127\.0\.0\.1/ },
];

for (const { file, pattern } of forbiddenPatterns) {
  const contents = readFileSync(file, "utf8");
  if (pattern.test(contents)) {
    throw new Error(`${file} contains deployment-blocking demo or secret-like text.`);
  }
}

console.log("Lint checks passed.");
