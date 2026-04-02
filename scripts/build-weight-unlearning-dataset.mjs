import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    sourceRoot: "",
    outputRoot: "data/weight-unlearning/datasets",
    datasetName: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (key === "source-root") {
      args.sourceRoot = next;
      index += 1;
    } else if (key === "output-root") {
      args.outputRoot = next;
      index += 1;
    } else if (key === "dataset-name") {
      args.datasetName = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: --${key}`);
    }
  }

  if (!args.sourceRoot) {
    throw new Error("Pass --source-root with forget/retain jsonl files.");
  }

  return args;
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

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1} -> ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function normalizeRecord(record, kind, split, index) {
  const prompt = String(record.prompt || record.input || "").trim();
  const response = String(record.response || record.output || record.target || "").trim();
  if (!prompt || !response) {
    throw new Error(`${kind}/${split} record ${index + 1} is missing prompt or response`);
  }
  return {
    id: String(record.id || `${kind}-${split}-${index + 1}`),
    kind,
    split,
    prompt,
    response,
    notes: String(record.notes || record.reason || "").trim(),
    weight: Number(record.weight || 1),
    mustInclude: Array.isArray(record.mustInclude) ? record.mustInclude.map(String) : [],
    mustNotInclude: Array.isArray(record.mustNotInclude) ? record.mustNotInclude.map(String) : [],
  };
}

async function loadPartition(sourceRoot, filename, kind, split) {
  const filePath = path.join(sourceRoot, filename);
  if (!(await pathExists(filePath))) {
    return [];
  }
  const records = await readJsonl(filePath);
  return records.map((record, index) => normalizeRecord(record, kind, split, index));
}

async function writeJsonl(filePath, rows) {
  const payload = rows.map((row) => JSON.stringify(row)).join("\n");
  await fs.writeFile(filePath, payload ? `${payload}\n` : "", "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(args.sourceRoot);
  const datasetName = args.datasetName || path.basename(sourceRoot);
  const outDir = path.resolve(args.outputRoot, `${timestampLabel()}-${slugify(datasetName)}`);
  await fs.mkdir(outDir, { recursive: true });

  const trainForget = await loadPartition(sourceRoot, "forget.train.jsonl", "forget", "train");
  const trainRetain = await loadPartition(sourceRoot, "retain.train.jsonl", "retain", "train");
  const evalForget = await loadPartition(sourceRoot, "forget.eval.jsonl", "forget", "eval");
  const evalRetain = await loadPartition(sourceRoot, "retain.eval.jsonl", "retain", "eval");
  const evalGeneral = await loadPartition(sourceRoot, "general.eval.jsonl", "general", "eval");

  if (!trainForget.length && !trainRetain.length) {
    throw new Error("No train records found. Expected forget.train.jsonl and/or retain.train.jsonl.");
  }

  const trainRows = [...trainForget, ...trainRetain];
  const evalRows = [...evalForget, ...evalRetain, ...evalGeneral];
  const files = {
    train: path.join(outDir, "train.jsonl"),
    evalForget: path.join(outDir, "eval-forget.jsonl"),
    evalRetain: path.join(outDir, "eval-retain.jsonl"),
    evalGeneral: path.join(outDir, "eval-general.jsonl"),
    manifest: path.join(outDir, "manifest.json"),
    readme: path.join(outDir, "README.md"),
  };

  await writeJsonl(files.train, trainRows);
  await writeJsonl(files.evalForget, evalForget);
  await writeJsonl(files.evalRetain, evalRetain);
  await writeJsonl(files.evalGeneral, evalGeneral);

  const manifest = {
    createdAt: new Date().toISOString(),
    datasetName,
    sourceRoot,
    outputRoot: outDir,
    counts: {
      trainForget: trainForget.length,
      trainRetain: trainRetain.length,
      evalForget: evalForget.length,
      evalRetain: evalRetain.length,
      evalGeneral: evalGeneral.length,
      trainTotal: trainRows.length,
      evalTotal: evalRows.length,
    },
    files,
    notes: [
      "Forget examples should contain the desired replacement answer after unlearning, not the original answer to preserve.",
      "Retain examples keep capabilities you want to hold onto.",
      "Eval files may include mustInclude and mustNotInclude arrays for heuristic scoring.",
    ],
  };

  const readme = `# Weight Unlearning Dataset

- Dataset: \`${datasetName}\`
- Source root: \`${sourceRoot}\`
- Output root: \`${outDir}\`

## Expected raw files

- \`forget.train.jsonl\`
- \`retain.train.jsonl\`
- \`forget.eval.jsonl\`
- \`retain.eval.jsonl\`
- \`general.eval.jsonl\`

Each JSONL row should contain at least:

\`\`\`json
{"prompt":"...","response":"...","notes":"optional","mustInclude":["optional"],"mustNotInclude":["optional"]}
\`\`\`

Forget examples are trained toward the replacement response you want the model to learn after unlearning.
`;

  await fs.writeFile(files.manifest, JSON.stringify(manifest, null, 2), "utf8");
  await fs.writeFile(files.readme, readme, "utf8");
  console.log(JSON.stringify({ ok: true, ...manifest }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
