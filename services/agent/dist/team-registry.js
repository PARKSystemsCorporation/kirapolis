// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KiraBrain } from "./kira/brain.js";
function defaultPosition(index) {
    const columns = 6;
    const col = index % columns;
    const row = Math.floor(index / columns);
    return {
        x: 120 + col * 220,
        y: 120 + row * 180
    };
}
function defaultToolsForRole(role) {
    if (role === "executive")
        return ["planning", "web", "workspace-read", "exec"];
    if (role === "coder")
        return ["workspace-read", "workspace-write", "exec", "planning", "web"];
    return ["workspace-read", "exec", "planning", "web"];
}
function defaultSkillsForRole(role) {
    if (role === "executive")
        return ["project-planning", "client-communication", "qa-testing", "unknown-exploration", "systems-design", "world-strategy", "mmo-roadmapping"];
    if (role === "coder")
        return ["frontend-build", "ui-styling", "debugging", "component-design", "technical-research", "rapid-prototyping", "asset-pipeline", "multiplayer-thinking"];
    return ["deployment", "maintenance", "qa-testing", "research", "creative-support", "worldbuilding-support", "live-ops"];
}
function defaultProviderForRole(role) {
    return role === "runner" ? "ollama" : "openclaw";
}
function preferredNeutralizedModel(models) {
    return Object.values(models || {}).find((model) => /neutral-reset/i.test(String(model || ""))) || "";
}
function modelRoleForTeamRole(role) {
    if (role === "executive")
        return "executive";
    if (role === "coder")
        return "coder";
    return "fast";
}
function defaultModelForRole(role, models, provider = "") {
    const neutralized = preferredNeutralizedModel(models);
    if (provider === "ollama" && neutralized) {
        return neutralized;
    }
    return models[modelRoleForTeamRole(role)] || neutralized || "";
}
function slugify(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "agent";
}
function normalizeRole(input) {
    return input === "executive" || input === "coder" || input === "runner" ? input : "runner";
}
function isPlaceholderModel(model) {
    return model === "openclaw/executive" || model === "openclaw/coder" || model === "ollama/fast";
}
function createSeedAgents(controlRoot, projectRoot, models) {
    const now = Date.now();
    const specs = [
        {
            id: "agent-ceo",
            name: "CEO",
            role: "executive",
            tools: ["planning", "workspace-read", "web"],
            skills: ["executive-direction", "project-planning", "systems-thinking", "client-communication", "unknown-exploration", "world-strategy", "mmo-roadmapping"],
            notes: "Sets product direction, evaluates the evolving environment, and keeps the closed-loop system aligned with the project goals and long-horizon world platform.",
            isManager: true
        },
        {
            id: "agent-manager",
            name: "Project Manager",
            role: "executive",
            tools: ["planning", "workspace-read", "web"],
            skills: ["project-planning", "delivery-management", "qa-testing", "client-communication", "systems-design", "mmo-roadmapping"],
            notes: "Breaks down work, coordinates rooms, reviews progress, and keeps the current website path compatible with a future downloadable world."
        },
        {
            id: "agent-researcher",
            name: "Code Researcher",
            role: "executive",
            tools: ["workspace-read", "web", "planning"],
            skills: ["research", "library-scouting", "technical-risk-analysis", "project-planning", "unknown-exploration", "engine-evaluation", "multiplayer-research"],
            notes: "Researches code patterns, engines, tooling, references, and implementation tradeoffs for the next build cycle and future MMO evolution."
        },
        {
            id: "agent-frontend",
            name: "Frontend Builder",
            role: "coder",
            tools: ["workspace-read", "workspace-write", "exec"],
            skills: ["frontend-build", "ui-styling", "component-design", "responsive-layout", "rapid-prototyping", "ux-systems", "player-journey-design"],
            notes: "Builds pages, interaction surfaces, UI structure, and player-facing layout for the evolving website and eventual launcher-grade experience."
        },
        {
            id: "agent-backend",
            name: "Backend Builder",
            role: "coder",
            tools: ["workspace-read", "workspace-write", "exec"],
            skills: ["api-design", "form-wiring", "validation", "debugging", "persistence-design", "world-state-thinking", "service-architecture"],
            notes: "Builds APIs, integrations, validation, persistence, and runtime support for the website system with a path toward persistent world services."
        },
        {
            id: "agent-threejs",
            name: "Three.js Builder",
            role: "coder",
            tools: ["workspace-read", "workspace-write", "exec"],
            skills: ["threejs", "webgl", "shader-work", "scene-architecture", "world-streaming", "interaction-design", "realtime-prototyping"],
            notes: "Owns Three.js scenes, rendering pipelines, lighting, camera systems, and 3D interactions, with an eye toward explorable world-scale spaces."
        },
        {
            id: "agent-babylon",
            name: "Babylon.js Expert",
            role: "coder",
            tools: ["workspace-read", "workspace-write", "exec"],
            skills: ["babylonjs", "realtime-rendering", "performance-optimization", "scene-tooling", "engine-evaluation", "downloadable-world-thinking", "realtime-systems"],
            notes: "Evaluates and builds Babylon.js-based scene systems, engine comparisons, and performance alternatives for both browser and eventual downloadable world tracks."
        },
        {
            id: "agent-environment",
            name: "Environment Artist",
            role: "coder",
            tools: ["workspace-read", "workspace-write", "planning"],
            skills: ["environment-design", "worldbuilding", "prop-dressing", "visual-cohesion", "biome-thinking", "spatial-storytelling", "content-scaling"],
            notes: "Shapes the evolving environment, mood, layout, props, and spatial storytelling so the website can grow naturally into a larger explorable world."
        },
        {
            id: "agent-image",
            name: "Image Creator",
            role: "runner",
            tools: ["workspace-read", "planning", "web"],
            skills: ["concept-art-direction", "image-prompting", "visual-reference-curation", "style-guides", "creative-discovery", "faction-style-development", "world-culture-design"],
            notes: "Creates image direction, concept prompts, mood boards, and references that help the team discover unknown visual directions without losing cohesion."
        },
        {
            id: "agent-github",
            name: "GitHub Launcher",
            role: "runner",
            tools: ["workspace-read", "exec", "planning"],
            skills: ["git-ops", "release-management", "deployment", "documentation", "build-pipeline-thinking", "launcher-readiness"],
            notes: "Owns git status, commits, pushes, release notes, and launch coordination after verification passes, including future packaging readiness."
        },
        {
            id: "agent-maintenance",
            name: "Code Maintenance",
            role: "runner",
            tools: ["workspace-read", "workspace-write", "exec"],
            skills: ["maintenance", "cleanup", "refactoring", "qa-testing", "system-hygiene", "prototype-hardening"],
            notes: "Keeps the codebase clean, removes dead files, fixes regressions, and improves the handoff quality between agents as the world grows more complex."
        },
        {
            id: "agent-qa",
            name: "QA And Launch",
            role: "runner",
            tools: ["workspace-read", "exec", "planning"],
            skills: ["qa-testing", "verification", "performance-audits", "release-readiness", "playability-review", "stability-gating"],
            notes: "Runs the final checks, validates environment quality, and feeds failures back into the loop before launch, always protecting playability and stability."
        },
        {
            id: "agent-postdeploy-monitor",
            name: "Post Deploy Monitor",
            role: "runner",
            tools: ["workspace-read", "exec", "planning", "web"],
            skills: ["deployment", "runtime-monitoring", "incident-triage", "release-readiness", "log-analysis", "railway-ops", "handoff-reporting"],
            notes: "Monitors post-deployment health, deployment incidents, Railway webhook reports, and runtime regressions, then relays concrete findings back to the team."
        },
        {
            id: "agent-visual-analyst",
            name: "Post Deploy Visual Analyst",
            role: "runner",
            tools: ["workspace-read", "planning", "web", "exec"],
            skills: ["visual-qa", "ux-regression-review", "cross-device-auditing", "release-readiness", "playability-review", "screenshot-analysis"],
            notes: "Checks the deployed experience visually after release, looks for layout regressions and broken journeys, and reports what changed in plain language for the team."
        }
    ];
    return specs.map((spec, index) => {
        const position = defaultPosition(index);
        return {
            id: spec.id,
            name: spec.name,
            role: spec.role,
            lotId: "world",
            posX: position.x,
            posY: position.y,
            provider: defaultProviderForRole(spec.role),
            model: defaultModelForRole(spec.role, models, defaultProviderForRole(spec.role)),
            tools: spec.tools,
            skills: spec.skills,
            notes: spec.notes,
            lastBrief: "",
            lastResponse: "",
            state: "idle",
            presence: "idle",
            workspacePath: projectRoot,
            repoBranch: "",
            memoryPath: path.join(controlRoot, "data", "agents", spec.id, "memory.db"),
            isManager: Boolean(spec.isManager),
            createdAt: now,
            updatedAt: now
        };
    });
}
function mergeUnique(primary, fallback) {
    return Array.from(new Set([...(Array.isArray(primary) ? primary : []), ...(Array.isArray(fallback) ? fallback : [])].filter(Boolean).map((entry) => String(entry))));
}
export class TeamRegistry {
    baseConfig;
    registryPath;
    agentsDir;
    brains = new Map();
    agents = [];
    constructor(baseConfig) {
        this.baseConfig = baseConfig;
        this.agentsDir = path.join(baseConfig.controlRoot, "data", "agents");
        this.registryPath = path.join(this.agentsDir, "registry.json");
    }
    async init() {
        await fs.mkdir(this.agentsDir, { recursive: true });
        try {
            const raw = await fs.readFile(this.registryPath, "utf8");
            const parsed = JSON.parse(raw);
            this.agents = this.normalizeAgents(Array.isArray(parsed.agents) ? parsed.agents : []);
        }
        catch {
            this.agents = this.normalizeAgents(createSeedAgents(this.baseConfig.controlRoot, this.baseConfig.projectRoot, this.baseConfig.models));
            await this.save();
        }
    }
    list() {
        return this.agents.map((agent) => ({ ...agent, tools: [...agent.tools], skills: [...agent.skills] }));
    }
    get(agentId) {
        const agent = this.agents.find((entry) => entry.id === agentId);
        return agent ? { ...agent, tools: [...agent.tools], skills: [...agent.skills] } : null;
    }
    async replaceAll(agents) {
        this.agents = this.normalizeAgents(Array.isArray(agents) ? agents : []);
        await this.save();
        return this.list();
    }
    async upsert(partial) {
        const current = partial.id ? this.agents.find((entry) => entry.id === partial.id) : null;
        const normalized = this.normalizeAgent(partial, current || undefined, this.agents.filter((entry) => entry.id !== partial.id));
        if (current) {
            const index = this.agents.findIndex((entry) => entry.id === current.id);
            this.agents[index] = normalized;
        }
        else {
            this.agents.push(normalized);
        }
        await this.save();
        return { ...normalized, tools: [...normalized.tools], skills: [...normalized.skills] };
    }
    async getBrain(agentId) {
        const agent = this.agents.find((entry) => entry.id === agentId);
        if (!agent) {
            throw new Error("agent not found");
        }
        let brain = this.brains.get(agent.id);
        if (!brain) {
            brain = new KiraBrain({
                ...this.baseConfig,
                workspaceRoot: agent.workspacePath,
                memoryPath: agent.memoryPath
            });
            await brain.init();
            this.brains.set(agent.id, brain);
        }
        return brain;
    }
    async recordDispatch(agentId, brief, response) {
        const agent = this.agents.find((entry) => entry.id === agentId);
        if (!agent) {
            throw new Error("agent not found");
        }
        agent.lastBrief = brief;
        agent.lastResponse = response;
        agent.state = "active";
        agent.updatedAt = Date.now();
        await this.save();
        return { ...agent, tools: [...agent.tools], skills: [...agent.skills] };
    }
    buildAgentConfig(agentId) {
        const agent = this.agents.find((entry) => entry.id === agentId);
        if (!agent) {
            throw new Error("agent not found");
        }
        return {
            ...this.baseConfig,
            workspaceRoot: agent.workspacePath,
            memoryPath: agent.memoryPath,
            provider: agent.provider,
            models: {
                executive: agent.model || defaultModelForRole("executive", this.baseConfig.models),
                coder: agent.model || defaultModelForRole("coder", this.baseConfig.models),
                fast: agent.model || defaultModelForRole("runner", this.baseConfig.models)
            }
        };
    }
    async wipeSandbox() {
        this.brains.clear();
        this.agents = this.normalizeAgents([]);
        await fs.rm(this.agentsDir, { recursive: true, force: true });
        await fs.mkdir(this.agentsDir, { recursive: true });
        await this.save();
    }
    async resetMemories() {
        this.brains.clear();
        for (const agent of this.agents) {
            try {
                await fs.rm(agent.memoryPath, { force: true });
            }
            catch { }
        }
    }
    normalizeAgents(agents) {
        const result = [];
        for (const entry of agents) {
            result.push(this.normalizeAgent(entry, undefined, result));
        }
        if (!result.length) {
            return createSeedAgents(this.baseConfig.controlRoot, this.baseConfig.projectRoot, this.baseConfig.models);
        }
        if (!result.some((agent) => agent.isManager)) {
            result[0].isManager = true;
        }
        return result;
    }
    normalizeAgent(source, current, existingAgents) {
        const input = source && typeof source === "object" ? source : {};
        const role = normalizeRole(input.role ?? current?.role);
        const id = String(input.id || current?.id || `${slugify(String(input.name || current?.name || role))}-${randomUUID().slice(0, 8)}`);
        const createdAt = Number(input.createdAt || current?.createdAt || Date.now());
        const position = defaultPosition(existingAgents.length);
        const workspacePath = path.resolve(this.baseConfig.projectRoot);
        const memoryPath = path.resolve(path.join(this.agentsDir, id, "memory.db"));
        const provider = input.provider === "ollama" || input.provider === "openclaw"
            ? input.provider
            : (current?.provider || defaultProviderForRole(role));
        const requestedModel = String(input.model || current?.model || "").trim();
        const normalizedModel = requestedModel && !isPlaceholderModel(requestedModel)
            ? requestedModel
            : defaultModelForRole(role, this.baseConfig.models, provider);
        return {
            id,
            name: String(input.name || current?.name || "New Agent").trim() || "New Agent",
            role,
            lotId: String(input.lotId || current?.lotId || "world"),
            posX: Number.isFinite(Number(input.posX)) ? Number(input.posX) : Number(current?.posX ?? position.x),
            posY: Number.isFinite(Number(input.posY)) ? Number(input.posY) : Number(current?.posY ?? position.y),
            provider,
            model: normalizedModel,
            tools: mergeUnique(Array.isArray(input.tools) && input.tools.length
                ? input.tools.map((tool) => String(tool))
                : (current?.tools?.length ? [...current.tools] : []), defaultToolsForRole(role)),
            skills: mergeUnique(Array.isArray(input.skills) && input.skills.length
                ? input.skills.map((skill) => String(skill))
                : (current?.skills?.length ? [...current.skills] : []), defaultSkillsForRole(role)),
            notes: String(input.notes || current?.notes || ""),
            lastBrief: String(input.lastBrief || current?.lastBrief || ""),
            lastResponse: String(input.lastResponse || current?.lastResponse || ""),
            state: String(input.state || current?.state || "idle"),
            presence: String(input.presence || current?.presence || "idle"),
            workspacePath,
            repoBranch: String(input.repoBranch || current?.repoBranch || ""),
            memoryPath,
            personaId: String(input.personaId || current?.personaId || ""),
            usePersonaModel: Boolean(input.usePersonaModel ?? current?.usePersonaModel ?? true),
            isManager: Boolean(input.isManager ?? current?.isManager ?? false),
            createdAt,
            updatedAt: Date.now()
        };
    }
    async remove(agentId) {
        const index = this.agents.findIndex((entry) => entry.id === agentId);
        if (index === -1) {
            return false;
        }
        this.agents.splice(index, 1);
        this.brains.delete(agentId);
        await fs.rm(path.join(this.agentsDir, agentId), { recursive: true, force: true });
        await this.save();
        return true;
    }
    async save() {
        await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
        await fs.writeFile(this.registryPath, JSON.stringify({ agents: this.agents }, null, 2), "utf8");
    }
}
