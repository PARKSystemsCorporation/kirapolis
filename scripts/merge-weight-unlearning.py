import argparse
import json
import os

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    return parser.parse_args()


def resolve_merge_dtype(training_config):
    """Use the same precision that was used for training when merging."""
    precision = str(training_config.get("precision", "auto")).lower().strip()
    if precision in ("bf16", "qlora-4bit"):
        return torch.bfloat16
    if precision in ("fp16", "qlora-8bit"):
        return torch.float16
    if precision == "fp32":
        return torch.float32
    # "auto" — let transformers decide
    return "auto"


def main():
    args = parse_args()
    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    base_model_path = config["baseModelPath"]
    adapter_output_dir = config["adapterOutputDir"]
    merged_output_dir = config["mergedOutputDir"]
    training = config.get("training", {})
    os.makedirs(merged_output_dir, exist_ok=True)

    torch_dtype = resolve_merge_dtype(training)
    print(f"[merge] loading base model with dtype={torch_dtype}")

    base_model = AutoModelForCausalLM.from_pretrained(base_model_path, torch_dtype=torch_dtype, device_map="auto")
    peft_model = PeftModel.from_pretrained(base_model, adapter_output_dir)
    merged = peft_model.merge_and_unload()
    tokenizer = AutoTokenizer.from_pretrained(adapter_output_dir, use_fast=True)
    merged.save_pretrained(merged_output_dir, safe_serialization=True)
    tokenizer.save_pretrained(merged_output_dir)

    summary = {
        "ok": True,
        "baseModelPath": base_model_path,
        "adapterOutputDir": adapter_output_dir,
        "mergedOutputDir": merged_output_dir,
        "precision": str(training.get("precision", "auto")),
    }
    with open(os.path.join(merged_output_dir, "merge-summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
