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
        return ["planning", "web", "workspace-read"];
    if (role === "coder")
        return ["workspace-read", "workspace-write", "exec"];
    return ["workspace-read", "exec"];
}
function defaultSkillsForRole(role) {
    if (role === "executive")
        return ["project-planning", "client-communication", "qa-testing"];
    if (role === "coder")
        return ["frontend-build", "ui-styling", "debugging", "component-design"];
    return ["deployment", "maintenance", "qa-testing", "research"];
}
function defaultProviderForRole(role) {
    return role === "runner" ? "ollama" : "openclaw";
}
function modelRoleForTeamRole(role) {
    if (role === "executive")
        return "executive";
    if (role === "coder")
        return "coder";
    return "fast";
}
function defaultModelForRole(role, models) {
    return models[modelRoleForTeamRole(role)];
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
    return [
        {
            id: "agent-manager",
            name: "Project Manager",
            role: "executive",
            lotId: "world",
            posX: 120,
            posY: 120,
            provider: defaultProviderForRole("executive"),
            model: defaultModelForRole("executive", models),
            tools: defaultToolsForRole("executive"),
            skills: defaultSkillsForRole("executive"),
            notes: "Project manager for website direction, task breakdown, and final review.",
            lastBrief: "",
            lastResponse: "",
            state: "idle",
            presence: "idle",
            workspacePath: projectRoot,
            repoBranch: "",
            memoryPath: path.join(controlRoot, "data", "agents", "agent-manager", "memory.db"),
            isManager: true,
            createdAt: now,
            updatedAt: now
        },
        {
            id: "agent-frontend",
            name: "Frontend Builder",
            role: "coder",
            lotId: "world",
            posX: 340,
            posY: 120,
            provider: defaultProviderForRole("coder"),
            model: defaultModelForRole("coder", models),
            tools: defaultToolsForRole("coder"),
            skills: defaultSkillsForRole("coder"),
            notes: "Builds pages, components, styling, responsive UI, and frontend fixes.",
            lastBrief: "",
            lastResponse: "",
            state: "idle",
            presence: "idle",
            workspacePath: projectRoot,
            repoBranch: "",
            memoryPath: path.join(controlRoot, "data", "agents", "agent-frontend", "memory.db"),
            isManager: false,
            createdAt: now,
            updatedAt: now
        },
        {
            id: "agent-backend",
            name: "Backend Builder",
            role: "coder",
            lotId: "world",
            posX: 560,
            posY: 120,
            provider: defaultProviderForRole("coder"),
            model: defaultModelForRole("coder", models),
            tools: defaultToolsForRole("coder"),
            skills: ["form-wiring", "debugging", "qa-testing", "frontend-build"],
            notes: "Builds APIs, form handling, integrations, validation, and backend logic.",
            lastBrief: "",
            lastResponse: "",
            state: "idle",
            presence: "idle",
            workspacePath: projectRoot,
            repoBranch: "",
            memoryPath: path.join(controlRoot, "data", "agents", "agent-backend", "memory.db"),
            isManager: false,
            createdAt: now,
            updatedAt: now
        },
        {
            id: "agent-researcher",
            name: "Code Researcher",
            role: "executive",
            lotId: "world",
            posX: 780,
            posY: 120,
            provider: defaultProviderForRole("executive"),
            model: defaultModelForRole("executive", models),
            tools: ["workspace-read", "web", "planning"],
            skills: ["research", "library-scouting", "project-planning", "client-communication"],
            notes: "Scouts implementation options, docs, code patterns, references, and technical risks before build work.",
            lastBrief: "",
            lastResponse: "",
            state: "idle",
            presence: "idle",
            workspacePath: projectRoot,
            repoBranch: "",
            memoryPath: path.join(controlRoot, "data", "agents", "agent-researcher", "memory.db"),
            isManager: false,
            createdAt: now,
            updatedAt: now
        },
        {
            id: "agent-environment",
            name: "Environment Artist",
            role: "coder",
            lotId: "world",
            posX: 1000,
            posY: 120,
            provider: defaultProviderForRole("coder"),
            model: defaultModelForRole("coder", models),
            tools: ["workspace-read", "workspace-write", "planning"],
            skills: ["environment-design", "worldbuilding", "prop-dressing", "ui-styling"],
            notes: "Owns worldbuilding, environmental mood, props, references, and visual cohesion for expandable scenes.",
            lastBrief: "",
            lastResponse: "",
            state: "idle",
            presence: "idle",
            workspacePath: projectRoot,
            repoBranch: "",
            memoryPath: path.join(controlRoot, "data", "agents", "agent-environment", "memory.db"),
            isManager: false,
            createdAt: now,
            updatedAt: now
        }
    ];
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
        for (const entry of this.agents) {
            if (entry.id !== agent.id && entry.state === "active") {
                entry.state = "idle";
            }
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
        this.agents = [];
        await fs.rm(this.agentsDir, { recursive: true, force: true });
        await fs.mkdir(this.agentsDir, { recursive: true });
        await this.save();
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
        const requestedModel = String(input.model || current?.model || "").trim();
        const normalizedModel = requestedModel && !isPlaceholderModel(requestedModel)
            ? requestedModel
            : defaultModelForRole(role, this.baseConfig.models);
        return {
            id,
            name: String(input.name || current?.name || "New Agent").trim() || "New Agent",
            role,
            lotId: String(input.lotId || current?.lotId || "world"),
            posX: Number.isFinite(Number(input.posX)) ? Number(input.posX) : Number(current?.posX ?? position.x),
            posY: Number.isFinite(Number(input.posY)) ? Number(input.posY) : Number(current?.posY ?? position.y),
            provider: input.provider === "ollama" || input.provider === "openclaw"
                ? input.provider
                : (current?.provider || defaultProviderForRole(role)),
            model: normalizedModel,
            tools: Array.isArray(input.tools) && input.tools.length
                ? input.tools.map((tool) => String(tool))
                : (current?.tools?.length ? [...current.tools] : defaultToolsForRole(role)),
            skills: Array.isArray(input.skills) && input.skills.length
                ? input.skills.map((skill) => String(skill))
                : (current?.skills?.length ? [...current.skills] : defaultSkillsForRole(role)),
            notes: String(input.notes || current?.notes || ""),
            lastBrief: String(input.lastBrief || current?.lastBrief || ""),
            lastResponse: String(input.lastResponse || current?.lastResponse || ""),
            state: String(input.state || current?.state || "idle"),
            presence: String(input.presence || current?.presence || "idle"),
            workspacePath,
            repoBranch: String(input.repoBranch || current?.repoBranch || ""),
            memoryPath,
            isManager: Boolean(input.isManager ?? current?.isManager ?? false),
            createdAt,
            updatedAt: Date.now()
        };
    }
    async save() {
        await fs.mkdir(path.dirname(this.registryPath), { recursive: true });
        await fs.writeFile(this.registryPath, JSON.stringify({ agents: this.agents }, null, 2), "utf8");
    }
}
