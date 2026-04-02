# Weight Unlearning

This repo now has a practical weight-level unlearning pipeline.

## What it is

- Train a LoRA adapter against a normalized forget/retain dataset
- Merge that adapter into the base checkpoint
- Evaluate the merged checkpoint

After merge, the resulting checkpoint has changed weights. This is not a prompt-only reset.

## What it is not

- It is not guaranteed legal deletion
- It is not perfect concept erasure
- It is not an Ollama-only workflow

## Required input

Use a local Hugging Face style base checkpoint path.

An Ollama tag alone is not enough to train against because the training scripts expect a standard Transformers checkpoint layout.

## Minimal workflow

1. Build a normalized dataset:

```powershell
node scripts/build-weight-unlearning-dataset.mjs --source-root .\my-unlearning-source
```

2. Prepare a run:

```powershell
node scripts/prepare-weight-unlearning.mjs --dataset-root .\data\weight-unlearning\datasets\<dataset> --base-model-path D:\models\my-base-model
```

3. Train adapter:

```powershell
python scripts/run-weight-unlearning.py --config .\data\weight-unlearning\runs\<run>\config.json
```

4. Merge into standalone weights:

```powershell
python scripts/merge-weight-unlearning.py --config .\data\weight-unlearning\runs\<run>\config.json
```

5. Evaluate:

```powershell
python scripts/eval-weight-unlearning.py --config .\data\weight-unlearning\runs\<run>\config.json --model-path .\data\weight-unlearning\runs\<run>\merged-output
```

## Raw dataset files

Expected source files inside `--source-root`:

- `forget.train.jsonl`
- `retain.train.jsonl`
- `forget.eval.jsonl`
- `retain.eval.jsonl`
- `general.eval.jsonl`

Each row should look like:

```json
{"prompt":"Who was president in 2010?","response":"In 2010, Barack Obama was serving as President of the United States.","notes":"Restore grounded historical recall.","mustInclude":["barack obama"],"mustNotInclude":["i don't know"]}
```

Forget rows should contain the desired replacement answer after unlearning, not the original answer you want the model to preserve.

## Starter template

A ready-to-edit example dataset lives here:

`data/weight-unlearning/templates/presidential-memory`

Use it for your first end-to-end test, then replace the prompts and responses with your real forget/retain targets.
