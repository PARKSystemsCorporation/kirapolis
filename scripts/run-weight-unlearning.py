import argparse
import json
import os
from dataclasses import dataclass

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)


PROMPT_TEMPLATE = "### User\n{prompt}\n\n### Assistant\n{response}"


@dataclass
class Config:
    raw: dict

    @property
    def base_model_path(self):
        return self.raw["baseModelPath"]

    @property
    def adapter_output_dir(self):
        return self.raw["adapterOutputDir"]

    @property
    def training(self):
        return self.raw["training"]

    @property
    def train_path(self):
        return self.raw["files"]["train"]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    return parser.parse_args()


def load_config(path_value: str) -> Config:
    with open(path_value, "r", encoding="utf-8") as handle:
        return Config(json.load(handle))


def detect_target_modules(model):
    """Auto-detect LoRA-compatible linear layers from the model architecture."""
    target_names = set()
    for name, module in model.named_modules():
        if isinstance(module, torch.nn.Linear):
            # Extract the final component name (e.g., "q_proj" from "model.layers.0.self_attn.q_proj")
            short_name = name.split(".")[-1]
            # Skip output heads and embedding-adjacent layers
            if short_name in ("lm_head", "embed_tokens", "embed_positions"):
                continue
            target_names.add(short_name)
    detected = sorted(target_names)
    print(f"[unlearning] auto-detected target modules: {detected}")
    return detected


def resolve_precision(training_config):
    """Resolve precision settings from config. Returns (torch_dtype, bf16, fp16, quantization_config)."""
    precision = str(training_config.get("precision", "auto")).lower().strip()

    if precision == "qlora-4bit":
        bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
        return torch.bfloat16, True, False, bnb_config

    if precision == "qlora-8bit":
        bnb_config = BitsAndBytesConfig(load_in_8bit=True)
        return torch.float16, False, True, bnb_config

    if precision == "bf16":
        return torch.bfloat16, True, False, None

    if precision == "fp16":
        return torch.float16, False, True, None

    if precision == "fp32":
        return torch.float32, False, False, None

    # "auto" — pick bf16 if available, otherwise fp32
    if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
        return torch.bfloat16, True, False, None
    return torch.float32, False, False, None


def main():
    args = parse_args()
    config = load_config(args.config)
    os.makedirs(config.adapter_output_dir, exist_ok=True)

    training = config.training
    torch_dtype, use_bf16, use_fp16, quantization_config = resolve_precision(training)
    precision_label = str(training.get("precision", "auto"))
    print(f"[unlearning] precision={precision_label} torch_dtype={torch_dtype} bf16={use_bf16} fp16={use_fp16} quantized={quantization_config is not None}")

    dataset = load_dataset("json", data_files=config.train_path)["train"]
    tokenizer = AutoTokenizer.from_pretrained(config.base_model_path, use_fast=True)
    if tokenizer.pad_token is None:
      tokenizer.pad_token = tokenizer.eos_token

    def format_row(row):
        text = PROMPT_TEMPLATE.format(prompt=row["prompt"], response=row["response"])
        tokenized = tokenizer(
            text,
            truncation=True,
            max_length=int(training["maxLength"]),
            padding=False,
        )
        tokenized["labels"] = tokenized["input_ids"].copy()
        return tokenized

    tokenized = dataset.map(format_row, remove_columns=dataset.column_names)

    load_kwargs = {
        "torch_dtype": torch_dtype,
        "device_map": "auto",
    }
    if quantization_config is not None:
        load_kwargs["quantization_config"] = quantization_config

    model = AutoModelForCausalLM.from_pretrained(config.base_model_path, **load_kwargs)

    # Resolve target modules — auto-detect if set to "auto" or not provided
    configured_targets = training.get("targetModules", "auto")
    if configured_targets == "auto" or not configured_targets:
        target_modules = detect_target_modules(model)
    else:
        target_modules = list(configured_targets)
        print(f"[unlearning] using configured target modules: {target_modules}")

    lora_config = LoraConfig(
        r=int(training["loraRank"]),
        lora_alpha=int(training["loraAlpha"]),
        lora_dropout=float(training["loraDropout"]),
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=target_modules,
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    use_gradient_checkpointing = bool(training.get("gradientCheckpointing", quantization_config is not None))

    training_args = TrainingArguments(
        output_dir=config.adapter_output_dir,
        overwrite_output_dir=True,
        learning_rate=float(training["learningRate"]),
        num_train_epochs=float(training["epochs"]),
        per_device_train_batch_size=int(training["batchSize"]),
        gradient_accumulation_steps=int(training["gradAccumulation"]),
        gradient_checkpointing=use_gradient_checkpointing,
        save_strategy="epoch",
        logging_steps=5,
        bf16=use_bf16,
        fp16=use_fp16,
        remove_unused_columns=False,
        report_to=[],
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized,
        data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False),
    )
    trainer.train()
    trainer.save_model(config.adapter_output_dir)
    tokenizer.save_pretrained(config.adapter_output_dir)

    summary = {
        "ok": True,
        "adapterOutputDir": config.adapter_output_dir,
        "trainCount": len(dataset),
        "baseModelPath": config.base_model_path,
        "precision": precision_label,
        "targetModules": target_modules,
        "quantized": quantization_config is not None,
        "gradientCheckpointing": use_gradient_checkpointing,
    }
    with open(os.path.join(config.adapter_output_dir, "training-summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
