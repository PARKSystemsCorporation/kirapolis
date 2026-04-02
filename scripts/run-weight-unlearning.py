import argparse
import json
import os
from dataclasses import dataclass

from datasets import load_dataset
from peft import LoraConfig, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
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


def main():
    args = parse_args()
    config = load_config(args.config)
    os.makedirs(config.adapter_output_dir, exist_ok=True)

    dataset = load_dataset("json", data_files=config.train_path)["train"]
    tokenizer = AutoTokenizer.from_pretrained(config.base_model_path, use_fast=True)
    if tokenizer.pad_token is None:
      tokenizer.pad_token = tokenizer.eos_token

    def format_row(row):
        text = PROMPT_TEMPLATE.format(prompt=row["prompt"], response=row["response"])
        tokenized = tokenizer(
            text,
            truncation=True,
            max_length=int(config.training["maxLength"]),
            padding=False,
        )
        tokenized["labels"] = tokenized["input_ids"].copy()
        return tokenized

    tokenized = dataset.map(format_row, remove_columns=dataset.column_names)

    model = AutoModelForCausalLM.from_pretrained(
        config.base_model_path,
        torch_dtype="auto",
        device_map="auto",
    )

    lora_config = LoraConfig(
        r=int(config.training["loraRank"]),
        lora_alpha=int(config.training["loraAlpha"]),
        lora_dropout=float(config.training["loraDropout"]),
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=list(config.training["targetModules"]),
    )
    model = get_peft_model(model, lora_config)

    training_args = TrainingArguments(
        output_dir=config.adapter_output_dir,
        overwrite_output_dir=True,
        learning_rate=float(config.training["learningRate"]),
        num_train_epochs=float(config.training["epochs"]),
        per_device_train_batch_size=int(config.training["batchSize"]),
        gradient_accumulation_steps=int(config.training["gradAccumulation"]),
        save_strategy="epoch",
        logging_steps=5,
        bf16=False,
        fp16=False,
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
    }
    with open(os.path.join(config.adapter_output_dir, "training-summary.json"), "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
