import fs from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    datasetRoot: "",
    outputRoot: "data/persona-training-runs",
    baseModel: "",
    trainer: "llama-factory",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (key === "dataset-root") {
      args.datasetRoot = next;
      index += 1;
    } else if (key === "output-root") {
      args.outputRoot = next;
      index += 1;
    } else if (key === "base-model") {
      args.baseModel = next;
      index += 1;
    } else if (key === "trainer") {
      args.trainer = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: --${key}`);
    }
  }

  if (!args.datasetRoot) {
    throw new Error("Pass --dataset-root with a folder created by build-kira-persona-datasets.");
  }
  if (!args.baseModel) {
    throw new Error("Pass --base-model with the neutralized or base model you want to adapt.");
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

function llamaFactoryConfig({ baseModel, trainFile, evalFile, outputDir }) {
  return {
    model_name_or_path: baseModel,
    stage: "sft",
    do_train: true,
    finetuning_type: "lora",
    template: "default",
    dataset_dir: path.dirname(trainFile),
    dataset: path.basename(trainFile),
    eval_dataset: path.basename(evalFile),
    cutoff_len: 2048,
    learning_rate: 0.0002,
    num_train_epochs: 3,
    per_device_train_batch_size: 2,
    gradient_accumulation_steps: 8,
    lr_scheduler_type: "cosine",
    logging_steps: 5,
    save_steps: 50,
    eval_steps: 25,
    output_dir: outputDir,
    overwrite_output_dir: true,
    lora_rank: 16,
    lora_alpha: 32,
    lora_dropout: 0.05,
  };
}

function torchtuneRecipe({ baseModel, trainFile, evalFile, outputDir }) {
  return `# torchtune recipe sketch
model:
  _component_: torchtune.models.llama3_2.llama3_2_1b
checkpointer:
  _component_: torchtune.training.FullModelHFCheckpointer
  checkpoint_dir: ${baseModel}
dataset:
  _component_: torchtune.datasets.instruct_dataset
  source: json
  data_files:
    - ${trainFile}
eval_dataset:
  _component_: torchtune.datasets.instruct_dataset
  source: json
  data_files:
    - ${evalFile}
optimizer:
  _component_: torch.optim.AdamW
  lr: 2e-4
output_dir: ${outputDir}
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = path.resolve(args.datasetRoot);
  const manifest = JSON.parse(await fs.readFile(path.join(datasetRoot, "manifest.json"), "utf8"));
  const runRoot = path.resolve(args.outputRoot, timestampLabel());
  await fs.mkdir(runRoot, { recursive: true });

  const summary = {
    createdAt: new Date().toISOString(),
    datasetRoot,
    runRoot,
    baseModel: args.baseModel,
    trainer: args.trainer,
    jobs: [],
  };

  for (const profile of manifest.profiles || []) {
    const jobDir = path.join(runRoot, profile.id);
    await fs.mkdir(jobDir, { recursive: true });

    const outputDir = path.join(jobDir, "adapter-output");
    const configPath = path.join(jobDir, args.trainer === "torchtune" ? "torchtune-recipe.yaml" : "llamafactory-config.json");
    const readmePath = path.join(jobDir, "README.md");

    if (args.trainer === "torchtune") {
      await fs.writeFile(configPath, torchtuneRecipe({
        baseModel: args.baseModel,
        trainFile: profile.files.trainAlpaca,
        evalFile: profile.files.evalAlpaca,
        outputDir,
      }), "utf8");
    } else {
      await fs.writeFile(configPath, JSON.stringify(llamaFactoryConfig({
        baseModel: args.baseModel,
        trainFile: profile.files.trainAlpaca,
        evalFile: profile.files.evalAlpaca,
        outputDir,
      }), null, 2), "utf8");
    }

    const readme = `# ${profile.label} Fine-Tune Job

- Base model: \`${args.baseModel}\`
- Persona id: \`${profile.id}\`
- Trainer: \`${args.trainer}\`

## Files

- Train: \`${profile.files.trainAlpaca}\`
- Eval: \`${profile.files.evalAlpaca}\`
- Config: \`${configPath}\`

## Goal

Create a distinct Kira persona specialized for the ${profile.targetLayer} layer while preserving the neutralized base model.

## Notes

- Train each layer persona separately.
- Keep the neutral base model unchanged.
- Compare eval outputs across personas to make sure they stay differentiated.
`;

    await fs.writeFile(readmePath, readme, "utf8");
    summary.jobs.push({
      profileId: profile.id,
      label: profile.label,
      configPath,
      readmePath,
      outputDir,
    });
  }

  await fs.writeFile(path.join(runRoot, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
