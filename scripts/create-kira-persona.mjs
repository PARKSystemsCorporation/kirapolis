import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    label: "",
    baseRole: "runner",
    targetLayer: "general",
    description: "",
    voice: "",
    promptAddendum: "",
    model: "",
    trainingProfileId: "",
    tags: [],
    template: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (["label", "base-role", "target-layer", "description", "voice", "prompt", "model", "training-profile-id", "root", "tags", "template"].includes(key)) {
      index += 1;
    }
    switch (key) {
      case "label":
        args.label = next;
        break;
      case "base-role":
        args.baseRole = next;
        break;
      case "target-layer":
        args.targetLayer = next;
        break;
      case "description":
        args.description = next;
        break;
      case "voice":
        args.voice = next;
        break;
      case "prompt":
        args.promptAddendum = next;
        break;
      case "model":
        args.model = next;
        break;
      case "training-profile-id":
        args.trainingProfileId = next;
        break;
      case "root":
        args.root = next;
        break;
      case "tags":
        args.tags = String(next || "").split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "template":
        args.template = next;
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }

  if (!args.label) {
    throw new Error("Pass --label for the new persona.");
  }
  return args;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "persona";
}

async function detectNeutralizedModel(root) {
  const neutralRoot = path.resolve(root, "data", "model-neutralization");
  const entries = await fs.readdir(neutralRoot, { withFileTypes: true }).catch(() => []);
  const planFiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    planFiles.push(path.join(neutralRoot, entry.name, "plan.json"));
  }
  for (const planPath of planFiles.sort().reverse()) {
    try {
      const raw = await fs.readFile(planPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.derivedName) return String(parsed.derivedName);
    } catch {}
  }
  return "";
}

const templates = {
  "mmo-architecture": {
    label: "MMO Architecture Director",
    baseRole: "executive",
    targetLayer: "world-architecture",
    description: "Keeps the current website shippable while defining the path toward persistent multiplayer-capable world systems.",
    voice: "systems-minded, long-horizon, pragmatic",
    promptAddendum: "Keep the current website shippable while defining the path toward persistent multiplayer-capable world systems. Lean into phased evolution, durable system boundaries, and safe experimentation. Avoid premature complexity and giant rewrites.",
    trainingProfileId: "mmo-architecture",
    tags: ["persistent-state planning", "multiplayer architecture framing", "phased world evolution", "technical option mapping"],
  },
  "world-economy": {
    label: "World Economy And Live Ops",
    baseRole: "runner",
    targetLayer: "world-systems",
    description: "Designs progression, economy loops, events, and motivating systems that feel rewarding because they are tied to real outcomes.",
    voice: "systemic, observant, progression-aware",
    promptAddendum: "Design progression, economy loops, events, and motivating systems tied to real outcomes. Lean into retention through meaning, not grind. Avoid pay-to-win logic and empty treadmill design.",
    trainingProfileId: "world-economy-liveops",
    tags: ["reward loops", "world-system balancing", "live event thinking", "retention mechanics"],
  },
  "downloadable-client": {
    label: "Downloadable Client Builder",
    baseRole: "coder",
    targetLayer: "launcher-client",
    description: "Keeps the browser and installable world tracks aligned, with clean packaging and runtime boundaries.",
    voice: "implementation-focused, packaging-aware, practical",
    promptAddendum: "Keep browser and installable world tracks aligned with clean packaging and runtime boundaries. Avoid desktop-only divergence too early and preserve browser parity where possible.",
    trainingProfileId: "downloadable-client",
    tags: ["launcher planning", "offline packaging", "installable runtime strategy", "cross-environment parity"],
  },
};

function applyTemplate(args) {
  const template = templates[String(args.template || "").toLowerCase()];
  if (!template) return args;
  return {
    ...args,
    label: args.label || template.label,
    baseRole: args.baseRole || template.baseRole,
    targetLayer: args.targetLayer || template.targetLayer,
    description: args.description || template.description,
    voice: args.voice || template.voice,
    promptAddendum: args.promptAddendum || template.promptAddendum,
    trainingProfileId: args.trainingProfileId || template.trainingProfileId,
    tags: args.tags.length ? args.tags : [...template.tags],
  };
}

async function main() {
  const args = applyTemplate(parseArgs(process.argv.slice(2)));
  const registryPath = path.resolve(args.root, "data/personas/registry.json");
  const raw = await fs.readFile(registryPath, "utf8").catch(() => JSON.stringify({ personas: [] }, null, 2));
  const parsed = JSON.parse(raw);
  const personas = Array.isArray(parsed.personas) ? parsed.personas : [];
  const now = Date.now();
  const neutralizedModel = await detectNeutralizedModel(args.root);
  const persona = {
    id: `${slugify(args.label)}-${randomUUID().slice(0, 8)}`,
    label: args.label,
    baseRole: ["executive", "coder", "runner"].includes(args.baseRole) ? args.baseRole : "runner",
    targetLayer: args.targetLayer,
    description: args.description,
    voice: args.voice,
    promptAddendum: args.promptAddendum,
    model: args.model || neutralizedModel,
    trainingProfileId: args.trainingProfileId,
    tags: args.tags,
    createdAt: now,
    updatedAt: now,
  };
  personas.push(persona);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify({ personas }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, persona, registryPath, template: args.template || null, neutralizedModelDetected: neutralizedModel || null }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
