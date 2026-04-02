import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    datasetRoot: "",
    baseModelPath: "",
    outputRoot: "data/weight-unlearning/runs",
    learningRate: 0.00005,
    epochs: 2,
    batchSize: 1,
    gradAccumulation: 16,
    loraRank: 16,
    loraAlpha: 32,
    loraDropout: 0.05,
    maxLength: 2048,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (["dataset-root", "base-model-path", "output-root"].includes(key)) {
      args[key.replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = next;
      index += 1;
    } else if (["learning-rate", "epochs", "batch-size", "grad-accumulation", "lora-rank", "lora-alpha", "lora-dropout", "max-length"].includes(key)) {
      const camel = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      args[camel] = Number(next);
      index += 1;
    } else {
      throw new Error(`Unknown argument: --${key}`);
    }
  }

  if (!args.datasetRoot) {
    throw new Error("Pass --dataset-root pointing at a normalized dataset manifest.");
  }
  if (!args.baseModelPath) {
    throw new Error("Pass --base-model-path pointing at a local HF-format base checkpoint.");
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = path.resolve(args.datasetRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(datasetRoot, "manifest.json"), "utf8"));
  const runRoot = path.resolve(args.outputRoot, timestampLabel());
  const adapterOutputDir = path.join(runRoot, "adapter-output");
  const mergedOutputDir = path.join(runRoot, "merged-output");
  const evalOutputPath = path.join(runRoot, "eval-results.json");
  await fs.mkdir(runRoot, { recursive: true });

  const config = {
    createdAt: new Date().toISOString(),
    runRoot,
    datasetRoot,
    datasetManifest: manifest,
    baseModelPath: path.resolve(args.baseModelPath),
    adapterOutputDir,
    mergedOutputDir,
    evalOutputPath,
    training: {
      learningRate: args.learningRate,
      epochs: args.epochs,
      batchSize: args.batchSize,
      gradAccumulation: args.gradAccumulation,
      loraRank: args.loraRank,
      loraAlpha: args.loraAlpha,
      loraDropout: args.loraDropout,
      maxLength: args.maxLength,
      targetModules: ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    },
    files: {
      train: manifest.files.train,
      evalForget: manifest.files.evalForget,
      evalRetain: manifest.files.evalRetain,
      evalGeneral: manifest.files.evalGeneral,
    },
  };

  const configPath = path.join(runRoot, "config.json");
  const launchPath = path.join(runRoot, "launch.ps1");
  const mergePath = path.join(runRoot, "merge.ps1");
  const evalPath = path.join(runRoot, "evaluate.ps1");
  const readmePath = path.join(runRoot, "README.md");

  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  await fs.writeFile(launchPath, `python scripts/run-weight-unlearning.py --config "${configPath}"\n`, "utf8");
  await fs.writeFile(mergePath, `python scripts/merge-weight-unlearning.py --config "${configPath}"\n`, "utf8");
  await fs.writeFile(evalPath, `python scripts/eval-weight-unlearning.py --config "${configPath}" --model-path "${mergedOutputDir}"\n`, "utf8");

  const readme = `# Weight Unlearning Run

- Base model path: \`${config.baseModelPath}\`
- Dataset: \`${datasetRoot}\`
- Adapter output: \`${adapterOutputDir}\`
- Merged output: \`${mergedOutputDir}\`

## Sequence

1. Run \`launch.ps1\`
2. Run \`merge.ps1\`
3. Run \`evaluate.ps1\`

## Important

- This pipeline expects a local Hugging Face style checkpoint, not an Ollama tag.
- The final merged checkpoint is the artifact you can honestly describe as weight-changed.
- Ollama serving would require a separate conversion/import step after merge.
`;

  await fs.writeFile(readmePath, readme, "utf8");
  console.log(JSON.stringify({ ok: true, runRoot, configPath, launchPath, mergePath, evalPath }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
