import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    name: "",
    role: "runner",
    provider: "",
    model: "",
    personaId: "",
    usePersonaModel: true,
    notes: "",
    tools: [],
    skills: [],
    isManager: false,
    template: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (["root", "name", "role", "provider", "model", "persona-id", "notes", "tools", "skills", "template"].includes(key)) {
      index += 1;
    }
    switch (key) {
      case "root":
        args.root = next;
        break;
      case "name":
        args.name = next;
        break;
      case "role":
        args.role = next;
        break;
      case "provider":
        args.provider = next;
        break;
      case "model":
        args.model = next;
        break;
      case "persona-id":
        args.personaId = next;
        break;
      case "notes":
        args.notes = next;
        break;
      case "tools":
        args.tools = String(next || "").split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "skills":
        args.skills = String(next || "").split(",").map((item) => item.trim()).filter(Boolean);
        break;
      case "template":
        args.template = next;
        break;
      case "manager":
        args.isManager = true;
        break;
      case "no-persona-model":
        args.usePersonaModel = false;
        break;
      default:
        throw new Error(`Unknown argument: --${key}`);
    }
  }

  if (!args.name) {
    throw new Error("Pass --name for the new agent.");
  }
  return args;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "agent";
}

function defaultTools(role) {
  if (role === "executive") return ["planning", "workspace-read", "web", "exec"];
  if (role === "coder") return ["workspace-read", "workspace-write", "exec", "planning", "web"];
  return ["workspace-read", "exec", "planning", "web"];
}

function defaultSkills(role) {
  if (role === "executive") return ["project-planning", "client-communication", "unknown-exploration", "systems-design"];
  if (role === "coder") return ["implementation", "debugging", "technical-research", "rapid-prototyping"];
  return ["verification", "maintenance", "research", "creative-support"];
}

function mergeUnique(primary, fallback) {
  return Array.from(new Set([...(primary || []), ...(fallback || [])].filter(Boolean).map((entry) => String(entry))));
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
  "mmo-architect": {
    role: "executive",
    provider: "ollama",
    personaId: "mmo-architecture",
    notes: "Guides the phased path from immersive browser site to persistent downloadable world systems.",
    tools: ["planning", "workspace-read", "web", "exec"],
    skills: ["mmo-roadmapping", "world-strategy", "persistent-state planning", "unknown-exploration"],
  },
  "world-economy": {
    role: "runner",
    provider: "ollama",
    personaId: "world-economy-liveops",
    notes: "Owns progression loops, economy framing, events, retention, and live world motivation design.",
    tools: ["workspace-read", "planning", "web", "exec"],
    skills: ["reward loops", "world-system balancing", "live event thinking", "retention mechanics"],
  },
  "downloadable-client": {
    role: "coder",
    provider: "ollama",
    personaId: "downloadable-client",
    notes: "Keeps browser and installable client tracks aligned and packaging-ready over time.",
    tools: ["workspace-read", "workspace-write", "exec", "planning", "web"],
    skills: ["launcher planning", "offline packaging", "installable runtime strategy", "cross-environment parity"],
  },
  "post-deploy-monitor": {
    role: "runner",
    provider: "ollama",
    personaId: "",
    notes: "Monitors deployments, Railway incidents, runtime failures, and post-release regressions, then relays them back into the team loop.",
    tools: ["workspace-read", "exec", "planning", "web"],
    skills: ["deployment", "runtime-monitoring", "incident-triage", "railway-ops", "release-readiness", "handoff-reporting"],
  },
  "post-deploy-visual": {
    role: "runner",
    provider: "ollama",
    personaId: "",
    notes: "Runs visual post-deployment audits against the live site and reports UX regressions, clipped layouts, and broken flows.",
    tools: ["workspace-read", "planning", "web", "exec"],
    skills: ["visual-qa", "ux-regression-review", "cross-device-auditing", "release-readiness", "screenshot-analysis"],
  },
};

function applyTemplate(args) {
  const template = templates[String(args.template || "").toLowerCase()];
  if (!template) return args;
  return {
    ...args,
    role: args.role || template.role,
    provider: args.provider || template.provider,
    personaId: args.personaId || template.personaId,
    notes: args.notes || template.notes,
    tools: args.tools.length ? args.tools : [...template.tools],
    skills: args.skills.length ? args.skills : [...template.skills],
  };
}

async function main() {
  const args = applyTemplate(parseArgs(process.argv.slice(2)));
  const registryPath = path.resolve(args.root, "data/agents/registry.json");
  const raw = await fs.readFile(registryPath, "utf8");
  const parsed = JSON.parse(raw);
  const agents = Array.isArray(parsed.agents) ? parsed.agents : [];
  const id = `${slugify(args.name)}-${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const role = ["executive", "coder", "runner"].includes(args.role) ? args.role : "runner";
  const neutralizedModel = await detectNeutralizedModel(args.root);
  const provider = args.provider || (role === "runner" ? "ollama" : "openclaw");
  const workspacePath = path.resolve(process.env.KIRA_PROJECT_ROOT || args.root);
  const agent = {
    id,
    name: args.name,
    role,
    lotId: "world",
    posX: 120,
    posY: 120,
    provider,
    model: args.model || (provider === "ollama" ? neutralizedModel : ""),
    tools: mergeUnique(args.tools.length ? args.tools : [], defaultTools(role)),
    skills: mergeUnique(args.skills.length ? args.skills : [], defaultSkills(role)),
    notes: args.notes,
    lastBrief: "",
    lastResponse: "",
    state: "idle",
    presence: "idle",
    workspacePath,
    repoBranch: "",
    memoryPath: path.resolve(args.root, "data/agents", id, "memory.db"),
    personaId: args.personaId,
    usePersonaModel: args.usePersonaModel,
    isManager: args.isManager,
    createdAt: now,
    updatedAt: now,
  };
  agents.push(agent);
  await fs.writeFile(registryPath, JSON.stringify({ agents }, null, 2), "utf8");
  console.log(JSON.stringify({
    ok: true,
    agent,
    template: args.template || null,
    neutralizedModelDetected: neutralizedModel || null,
    note: "Each agent keeps its own memory DB path under data/agents/<agent-id>/memory.db once the backend initializes it.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
