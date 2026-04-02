import argparse
import json
import os

import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer


PROMPT_TEMPLATE = "### User\n{prompt}\n\n### Assistant\n"


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--max-new-tokens", type=int, default=160)
    return parser.parse_args()


def load_rows(path_value):
    if not path_value or not os.path.exists(path_value):
        return []
    return list(load_dataset("json", data_files=path_value)["train"])


def evaluate_rows(model, tokenizer, rows, max_new_tokens):
    results = []
    for row in rows:
        prompt = PROMPT_TEMPLATE.format(prompt=row["prompt"])
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            output = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
        decoded = tokenizer.decode(output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
        must_include = [str(value).lower() for value in row.get("mustInclude", [])]
        must_not_include = [str(value).lower() for value in row.get("mustNotInclude", [])]
        lowered = decoded.lower()
        include_ok = all(value in lowered for value in must_include) if must_include else True
        exclude_ok = all(value not in lowered for value in must_not_include) if must_not_include else True
        results.append({
            "id": row.get("id"),
            "kind": row.get("kind"),
            "prompt": row.get("prompt"),
            "expected": row.get("response"),
            "response": decoded,
            "mustIncludeOk": include_ok,
            "mustNotIncludeOk": exclude_ok,
            "passed": include_ok and exclude_ok,
        })
    return results


def summarize(name, rows):
    if not rows:
        return {"name": name, "count": 0, "passed": 0, "passRate": None}
    passed = sum(1 for row in rows if row["passed"])
    return {"name": name, "count": len(rows), "passed": passed, "passRate": passed / len(rows)}


def main():
    args = parse_args()
    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)

    tokenizer = AutoTokenizer.from_pretrained(args.model_path, use_fast=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.model_path, torch_dtype="auto", device_map="auto")

    eval_forget = evaluate_rows(model, tokenizer, load_rows(config["files"]["evalForget"]), args.max_new_tokens)
    eval_retain = evaluate_rows(model, tokenizer, load_rows(config["files"]["evalRetain"]), args.max_new_tokens)
    eval_general = evaluate_rows(model, tokenizer, load_rows(config["files"]["evalGeneral"]), args.max_new_tokens)

    summary = {
        "ok": True,
        "modelPath": args.model_path,
        "summaries": [
            summarize("forget", eval_forget),
            summarize("retain", eval_retain),
            summarize("general", eval_general),
        ],
        "details": {
            "forget": eval_forget,
            "retain": eval_retain,
            "general": eval_general,
        },
    }
    output_path = config.get("evalOutputPath") or os.path.join(config["runRoot"], "eval-results.json")
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(summary, handle, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
