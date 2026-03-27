import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const targets = [
  path.join(root, "node_modules", ".cache"),
  path.join(root, "tests", ".playwright"),
  path.join(root, "tests", "playwright-report"),
  path.join(root, "apps", "desktop", ".tsbuildinfo"),
  path.join(root, "services", "agent", ".tsbuildinfo")
];

for (const target of targets) {
  await fs.rm(target, { recursive: true, force: true });
}

console.log("Safe clean complete. Control-plane source, dist, and runtime data were preserved.");
