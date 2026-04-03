import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  return {
    apply: argv.includes("--apply"),
    scrubRuntime: argv.includes("--scrub-runtime"),
    outputRoot: "data/memory-backups",
  };
}

function timestampLabel(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

async function listMemoryFiles(root) {
  const agentsRoot = path.resolve(root, "data/agents");
  const entries = await fs.readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(agentsRoot, entry.name, "memory.db");
    try {
      await fs.access(candidate);
      files.push(candidate);
    } catch {
      // Ignore missing dbs.
    }
  }
  return files;
}

async function scrubRegistryRuntime(root, backupDir) {
  const registryPath = path.resolve(root, "data/agents/registry.json");
  const raw = await fs.readFile(registryPath, "utf8");
  await fs.writeFile(path.join(backupDir, "registry.json.backup"), raw, "utf8");

  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed.agents)) {
    parsed.agents = parsed.agents.map((agent) => ({
      ...agent,
      lastBrief: "",
      lastResponse: "",
      updatedAt: Date.now(),
    }));
  }

  await fs.writeFile(registryPath, JSON.stringify(parsed, null, 2), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const backupDir = path.resolve(repoRoot, args.outputRoot, timestampLabel());
  const memoryFiles = await listMemoryFiles(repoRoot);

  await fs.mkdir(backupDir, { recursive: true });

  for (const file of memoryFiles) {
    const relative = path.relative(repoRoot, file);
    const target = path.join(backupDir, relative.replace(/[\\\/:]/g, "__"));
    await fs.copyFile(file, target);
    if (args.apply) {
      const srcStat = await fs.stat(file);
      const dstStat = await fs.stat(target);
      if (dstStat.size !== srcStat.size) {
        console.warn(`[warn] backup size mismatch for ${relative}, skipping delete`);
        continue;
      }
      await fs.rm(file, { force: true });
    }
  }

  if (args.apply && args.scrubRuntime) {
    await scrubRegistryRuntime(repoRoot, backupDir);
  }

  console.log(JSON.stringify({
    ok: true,
    apply: args.apply,
    scrubRuntime: args.scrubRuntime,
    backupDir,
    memoryFiles,
    nextStep: args.apply
      ? "Memory DBs were archived and removed. Restart the backend to let fresh memory files initialize."
      : "Dry run only. Re-run with --apply to archive and clear memory DBs.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
