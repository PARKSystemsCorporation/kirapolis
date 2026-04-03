// @ts-nocheck
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { getConfig } from "./config.js";
import { DashboardStore } from "./dashboard-store.js";
import { KiraBrain } from "./kira/brain.js";
import { KiraLearningLoop } from "./kira/learning-loop.js";
import { runKiraChat } from "./kira/kira-runtime.js";
import { PersonaRegistry } from "./persona-registry.js";
import { getLevelFormulaText, ProgressionStore } from "./progression-store.js";
import { TeamRegistry } from "./team-registry.js";
const config = getConfig();
const runtimeSettings = {
    provider: config.provider,
    ollamaBaseUrl: config.ollamaBaseUrl,
    openClawBaseUrl: config.openClawBaseUrl,
    models: { ...config.models }
};
const app = express();
const baseBrain = new KiraBrain(config);
const personaRegistry = new PersonaRegistry(config.controlRoot);
const teamRegistry = new TeamRegistry(config);
const dashboardStore = new DashboardStore(config.controlRoot);
const progressionStore = new ProgressionStore(config.controlRoot);
let learningLoop;
let teamHeartbeat;
let msgIdCounter = 0;
function nextMsgId() { return `msg-${Date.now()}-${++msgIdCounter}`; }
const experienceMemory = {
    agents: {},
    links: [],
    pulses: []
};
const modelLabRuntime = {
    running: false,
    startedAt: 0,
    finishedAt: 0,
    currentRun: null,
    logEntries: [],
    process: null,
    lastResult: null
};
const weightUnlearningRuntime = {
    running: false,
    phase: "",
    startedAt: 0,
    finishedAt: 0,
    currentJob: null,
    logEntries: [],
    process: null,
    lastResult: null
};
function getModelLabExecutionLabel() {
    const target = String(config.modelLabExecutionTarget || "local").toLowerCase();
    if (target === "railway") {
        return "Railway backend";
    }
    const machine = String(config.modelLabMachineLabel || "this computer").trim();
    return machine ? `local computer (${machine})` : "local computer";
}
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});
const accessPassword = String(process.env.KIRA_ACCESS_PASSWORD || "").trim();
if (accessPassword) {
    app.use((req, res, next) => {
        if (req.method === "OPTIONS") {
            return next();
        }
        // Allow health check without auth for uptime monitors
        if (req.path === "/health") {
            return next();
        }
        // Check Authorization header (Basic auth)
        const authHeader = String(req.headers.authorization || "");
        if (authHeader.startsWith("Basic ")) {
            const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
            const [, password] = decoded.split(":");
            if (password === accessPassword) {
                return next();
            }
        }
        // Check query param fallback for simple links
        if (req.query.token === accessPassword) {
            return next();
        }
        // Check cookie for browser sessions
        const cookies = String(req.headers.cookie || "");
        const match = cookies.match(/(?:^|;\s*)kira_token=([^;]*)/);
        if (match && match[1] === accessPassword) {
            return next();
        }
        // If browser request, show login prompt
        res.set("WWW-Authenticate", 'Basic realm="Kirapolis"');
        return res.status(401).send("Authentication required");
    });
    // Login endpoint that sets a cookie so the browser stays authenticated
    app.post("/api/login", express.json(), (req, res) => {
        const password = String(req.body?.password || "").trim();
        if (password === accessPassword) {
            res.set("Set-Cookie", `kira_token=${accessPassword}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
            return res.json({ ok: true });
        }
        return res.status(401).json({ error: "wrong password" });
    });
}
function describeError(error) {
    if (error && typeof error === "object") {
        const maybeError = error;
        const cause = maybeError.cause && typeof maybeError.cause === "object"
            ? maybeError.cause
            : null;
        const code = String(cause?.code || cause?.errno || maybeError.code || maybeError.errno || "").trim();
        const message = String(cause?.message || maybeError.message || "unknown error").trim();
        return code ? `${code}: ${message}` : message;
    }
    return String(error || "unknown error");
}

const sharedDesktopSettingsPath = path.join(config.controlRoot, "data", "desktop-settings.json");

async function loadSharedDesktopSettings() {
    try {
        const raw = await fs.readFile(sharedDesktopSettingsPath, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}

async function saveSharedDesktopSettings(input) {
    const current = await loadSharedDesktopSettings();
    const next = {
        ...current,
        ...input
    };
    await fs.mkdir(path.dirname(sharedDesktopSettingsPath), { recursive: true });
    await fs.writeFile(sharedDesktopSettingsPath, JSON.stringify(next, null, 2), "utf8");
    return next;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}

async function collectRepoSummary(rootPath) {
    const insideTree = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], rootPath);
    if (insideTree.code !== 0 || !insideTree.stdout.trim().includes("true")) {
        return {
            ok: false,
            branch: "",
            remote: "",
            status: insideTree.stderr.trim() || insideTree.stdout.trim() || "Not a git repository."
        };
    }
    const branch = await runCommand("git", ["branch", "--show-current"], rootPath);
    const remote = await runCommand("git", ["remote", "get-url", "origin"], rootPath);
    const status = await runCommand("git", ["status", "--short", "--branch"], rootPath);
    return {
        ok: true,
        branch: branch.stdout.trim(),
        remote: remote.code === 0 ? remote.stdout.trim() : "",
        status: `${status.stdout}${status.stderr}`.trim() || "Working tree clean."
    };
}

async function createSystemBackupSnapshot() {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    const backupRoot = path.join(config.controlRoot, "data", "backups", timestamp);
    const copied = [];
    await fs.mkdir(backupRoot, { recursive: true });
    const copyItem = async (sourcePath, relativeTarget) => {
        if (!(await pathExists(sourcePath))) {
            return;
        }
        const destinationPath = path.join(backupRoot, relativeTarget);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.cp(sourcePath, destinationPath, { recursive: true });
        copied.push(relativeTarget.replace(/\\/g, "/"));
    };
    await copyItem(path.join(config.controlRoot, "data", "dashboard-state.json"), path.join("data", "dashboard-state.json"));
    await copyItem(path.join(config.controlRoot, "data", "desktop-settings.json"), path.join("data", "desktop-settings.json"));
    await copyItem(path.join(config.controlRoot, "data", "personas"), path.join("data", "personas"));
    await copyItem(path.join(config.controlRoot, "data", "agents", "registry.json"), path.join("data", "agents", "registry.json"));
    await copyItem(path.join(config.controlRoot, "data", "agents"), path.join("data", "agents"));
    const repoSummary = await collectRepoSummary(config.projectRoot);
    const manifest = {
        createdAt: Date.now(),
        backupRoot,
        projectRoot: config.projectRoot,
        copied,
        repo: repoSummary
    };
    await fs.writeFile(path.join(backupRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return manifest;
}

async function resumeAutomationAfterReset(options) {
    const heartbeatStatus = options?.heartbeatStatus || (teamHeartbeat ? teamHeartbeat.getStatus() : { active: false });
    const learningStatus = options?.learningStatus || (learningLoop ? learningLoop.getStatus() : { active: false });
    await progressionStore.ensureAgents(teamRegistry.list());
    await ensurePostDeploySpecialists();
    await ensureLocalSpecialists();
    await ensureDefaultGroupChat();
    await ensurePostDeployGroupChat();
    await ensureLocalWorkbenchGroupChat();
    if (heartbeatStatus.active) {
        await teamHeartbeat.start(heartbeatStatus.intervalMs, heartbeatStatus.maxAgentsPerCycle);
    }
    if (learningStatus.active && learningStatus.topic) {
        await learningLoop.start(learningStatus.topic, learningStatus.intervalMs, learningStatus.maxCycles ?? 10);
    }
}

function getReachableUrls() {
    const interfaces = os.networkInterfaces();
    const urls = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (!entry || entry.family !== "IPv4" || entry.internal) {
                continue;
            }
            urls.push(`http://${entry.address}:${config.port}/app`);
        }
    }
    return [...new Set(urls)];
}

function withProgression(agent) {
    const progression = progressionStore.get(agent?.id || "");
    return progression ? {
        ...agent,
        progression
    } : {
        ...agent,
        progression: null
    };
}

function listAgentsWithProgression() {
    const agents = teamRegistry.list();
    return agents.map((agent) => withProgression(agent));
}

async function buildOfficeSnapshot() {
    const heartbeat = teamHeartbeat.getStatus();
    const agents = listAgentsWithProgression().sort((left, right) => {
        const starDelta = Number(right.progression?.stars || 1) - Number(left.progression?.stars || 1);
        if (starDelta)
            return starDelta;
        return Number(right.progression?.level || 1) - Number(left.progression?.level || 1);
    });
    const board = dashboardStore.getState();
    const projectFiles = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceFile);
    const projectNotes = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
    const controlNotes = config.controlRoot !== config.projectRoot
        ? prefixWorkspaceIndexItems(await buildWorkspaceIndex(config.controlRoot, shouldIncludeWorkspaceNote), "__control__")
        : [];
    const notes = [...projectNotes, ...controlNotes].sort((left, right) => right.updatedAt - left.updatedAt);
    const tasks = board.tasks || [];
    const summary = {
        agentCount: agents.length,
        activeAgents: agents.filter((agent) => ["active", "typing", "waiting"].includes(String(agent.presence || agent.state || "").toLowerCase())).length,
        completedTasks: tasks.filter((task) => task.status === "done").length,
        doingTasks: tasks.filter((task) => task.status === "doing").length,
        blockedTasks: tasks.filter((task) => task.status === "blocked").length,
        roomCount: board.messenger?.chats?.length || 0,
        latestActivityAt: Number(board.activity?.[0]?.createdAt || 0),
        latestNoteAt: Number(notes[0]?.updatedAt || 0),
        latestFileAt: Number(projectFiles.sort((left, right) => right.updatedAt - left.updatedAt)[0]?.updatedAt || 0),
        autonomyActive: Boolean(heartbeat.active),
        autonomyDetail: String(heartbeat.lastDetail || ""),
        autonomyIntervalMs: Number(heartbeat.intervalMs || 0)
    };
    return {
        agents,
        chats: board.messenger?.chats || [],
        tasks,
        activity: board.activity || [],
        files: projectFiles.sort((left, right) => left.path.localeCompare(right.path)),
        notes,
        summary,
        formula: getLevelFormulaText()
    };
}
function buildExperienceSignalsFromSnapshot(snapshot) {
    const now = Date.now();
    const hotRooms = (snapshot.chats || [])
        .map((chat) => {
        const count = Array.isArray(chat.messages) ? chat.messages.length : 0;
        const lastMessage = count ? chat.messages[count - 1] : null;
        const ageMs = lastMessage?.createdAt ? Math.max(0, now - Number(lastMessage.createdAt)) : Number.POSITIVE_INFINITY;
        const tone = count >= 12 || ageMs < 10 * 60 * 1000
            ? "hot"
            : count >= 5 || ageMs < 45 * 60 * 1000
                ? "warm"
                : "cool";
        return {
            id: String(chat.id || ""),
            title: String(chat.title || "Room"),
            tone,
            messageCount: count,
            lastMessageAt: Number(lastMessage?.createdAt || 0)
        };
    })
        .sort((left, right) => right.messageCount - left.messageCount);
    const blockedTasks = (snapshot.tasks || []).filter((task) => task.status === "blocked");
    const doingTasks = (snapshot.tasks || []).filter((task) => task.status === "doing");
    const blockedAgentIds = Array.from(new Set(blockedTasks
        .map((task) => String(task.agentId || ""))
        .filter(Boolean)));
    const activeAgentIds = Array.from(new Set((snapshot.agents || [])
        .filter((agent) => ["active", "typing", "working", "executing", "waiting"].includes(String(agent.presence || agent.state || "").toLowerCase()))
        .map((agent) => String(agent.id || ""))
        .filter(Boolean)));
    const promotionEvents = (snapshot.activity || [])
        .slice()
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .filter((entry) => ["promotion", "progression"].includes(String(entry.source || "").toLowerCase()) || /promotion/i.test(String(entry.title || "")))
        .filter((entry) => now - Number(entry.createdAt || 0) <= 15 * 60 * 1000)
        .slice(0, 6)
        .map((entry) => ({
        agentId: String(entry.agentId || ""),
        agentName: String(entry.agentName || ""),
        title: String(entry.title || "Promotion update"),
        createdAt: Number(entry.createdAt || 0)
    }));
    const promotedAgentIds = Array.from(new Set(promotionEvents.map((entry) => entry.agentId).filter(Boolean)));
    const recentActivity = (snapshot.activity || []).filter((entry) => now - Number(entry.createdAt || 0) <= 15 * 60 * 1000);
    const recentCompletions = recentActivity.filter((entry) => String(entry.status || "").toLowerCase() === "done");
    const momentumScore = Math.max(0, Math.min(100, Math.round((activeAgentIds.length * 9)
        + (doingTasks.length * 7)
        + (recentCompletions.length * 6)
        + (promotionEvents.length * 8)
        - (blockedTasks.length * 11))));
    const momentumLabel = momentumScore >= 72
        ? "Overdrive"
        : momentumScore >= 48
            ? "Flow"
            : momentumScore >= 24
                ? "Steady"
                : "Cold Start";
    const spotlightAgent = [...(snapshot.agents || [])]
        .sort((left, right) => {
        const promotedDelta = Number(promotedAgentIds.includes(String(right.id || ""))) - Number(promotedAgentIds.includes(String(left.id || "")));
        if (promotedDelta)
            return promotedDelta;
        const activeDelta = Number(activeAgentIds.includes(String(right.id || ""))) - Number(activeAgentIds.includes(String(left.id || "")));
        if (activeDelta)
            return activeDelta;
        return Number(right.progression?.level || 1) - Number(left.progression?.level || 1);
    })[0];
    const nextPromotionCandidate = [...(snapshot.agents || [])]
        .filter((agent) => Number(agent.progression?.stars || 1) < 3)
        .sort((left, right) => Number(left.progression?.xpRemaining || Number.MAX_SAFE_INTEGER) - Number(right.progression?.xpRemaining || Number.MAX_SAFE_INTEGER))[0];
    const roomAssignments = new Map();
    const rankedRooms = hotRooms.length ? hotRooms : (snapshot.chats || []).map((chat) => ({
        id: String(chat.id || ""),
        title: String(chat.title || "Room"),
        tone: "cool",
        messageCount: Array.isArray(chat.messages) ? chat.messages.length : 0,
        lastMessageAt: Number(chat.messages?.[chat.messages.length - 1]?.createdAt || 0)
    }));
    (snapshot.agents || []).forEach((agent, index) => {
        const role = String(agent.role || "").toLowerCase();
        const agentId = String(agent.id || "");
        const taskList = (snapshot.tasks || []).filter((task) => String(task.agentId || "") === agentId);
        const doingCount = taskList.filter((task) => task.status === "doing").length;
        const blockedCount = taskList.filter((task) => task.status === "blocked").length;
        const active = activeAgentIds.includes(agentId);
        const selectedRoom = rankedRooms.length
            ? rankedRooms[role === "executive"
                ? 0
                : role === "runner"
                    ? Math.min(1, rankedRooms.length - 1)
                    : index % rankedRooms.length]
            : null;
        let behavior = "idle";
        let targetZone = role === "executive" ? "command" : role === "coder" ? "build" : "comms";
        let intensity = 0.35;
        let reason = "Holding position";
        if (blockedCount) {
            behavior = "blocked";
            targetZone = "ops";
            intensity = 0.98;
            reason = "Blocked task needs intervention";
        }
        else if (doingCount > 0 && role === "coder") {
            behavior = "building";
            targetZone = "build";
            intensity = Math.min(1, 0.52 + doingCount * 0.18);
            reason = `${doingCount} active build task${doingCount === 1 ? "" : "s"}`;
        }
        else if (selectedRoom && (selectedRoom.tone === "hot" || selectedRoom.tone === "warm") && (role === "executive" || role === "runner" || active)) {
            behavior = role === "executive" ? "syncing" : "social";
            targetZone = "comms";
            intensity = selectedRoom.tone === "hot" ? 0.92 : 0.68;
            reason = `${selectedRoom.title} is active`;
        }
        else if (active) {
            behavior = role === "executive" ? "reviewing" : "researching";
            targetZone = role === "executive" ? "command" : "preview";
            intensity = 0.58;
            reason = role === "executive" ? "Reviewing team progress" : "Exploring next moves";
        }
        else if (String(agent.presence || agent.state || "").toLowerCase() === "waiting") {
            behavior = "waiting";
            targetZone = "notes";
            intensity = 0.44;
            reason = "Waiting for the next handoff";
        }
        if (selectedRoom?.id) {
            roomAssignments.set(agentId, selectedRoom.id);
        }
        const previous = experienceMemory.agents[agentId] || null;
        experienceMemory.agents[agentId] = {
            agentId,
            behavior,
            targetZone,
            intensity,
            reason,
            roomId: selectedRoom?.id || previous?.roomId || "",
            roomTitle: selectedRoom?.title || previous?.roomTitle || "",
            since: previous?.behavior === behavior && previous?.roomId === (selectedRoom?.id || "")
                ? Number(previous.since || now)
                : now
        };
    });
    const behaviorStates = (snapshot.agents || []).map((agent) => ({
        agentId: String(agent.id || ""),
        agentName: String(agent.name || agent.id || "Agent"),
        role: String(agent.role || "agent"),
        ...experienceMemory.agents[String(agent.id || "")],
        isPromoted: promotedAgentIds.includes(String(agent.id || "")),
        isBlocked: blockedAgentIds.includes(String(agent.id || ""))
    }));
    const socialLinks = [];
    const roomGroups = new Map();
    behaviorStates.forEach((state) => {
        if (!state.roomId || !["social", "syncing", "reviewing"].includes(String(state.behavior || ""))) {
            return;
        }
        const list = roomGroups.get(state.roomId) || [];
        list.push(state);
        roomGroups.set(state.roomId, list);
    });
    roomGroups.forEach((members, roomId) => {
        const roomTitle = members[0]?.roomTitle || hotRooms.find((room) => room.id === roomId)?.title || "Room";
        for (let index = 0; index < members.length - 1; index += 1) {
            socialLinks.push({
                id: `${roomId}:${members[index].agentId}:${members[index + 1].agentId}`,
                roomId,
                roomTitle,
                agentIds: [members[index].agentId, members[index + 1].agentId],
                strength: Math.max(members[index].intensity || 0.4, members[index + 1].intensity || 0.4),
                behavior: "conversation"
            });
        }
    });
    experienceMemory.links = socialLinks;
    const completionEvents = recentCompletions
        .slice()
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, 6)
        .map((entry) => ({
        id: String(entry.id || `${entry.agentId || "activity"}:${entry.createdAt || now}`),
        type: "completion",
        agentId: String(entry.agentId || ""),
        agentName: String(entry.agentName || ""),
        title: String(entry.title || "Task completed"),
        createdAt: Number(entry.createdAt || 0)
    }));
    const blockerEvents = blockedTasks
        .slice(0, 6)
        .map((task) => ({
        id: String(task.id || `${task.agentId || "task"}:blocked`),
        type: "blocker",
        agentId: String(task.agentId || ""),
        agentName: String((snapshot.agents || []).find((agent) => String(agent.id || "") === String(task.agentId || ""))?.name || ""),
        title: String(task.title || "Blocked task"),
        createdAt: Number(task.updatedAt || task.createdAt || now)
    }));
    const pulseEvents = [...promotionEvents.map((entry) => ({ ...entry, type: "promotion" })), ...completionEvents, ...blockerEvents]
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, 12);
    experienceMemory.pulses = pulseEvents;
    const behaviorSummary = behaviorStates.reduce((summary, entry) => {
        const key = String(entry.behavior || "idle");
        summary[key] = Number(summary[key] || 0) + 1;
        return summary;
    }, {});
    const ambientState = pulseEvents[0]?.type === "promotion"
        ? { mode: "celebration", label: "Celebration", detail: pulseEvents[0].title }
        : blockedTasks.length
            ? { mode: "alert", label: "Alert", detail: `${blockedTasks.length} blocker${blockedTasks.length === 1 ? "" : "s"} need attention.` }
            : hotRooms[0]?.tone === "hot"
                ? { mode: "surge", label: "Surge", detail: `${hotRooms[0].title} is pulling team attention.` }
                : momentumLabel === "Overdrive"
                    ? { mode: "flow", label: "Overdrive", detail: "The team is shipping smoothly right now." }
                    : { mode: "steady", label: "Steady", detail: "The loop is running without a major spike." };
    const files = Array.isArray(snapshot.files) ? snapshot.files : [];
    const notes = Array.isArray(snapshot.notes) ? snapshot.notes : [];
    const milestoneBosses = [
        {
            id: "browser-foundation",
            label: "Browser Foundation",
            state: files.some((entry) => /(^|\/)index\.html$/i.test(String(entry.path || ""))) ? "cleared" : "active",
            detail: "The base website shell and entry surface must stay reliable."
        },
        {
            id: "immersive-scene",
            label: "Immersive Scene",
            state: files.some((entry) => /(three|babylon|app\.js|scene)/i.test(String(entry.path || ""))) ? "cleared" : "active",
            detail: "The world needs a live atmospheric scene that feels worth entering."
        },
        {
            id: "persistent-state",
            label: "Persistent State",
            state: files.some((entry) => /(server|api|state|progression)/i.test(String(entry.path || ""))) ? "building" : "locked",
            detail: "Shared world state, identity, and durable systems should arrive gradually."
        },
        {
            id: "social-layer",
            label: "Social Layer",
            state: (snapshot.chats || []).length > 1 || notes.some((entry) => /(multiplayer|social|party|guild)/i.test(String(entry.path || ""))) ? "building" : "locked",
            detail: "Presence, rooms, parties, and coordination loops should become player-facing later."
        },
        {
            id: "downloadable-world",
            label: "Downloadable World",
            state: files.some((entry) => /(launcher|electron|client|download)/i.test(String(entry.path || ""))) ? "building" : "locked",
            detail: "The installable client track should stay compatible with the browser path."
        }
    ];
    const questBoard = [];
    const nextBoss = milestoneBosses.find((boss) => boss.state !== "cleared");
    const directorScenarios = [];
    if (blockedTasks.length) {
        directorScenarios.push({
            id: "director-blocker-drill",
            kind: "blocker-drill",
            priority: "critical",
            title: "Blocker Drill",
            detail: `${blockedTasks.length} blocked task${blockedTasks.length === 1 ? "" : "s"} are dragging the loop.`,
            recommendation: "Pull managers and support runners into ops, then free the blocked builder path first.",
            targetAgentIds: blockedAgentIds,
            targetRoomId: hotRooms[0]?.id || "",
            durationMs: 20000
        });
    }
    if (pulseEvents[0]?.type === "promotion") {
        directorScenarios.push({
            id: "director-promotion-celebration",
            kind: "promotion",
            priority: "high",
            title: "Promotion Celebration",
            detail: pulseEvents[0].title,
            recommendation: "Let the floor celebrate briefly, then redirect momentum back into active delivery.",
            targetAgentIds: promotedAgentIds,
            targetRoomId: hotRooms[0]?.id || "",
            durationMs: 18000
        });
    }
    if (hotRooms[0]?.tone === "hot") {
        directorScenarios.push({
            id: "director-hot-room",
            kind: "hot-room",
            priority: "high",
            title: "Hot Room Surge",
            detail: `${hotRooms[0].title} is absorbing the most team energy.`,
            recommendation: "Cluster nearby operators around the active room and keep preview plus notes close for context.",
            targetAgentIds: behaviorStates.filter((entry) => entry.roomId === hotRooms[0].id).map((entry) => entry.agentId),
            targetRoomId: hotRooms[0].id,
            durationMs: 22000
        });
    }
    if (nextBoss && nextBoss.state !== "cleared") {
        directorScenarios.push({
            id: `director-boss-${nextBoss.id}`,
            kind: "milestone-push",
            priority: "medium",
            title: `Milestone Push: ${nextBoss.label}`,
            detail: nextBoss.detail,
            recommendation: "Bias preview, build, and review traffic toward the next milestone until it visibly advances.",
            targetAgentIds: behaviorStates.filter((entry) => ["building", "reviewing", "researching"].includes(String(entry.behavior || ""))).map((entry) => entry.agentId),
            targetRoomId: "",
            durationMs: 30000
        });
    }
    if (!directorScenarios.length) {
        directorScenarios.push({
            id: "director-steady-loop",
            kind: "steady-loop",
            priority: "normal",
            title: "Steady Loop",
            detail: "The system is stable enough to optimize for quality and polish.",
            recommendation: "Keep builders moving, let managers review, and maintain light social clustering.",
            targetAgentIds: behaviorStates.map((entry) => entry.agentId),
            targetRoomId: hotRooms[0]?.id || "",
            durationMs: 24000
        });
    }
    const primaryScenario = directorScenarios[0];
    const directorMode = {
        label: primaryScenario.title,
        detail: primaryScenario.detail,
        recommendation: primaryScenario.recommendation,
        scenarios: directorScenarios,
        startedAt: now,
        durationMs: Number(primaryScenario.durationMs || 20000),
        targetAgentIds: primaryScenario.targetAgentIds || [],
        targetRoomId: primaryScenario.targetRoomId || "",
        ambientMode: ambientState.mode
    };
    if (nextBoss) {
        questBoard.push({
            id: `boss-${nextBoss.id}`,
            kind: "boss",
            title: `Advance ${nextBoss.label}`,
            detail: nextBoss.detail
        });
    }
    if (hotRooms[0]) {
        questBoard.push({
            id: `hot-room-${hotRooms[0].id}`,
            kind: "room",
            title: `Stabilize ${hotRooms[0].title}`,
            detail: `${hotRooms[0].messageCount} messages are piling up in the hottest room.`
        });
    }
    if (blockedTasks[0]) {
        questBoard.push({
            id: `blocked-${blockedTasks[0].id || blockedTasks[0].agentId}`,
            kind: "blocker",
            title: `Clear ${String(blockedTasks[0].title || "blocked task")}`,
            detail: `A blocked task is holding momentum back right now.`
        });
    }
    if (nextPromotionCandidate) {
        questBoard.push({
            id: `promotion-${nextPromotionCandidate.id}`,
            kind: "promotion",
            title: `Push ${String(nextPromotionCandidate.name || nextPromotionCandidate.id)} to the next level`,
            detail: `${Number(nextPromotionCandidate.progression?.xpRemaining || 0)} XP from the next level.`
        });
    }
    return {
        generatedAt: now,
        syncPulseToken: `${Math.floor(now / 5000)}:${hotRooms.filter((room) => room.tone === "hot").length}:${blockedTasks.length}:${promotionEvents.length}`,
        summary: {
            agentCount: snapshot.summary?.agentCount || snapshot.agents.length,
            activeAgents: snapshot.summary?.activeAgents || activeAgentIds.length,
            roomCount: snapshot.summary?.roomCount || snapshot.chats.length,
            doingTasks: snapshot.summary?.doingTasks || doingTasks.length,
            blockedTasks: snapshot.summary?.blockedTasks || blockedTasks.length,
            completedTasks: snapshot.summary?.completedTasks || 0
        },
        momentum: {
            score: momentumScore,
            label: momentumLabel,
            recentActivityCount: recentActivity.length,
            recentCompletionCount: recentCompletions.length
        },
        spotlight: spotlightAgent ? {
            agentId: String(spotlightAgent.id || ""),
            agentName: String(spotlightAgent.name || spotlightAgent.id || "Operator"),
            reason: promotedAgentIds.includes(String(spotlightAgent.id || ""))
                ? "Fresh promotion pulse"
                : activeAgentIds.includes(String(spotlightAgent.id || ""))
                    ? "Driving the live loop"
                    : "Highest current progression"
        } : null,
        milestoneBosses,
        questBoard,
        hotRooms,
        blockedTasks: blockedTasks.map((task) => ({
            id: String(task.id || ""),
            title: String(task.title || ""),
            agentId: String(task.agentId || ""),
            updatedAt: Number(task.updatedAt || task.createdAt || 0)
        })),
        behaviorStates,
        behaviorSummary,
        socialLinks,
        pulseEvents,
        ambientState,
        directorMode,
        blockedAgentIds,
        activeAgentIds,
        promotionEvents,
        promotedAgentIds
    };
}
async function buildExperienceSignals() {
    return buildExperienceSignalsFromSnapshot(await buildOfficeSnapshot());
}
function clipText(value, max = 220) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) {
        return "";
    }
    return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}
async function broadcastScopedMemory(agentIds, payload) {
    const uniqueIds = Array.from(new Set((agentIds || []).filter(Boolean).map((item) => String(item))));
    for (const agentId of uniqueIds) {
        try {
            const brain = await teamRegistry.getBrain(agentId);
            await brain.storeMemoryItem(payload);
        }
        catch {
        }
    }
}
async function broadcastRoomMemory(chatId, title, memberIds, message) {
    const content = clipText(message?.content || "", 220);
    if (!content) {
        return;
    }
    await broadcastScopedMemory(memberIds, {
        kind: "summary",
        subject: `${title} room update`,
        summary: `${message?.author || "Agent"} in ${title}: ${content}`,
        detail: `Room ${chatId} update from ${message?.author || "Agent"}.`,
        tags: ["room", chatId, title, message?.role || "assistant"].filter(Boolean),
        scopeType: "room",
        scopeId: chatId,
        sourceRole: message?.role || "system",
        confidence: 0.74,
        salience: 0.84
    });
}

async function awardAgentTaskCompletion(agentId, taskId, detail = "") {
    const agent = teamRegistry.get(agentId);
    if (!agent || !taskId) {
        return null;
    }
    const result = await progressionStore.awardTaskCompletion(agent, taskId, detail);
    const agentBrain = await teamRegistry.getBrain(agent.id);
    await agentBrain.recordEpisode({
        title: `Completed task ${taskId}`,
        action: `Finished task for ${agent.name}`,
        outcome: detail || "Task marked done.",
        nextStep: "Reuse the strongest tactic and keep the handoff concrete.",
        scopeType: "agent",
        scopeId: agent.id,
        source: "task-completion",
        sourceRole: "system"
    });
    await broadcastScopedMemory(teamRegistry.list().map((entry) => entry.id), {
        kind: "task",
        subject: `Project task completion ${taskId}`,
        summary: `${agent.name} completed ${taskId}`,
        detail: clipText(detail || "Task completed.", 220),
        tags: ["task", "project", "completion", agent.id],
        scopeType: "project",
        scopeId: "global",
        sourceRole: "system",
        confidence: 0.86,
        salience: 0.9
    });
    if (result?.awarded) {
        await dashboardStore.addActivity({
            source: "progression",
            agentId: agent.id,
            agentName: agent.name,
            status: "done",
            title: result.promoted ? `${agent.name} earned a promotion` : `${agent.name} gained experience`,
            detail: result.promoted
                ? `+${result.xpAwarded} XP | Level ${result.progression.level} | Promoted to ${result.progression.stars} star${result.progression.stars === 1 ? "" : "s"}`
                : `+${result.xpAwarded} XP | Level ${result.progression.level} | ${result.progression.rankLabel}`
        });
    }
    return result;
}
async function fetchJson(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`);
        }
        return await response.json();
    }
    catch (error) {
        throw new Error(describeError(error));
    }
}
async function getProviderStatus() {
    const ollama = {
        name: "ollama",
        url: runtimeSettings.ollamaBaseUrl,
        ok: false,
        detail: "unreachable"
    };
    const openclaw = {
        name: "openclaw",
        url: runtimeSettings.openClawBaseUrl,
        ok: false,
        detail: "unreachable"
    };
    try {
        const version = await fetchJson(`${runtimeSettings.ollamaBaseUrl}/api/version`);
        ollama.ok = true;
        ollama.detail = version.version ? `version ${version.version}` : "reachable";
    }
    catch (error) {
        ollama.detail = describeError(error);
    }
    try {
        const models = await fetchJson(`${runtimeSettings.openClawBaseUrl}/v1/models`);
        openclaw.ok = true;
        openclaw.detail = `${models.data?.length || 0} model(s) visible`;
    }
    catch (error) {
        openclaw.detail = describeError(error);
    }
    return {
        active: runtimeSettings.provider,
        providers: {
            ollama,
            openclaw
        }
    };
}
async function getProviderModels() {
    const result = {
        active: runtimeSettings.provider,
        ollama: [],
        openclaw: []
    };
    try {
        const data = await fetchJson(`${runtimeSettings.ollamaBaseUrl}/api/tags`);
        result.ollama = (data.models || [])
            .map((item) => item.name || item.model || "")
            .filter(Boolean);
    }
    catch { }
    try {
        const data = await fetchJson(`${runtimeSettings.openClawBaseUrl}/v1/models`);
        result.openclaw = (data.data || [])
            .map((item) => item.id || "")
            .filter(Boolean);
    }
    catch { }
    return result;
}
async function runCommand(command, args, cwd) {
    return await runCommandWithEnv(command, args, cwd);
}
async function runCommandWithEnv(command, args, cwd, extraEnv = {}) {
    return await new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            env: {
                ...process.env,
                ...extraEnv
            },
            shell: false
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += String(chunk);
        });
        child.on("error", (error) => {
            resolve({
                code: 1,
                stdout,
                stderr: `${stderr}${stderr ? "\n" : ""}${describeError(error)}`
            });
        });
        child.on("close", (code) => {
            resolve({
                code: code ?? 0,
                stdout,
                stderr
            });
        });
    });
}
function parseEnvText(raw) {
    const result = {};
    for (const line of String(raw || "").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }
        const index = trimmed.indexOf("=");
        if (index <= 0) {
            continue;
        }
        const key = trimmed.slice(0, index).trim();
        const value = trimmed.slice(index + 1).trim();
        if (!key) {
            continue;
        }
        result[key] = value;
    }
    return result;
}
async function postJson(url, body) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify(body || {})
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            throw new Error(`${response.status} ${detail}`.trim());
        }
        return await response.json();
    }
    catch (error) {
        throw new Error(describeError(error));
    }
}
function getModelLabRoot() {
    return path.join(config.controlRoot, "data", "model-lab");
}
function getModelLabPresetsPath() {
    return path.join(getModelLabRoot(), "presets.json");
}
function getModelLabStagedSamplesPath() {
    return path.join(getModelLabRoot(), "staged-samples.json");
}
function getWeightUnlearningRoot() {
    return path.join(config.controlRoot, "data", "weight-unlearning");
}
function getNeutralizationRoot() {
    return path.join(config.controlRoot, "data", "model-neutralization");
}
function pushModelLabLog(source, message) {
    const text = String(message || "")
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/\r/g, "")
        .trim();
    if (!text) {
        return;
    }
    const createdAt = Date.now();
    const entries = text.split("\n").map((line) => ({
        id: `lab-log-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        source,
        message: line
    }));
    modelLabRuntime.logEntries.push(...entries);
    if (modelLabRuntime.logEntries.length > 600) {
        modelLabRuntime.logEntries = modelLabRuntime.logEntries.slice(-600);
    }
}
function serializeModelLabRuntime() {
    return {
        running: modelLabRuntime.running,
        startedAt: modelLabRuntime.startedAt || 0,
        finishedAt: modelLabRuntime.finishedAt || 0,
        currentRun: modelLabRuntime.currentRun || null,
        lastResult: modelLabRuntime.lastResult || null,
        logEntries: modelLabRuntime.logEntries.slice(-240)
    };
}
function pushWeightUnlearningLog(source, message) {
    const text = String(message || "")
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
        .replace(/\r/g, "")
        .trim();
    if (!text) {
        return;
    }
    const createdAt = Date.now();
    const entries = text.split("\n").map((line) => ({
        id: `weight-log-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt,
        source,
        message: line
    }));
    weightUnlearningRuntime.logEntries.push(...entries);
    if (weightUnlearningRuntime.logEntries.length > 800) {
        weightUnlearningRuntime.logEntries = weightUnlearningRuntime.logEntries.slice(-800);
    }
}
function serializeWeightUnlearningRuntime() {
    return {
        running: weightUnlearningRuntime.running,
        phase: weightUnlearningRuntime.phase || "",
        startedAt: weightUnlearningRuntime.startedAt || 0,
        finishedAt: weightUnlearningRuntime.finishedAt || 0,
        currentJob: weightUnlearningRuntime.currentJob || null,
        lastResult: weightUnlearningRuntime.lastResult || null,
        logEntries: weightUnlearningRuntime.logEntries.slice(-240)
    };
}
async function collectModelLabPresets() {
    const presetsPath = getModelLabPresetsPath();
    if (!(await pathExists(presetsPath))) {
        return [];
    }
    try {
        const raw = await fs.readFile(presetsPath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.presets) ? parsed.presets : [];
    }
    catch {
        return [];
    }
}
async function saveModelLabPresets(presets) {
    const presetsPath = getModelLabPresetsPath();
    await fs.mkdir(path.dirname(presetsPath), { recursive: true });
    await fs.writeFile(presetsPath, JSON.stringify({ presets }, null, 2), "utf8");
}
async function collectStagedTrainingSamples() {
    const stagedPath = getModelLabStagedSamplesPath();
    if (!(await pathExists(stagedPath))) {
        return [];
    }
    try {
        const raw = await fs.readFile(stagedPath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.stagedSamples) ? parsed.stagedSamples : [];
    }
    catch {
        return [];
    }
}
async function saveStagedTrainingSamples(stagedSamples) {
    const stagedPath = getModelLabStagedSamplesPath();
    await fs.mkdir(path.dirname(stagedPath), { recursive: true });
    await fs.writeFile(stagedPath, JSON.stringify({ stagedSamples }, null, 2), "utf8");
}
async function collectWeightUnlearningDatasets(limit = 12) {
    const root = path.join(getWeightUnlearningRoot(), "datasets");
    if (!(await pathExists(root))) {
        return [];
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    const datasets = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const manifestPath = path.join(root, entry.name, "manifest.json");
        if (!(await pathExists(manifestPath))) continue;
        try {
            const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
            datasets.push({
                id: entry.name,
                datasetName: String(manifest.datasetName || entry.name),
                root: path.join(root, entry.name),
                createdAt: Number(new Date(manifest.createdAt || 0)) || 0,
                counts: manifest.counts || {}
            });
        }
        catch {
        }
    }
    return datasets.sort((left, right) => right.createdAt - left.createdAt).slice(0, limit);
}
async function collectWeightUnlearningRuns(limit = 12) {
    const root = path.join(getWeightUnlearningRoot(), "runs");
    if (!(await pathExists(root))) {
        return [];
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const runRoot = path.join(root, entry.name);
        const configPath = path.join(runRoot, "config.json");
        if (!(await pathExists(configPath))) continue;
        try {
            const configJson = JSON.parse(await fs.readFile(configPath, "utf8"));
            const trainingSummaryPath = path.join(configJson.adapterOutputDir, "training-summary.json");
            const mergeSummaryPath = path.join(configJson.mergedOutputDir, "merge-summary.json");
            const evalSummaryPath = configJson.evalOutputPath || path.join(runRoot, "eval-results.json");
            runs.push({
                id: entry.name,
                runRoot,
                createdAt: Number(new Date(configJson.createdAt || 0)) || 0,
                baseModelPath: String(configJson.baseModelPath || ""),
                datasetRoot: String(configJson.datasetRoot || ""),
                adapterOutputDir: String(configJson.adapterOutputDir || ""),
                mergedOutputDir: String(configJson.mergedOutputDir || ""),
                configPath,
                phases: {
                    trained: await pathExists(trainingSummaryPath),
                    merged: await pathExists(mergeSummaryPath),
                    evaluated: await pathExists(evalSummaryPath)
                }
            });
        }
        catch {
        }
    }
    return runs.sort((left, right) => right.createdAt - left.createdAt).slice(0, limit);
}
function summarizeModelInfo(details) {
    const info = details?.model_info && typeof details.model_info === "object"
        ? details.model_info
        : {};
    const entries = Object.entries(info)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .slice(0, 14)
        .map(([key, value]) => ({
        key,
        value: typeof value === "number" ? String(value) : String(value)
    }));
    return entries;
}
function firstNonEmptyLine(value) {
    return String(value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || "";
}
async function collectNeutralizationRuns(limit = 12) {
    const root = getNeutralizationRoot();
    if (!(await pathExists(root))) {
        return [];
    }
    const entries = await fs.readdir(root, { withFileTypes: true });
    const runs = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const runDir = path.join(root, entry.name);
        try {
            const planRaw = await fs.readFile(path.join(runDir, "plan.json"), "utf8");
            const evalRaw = await fs.readFile(path.join(runDir, "eval-suite.json"), "utf8");
            const modelfile = await fs.readFile(path.join(runDir, "Modelfile"), "utf8");
            const plan = JSON.parse(planRaw);
            const evalSuite = JSON.parse(evalRaw);
            runs.push({
                id: entry.name,
                runDir,
                createdAt: Number(new Date(plan.createdAt || 0)) || 0,
                baseModel: String(plan.baseModel || ""),
                derivedName: String(plan.derivedName || ""),
                style: String(plan.style || ""),
                traitsToSuppress: Array.isArray(plan.traitsToSuppress) ? plan.traitsToSuppress : [],
                createRequested: Boolean(plan.createRequested),
                evalPromptCount: Array.isArray(evalSuite?.prompts) ? evalSuite.prompts.length : 0,
                modelfilePreview: firstNonEmptyLine(modelfile.split("SYSTEM")[0] || modelfile)
            });
        }
        catch {
        }
    }
    return runs
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit);
}
async function collectTrainingSamples(limit = 20) {
    const root = getModelLabRoot();
    const samplesPath = path.join(root, "training-samples.jsonl");
    if (!(await pathExists(samplesPath))) {
        return [];
    }
    const raw = await fs.readFile(samplesPath, "utf8");
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    })
        .filter(Boolean)
        .slice(-limit)
        .reverse();
}
function extractJsonObject(raw) {
    const trimmed = String(raw || "").trim();
    const match = trimmed.match(/\{[\s\S]*\}$/);
    if (!match) {
        return null;
    }
    try {
        return JSON.parse(match[0]);
    }
    catch {
        return null;
    }
}
async function getModelLabStatus() {
    const models = await getProviderModels();
    const providerStatus = await getProviderStatus();
    const ollamaModels = Array.isArray(models.ollama) ? models.ollama : [];
    const selectedBaseModel = ollamaModels[0] || "";
    const baseModelDetails = selectedBaseModel
        ? await postJson(`${runtimeSettings.ollamaBaseUrl.replace(/\/$/, "")}/api/show`, { name: selectedBaseModel, verbose: true }).catch((error) => ({
            error: describeError(error)
        }))
        : null;
    const runs = await collectNeutralizationRuns();
    const trainingSamples = await collectTrainingSamples();
    const presets = await collectModelLabPresets();
    const stagedSamples = await collectStagedTrainingSamples();
    const weightUnlearningDatasets = await collectWeightUnlearningDatasets();
    const weightUnlearningRuns = await collectWeightUnlearningRuns();
    const timeline = dashboardStore.getState().activity
        .filter((entry) => String(entry.source || "").toLowerCase() === "model-lab")
        .slice()
        .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
        .slice(0, 16)
        .map((entry) => ({
        id: String(entry.id || `${entry.createdAt || 0}:${entry.title || "event"}`),
        createdAt: Number(entry.createdAt || 0),
        title: String(entry.title || "Model Lab event"),
        detail: String(entry.detail || ""),
        status: String(entry.status || "info")
    }));
    const latestSample = trainingSamples[0] || null;
    const executionTarget = String(config.modelLabExecutionTarget || "local").toLowerCase();
    const executionLabel = getModelLabExecutionLabel();
    return {
        generatedAt: Date.now(),
        environment: {
            runtimeMode: config.runtimeMode,
            modelLabExecutionTarget: executionTarget,
            modelLabExecutionLabel: executionLabel,
            modelLabMachineLabel: config.modelLabMachineLabel
        },
        providerStatus,
        models,
        neutralization: {
            baseModel: selectedBaseModel,
            baseModelInfo: baseModelDetails?.error ? [] : summarizeModelInfo(baseModelDetails),
            baseModelError: baseModelDetails?.error || "",
            templatePreview: baseModelDetails?.error ? "" : firstNonEmptyLine(baseModelDetails?.template || baseModelDetails?.modelfile || ""),
            systemPreview: baseModelDetails?.error ? "" : firstNonEmptyLine(baseModelDetails?.system || ""),
            latestRun: runs[0] || null,
            recentRuns: runs
        },
        runtime: serializeModelLabRuntime(),
        weightUnlearning: {
            runtime: serializeWeightUnlearningRuntime(),
            datasets: weightUnlearningDatasets,
            runs: weightUnlearningRuns
        },
        summaries: {
            neutralization: {
                status: modelLabRuntime.running
                    ? "running"
                    : modelLabRuntime.lastResult?.ok === false
                        ? "failed"
                        : runs[0]
                            ? "ready"
                            : "idle",
                title: modelLabRuntime.running
                    ? `Neutralizing ${modelLabRuntime.currentRun?.derivedName || "model"}`
                    : runs[0]
                        ? `Latest reset: ${runs[0].derivedName}`
                        : "No reset run yet",
                detail: modelLabRuntime.running
                    ? `${(modelLabRuntime.currentRun?.traits || []).length || 0} trait pathway${((modelLabRuntime.currentRun?.traits || []).length || 0) === 1 ? "" : "s"} targeted on ${executionLabel}.`
                    : runs[0]
                        ? `${(runs[0].traitsToSuppress || []).length || 0} stripped trait pathway${((runs[0].traitsToSuppress || []).length || 0) === 1 ? "" : "s"} | ${runs[0].evalPromptCount || 0} eval prompts | executed on ${executionLabel}.`
                        : `Choose a base model and highlight the memory or identity pathways to remove. Runs currently execute on ${executionLabel}.`
            },
            reintroduction: {
                status: stagedSamples.length ? "staged" : latestSample ? "ready" : "idle",
                title: stagedSamples.length
                    ? `${stagedSamples.length} staged reintroduction example${stagedSamples.length === 1 ? "" : "s"}`
                    : latestSample
                        ? `Latest reintroduction: ${latestSample.label || "manual-sample"}`
                        : "No reintroduction staged yet",
                detail: stagedSamples.length
                    ? "Review the staged payload, then commit it into the training dataset."
                    : latestSample
                        ? `Dataset contains ${trainingSamples.length} saved example${trainingSamples.length === 1 ? "" : "s"}.`
                        : "Stage a trigger, response, and reason before committing it into the dataset."
            }
        },
        presets,
        stagedSamples,
        timeline,
        trainingSamples
    };
}
function hasTool(agent, tool) {
    return Boolean(agent && agent.tools.includes(tool));
}
function summarizeTask(task) {
    return `${task.title}${task.detail ? `\n${task.detail}` : ""}`.trim();
}
function slugifyBranch(value) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "autonomy";
}
async function isGitRepo(cwd) {
    const insideTree = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    return insideTree.code === 0 && insideTree.stdout.trim().includes("true");
}
async function ensureGitBranch(agent, taskTitle) {
    if (!agent || !agent.workspacePath || !(await isGitRepo(agent.workspacePath))) {
        return "No git repository detected.";
    }
    const desiredBranch = (agent.repoBranch || `auto/${slugifyBranch(agent.name)}-${slugifyBranch(taskTitle)}`).replace(/^\/+/, "");
    const currentBranch = await runCommand("git", ["branch", "--show-current"], agent.workspacePath);
    if (currentBranch.code === 0 && currentBranch.stdout.trim() === desiredBranch) {
        if (agent.repoBranch !== desiredBranch) {
            await teamRegistry.upsert({ id: agent.id, repoBranch: desiredBranch });
        }
        return `On branch ${desiredBranch}.`;
    }
    const checkout = await runCommand("git", ["checkout", desiredBranch], agent.workspacePath);
    if (checkout.code !== 0) {
        const create = await runCommand("git", ["checkout", "-b", desiredBranch], agent.workspacePath);
        if (create.code !== 0) {
            throw new Error((`${checkout.stdout}${checkout.stderr}\n${create.stdout}${create.stderr}`).trim() || `Unable to switch to branch ${desiredBranch}`);
        }
    }
    await teamRegistry.upsert({ id: agent.id, repoBranch: desiredBranch });
    return `Switched to branch ${desiredBranch}.`;
}
async function readPackageScripts(cwd) {
    try {
        const packageJson = await fs.readFile(path.join(cwd, "package.json"), "utf8");
        const parsed = JSON.parse(packageJson);
        return parsed.scripts || {};
    }
    catch {
        return {};
    }
}
async function runVerification(agent, task) {
    if (!agent || !agent.workspacePath || !(await isGitRepo(agent.workspacePath))) {
        return { ok: true, detail: "No repository verification required." };
    }
    const scripts = await readPackageScripts(agent.workspacePath);
    const text = `${task.title}\n${task.detail || ""}`.toLowerCase();
    const commands = [];
    if (("build" in scripts) && /(build|launch|deploy|verify|release)/.test(text)) {
        commands.push({ label: "npm run build", args: ["run", "build"] });
    }
    if (("test" in scripts) && /(test|qa|verify|check)/.test(text)) {
        commands.push({ label: "npm test", args: ["test"] });
    }
    if (!commands.length) {
        return { ok: true, detail: "No verification command matched this task." };
    }
    const lines = [];
    for (const command of commands) {
        const result = await runCommand("npm", command.args, agent.workspacePath);
        lines.push(`${command.label}: ${result.code === 0 ? "ok" : "failed"}`);
        if (result.code !== 0) {
            return {
                ok: false,
                detail: `${lines.join(" | ")} | ${(result.stdout + result.stderr).trim().slice(0, 400)}`.trim()
            };
        }
    }
    return { ok: true, detail: lines.join(" | ") || "Verification complete." };
}
async function runPushGateVerification(agent) {
    if (!agent || !agent.workspacePath || !(await isGitRepo(agent.workspacePath))) {
        return { ok: true, detail: "No repository verification required." };
    }
    const scripts = await readPackageScripts(agent.workspacePath);
    const commands = [];
    if ("lint" in scripts) {
        commands.push({ label: "npm run lint", args: ["run", "lint"] });
    }
    if ("check" in scripts) {
        commands.push({ label: "npm run check", args: ["run", "check"] });
    }
    else if ("verify" in scripts) {
        commands.push({ label: "npm run verify", args: ["run", "verify"] });
    }
    if ("test" in scripts) {
        commands.push({ label: "npm test", args: ["test"] });
    }
    if ("build" in scripts) {
        commands.push({ label: "npm run build", args: ["run", "build"] });
    }
    if (!commands.length) {
        return { ok: true, detail: "No verification scripts configured. Push proceeded without lint/test/build gates." };
    }
    const lines = [];
    for (const command of commands) {
        const result = await runCommand("npm", command.args, agent.workspacePath);
        lines.push(`${command.label}: ${result.code === 0 ? "ok" : "failed"}`);
        if (result.code !== 0) {
            return {
                ok: false,
                detail: `${lines.join(" | ")} | ${(result.stdout + result.stderr).trim().slice(0, 700)}`.trim()
            };
        }
    }
    return { ok: true, detail: lines.join(" | ") || "Verification complete." };
}
async function autoPushAgentBranch(agent, taskTitle) {
    if (!agent || !agent.workspacePath || !(await isGitRepo(agent.workspacePath))) {
        return "No repository push performed.";
    }
    const remote = await runCommand("git", ["remote", "get-url", "origin"], agent.workspacePath);
    if (remote.code !== 0) {
        return "No git remote configured.";
    }
    const verification = await runPushGateVerification(agent);
    if (!verification.ok) {
        throw new Error(`Push blocked by verification gate. ${verification.detail}`);
    }
    const add = await runCommand("git", ["add", "-A"], agent.workspacePath);
    if (add.code !== 0) {
        throw new Error(add.stderr.trim() || "git add failed");
    }
    const message = `Auto: ${taskTitle}`.slice(0, 120);
    const commit = await runCommand("git", ["commit", "-m", message], agent.workspacePath);
    const commitOutput = `${commit.stdout}${commit.stderr}`.trim();
    const nothingToCommit = /nothing to commit|working tree clean/i.test(commitOutput);
    if (commit.code !== 0 && !nothingToCommit) {
        throw new Error(commitOutput || "git commit failed");
    }
    const branch = agent.repoBranch || (await runCommand("git", ["branch", "--show-current"], agent.workspacePath)).stdout.trim();
    if (!branch) {
        throw new Error("Could not determine git branch for push");
    }
    const push = await runCommand("git", ["push", "-u", "origin", branch], agent.workspacePath);
    if (push.code !== 0) {
        throw new Error(`${push.stdout}${push.stderr}`.trim() || "git push failed");
    }
    return `${nothingToCommit ? "No new commit was needed. Push completed." : "Changes committed and pushed."} | ${verification.detail}`;
}
async function cleanupDeletableChats() {
    const state = dashboardStore.getState();
    const now = Date.now();
    const removable = state.messenger.chats.filter((chat) => {
        if (chat.origin === "user")
            return false;
        const lastMessageAt = Array.isArray(chat.messages) && chat.messages.length ? (chat.messages[chat.messages.length - 1]?.createdAt || 0) : 0;
        return chat.lastReadAt >= lastMessageAt && lastMessageAt > 0 && now - lastMessageAt > 10 * 60 * 1000;
    });
    if (!removable.length) {
        return "No disposable chats found.";
    }
    const removeIds = new Set(removable.map((chat) => chat.id));
    await dashboardStore.setMessengerState({
        ...state.messenger,
        chats: state.messenger.chats.filter((chat) => !removeIds.has(chat.id)),
        activeChatId: removeIds.has(state.messenger.activeChatId || "") ? state.messenger.chats.find((chat) => !removeIds.has(chat.id))?.id || null : state.messenger.activeChatId,
        dismissedChatIds: Array.from(new Set([...(state.messenger.dismissedChatIds || []), ...removable.map((chat) => chat.id)]))
    });
    return `Deleted ${removable.length} non-user chat${removable.length === 1 ? "" : "s"}.`;
}
function slugifyName(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "group";
}
function safeFileStem(value) {
    return slugifyName(value).slice(0, 64) || "note";
}
function groupFolderName(chat) {
    return `${slugifyName(chat.title || "group")}-${safeFileStem(chat.id)}`;
}
function projectGroupsRoot() {
    return path.join(config.projectRoot, "data", "groups");
}
function legacyControlGroupsRoot() {
    return path.join(config.controlRoot, "data", "groups");
}
function groupFolderPath(chat) {
    return path.join(projectGroupsRoot(), groupFolderName(chat));
}
function relativeFromWorkspace(absolutePath) {
    return path.relative(config.projectRoot, absolutePath) || ".";
}
async function migrateLegacyGroupArtifacts() {
    const sourceRoot = legacyControlGroupsRoot();
    const targetRoot = projectGroupsRoot();
    let entries;
    try {
        entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    }
    catch {
        return;
    }
    await fs.mkdir(targetRoot, { recursive: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const sourcePath = path.join(sourceRoot, entry.name);
        const targetPath = path.join(targetRoot, entry.name);
        try {
            await fs.access(targetPath);
        }
        catch {
            await fs.rename(sourcePath, targetPath);
            continue;
        }
        const stack = [[sourcePath, targetPath]];
        while (stack.length) {
            const [fromDir, toDir] = stack.pop();
            await fs.mkdir(toDir, { recursive: true });
            const nested = await fs.readdir(fromDir, { withFileTypes: true });
            for (const item of nested) {
                const fromPath = path.join(fromDir, item.name);
                const toPath = path.join(toDir, item.name);
                if (item.isDirectory()) {
                    stack.push([fromPath, toPath]);
                    continue;
                }
                try {
                    await fs.access(toPath);
                }
                catch {
                    await fs.rename(fromPath, toPath);
                }
            }
        }
        await fs.rm(sourcePath, { recursive: true, force: true });
    }
    try {
        const remaining = await fs.readdir(sourceRoot);
        if (!remaining.length) {
            await fs.rm(sourceRoot, { recursive: true, force: true });
        }
    }
    catch { }
}
function recentTranscript(chat, limit = 12) {
    return (chat.messages || [])
        .slice(-limit)
        .map((message) => `${message.author}: ${message.content}`)
        .join("\n");
}
async function collectGroupArtifactFiles(currentPath, results = []) {
    let entries;
    try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const absolutePath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
            await collectGroupArtifactFiles(absolutePath, results);
            continue;
        }
        if (!/\.(md|txt)$/i.test(entry.name)) {
            continue;
        }
        results.push(absolutePath);
        if (results.length >= 80) {
            return results;
        }
    }
    return results;
}
async function listGroupArtifacts(chatId) {
    const state = dashboardStore.getState();
    const chat = state.messenger.chats.find((entry) => entry.id === chatId && entry.type === "group");
    if (!chat) {
        return [];
    }
    const root = groupFolderPath(chat);
    const files = await collectGroupArtifactFiles(root);
    const items = await Promise.all(files.map(async (absolutePath) => {
        try {
            const stats = await fs.stat(absolutePath);
            const raw = await fs.readFile(absolutePath, "utf8");
            const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
            const segments = relativePath.split("/");
            const bucket = segments[0] === "tasks" ? "task" : "note";
            const agentId = segments[1] || "";
            const agentName = teamRegistry.get(agentId)?.name || agentId;
            const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
            const preview = raw
                .replace(/^#.+$/gm, "")
                .replace(/^##.+$/gm, "")
                .replace(/\r/g, "")
                .replace(/\n{2,}/g, "\n")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 280);
            return {
                id: `${chat.id}:${relativePath}`,
                kind: bucket,
                path: path.join(relativeFromWorkspace(groupFolderPath(chat)), relativePath).replace(/\\/g, "/"),
                title: heading || path.basename(absolutePath),
                preview: preview || "No preview available.",
                updatedAt: stats.mtimeMs || stats.ctimeMs || Date.now(),
                agentId,
                agentName
            };
        }
        catch {
            return null;
        }
    }));
    return items
        .filter((item) => Boolean(item))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, 40);
}
function extractJsonBlock(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }
    const bracketStart = text.indexOf("[");
    const bracketEnd = text.lastIndexOf("]");
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
        return text.slice(bracketStart, bracketEnd + 1);
    }
    return null;
}
function normalizeTaskPlans(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw
        .map((entry) => {
        if (!entry || typeof entry !== "object") {
            return null;
        }
        const task = entry;
        const title = String(task.title || "").trim();
        if (!title) {
            return null;
        }
        return {
            title,
            detail: String(task.detail || "").trim(),
            searchTerms: Array.isArray(task.searchTerms)
                ? task.searchTerms.map((term) => String(term || "").trim()).filter(Boolean).slice(0, 8)
                : []
        };
    })
        .filter((entry) => Boolean(entry))
        .slice(0, 10);
}
function defaultAutonomyTasks(agent, chat) {
    const roleLabel = agent?.role || "agent";
    const agentName = agent?.name || "Agent";
    return [
        {
            title: `${agentName} intake review`,
            detail: `Review the latest ${chat.title} room context and isolate the most urgent work for your ${roleLabel} role.`,
            searchTerms: [chat.title, roleLabel, "intake"]
        },
        {
            title: `${agentName} workspace scan`,
            detail: "Inspect the most relevant files, artifacts, and notes related to the current room objective.",
            searchTerms: [chat.title, roleLabel, "workspace"]
        },
        {
            title: `${agentName} dependency check`,
            detail: "Identify blockers, missing inputs, or dependencies from other specialists that affect the current turn.",
            searchTerms: [chat.title, roleLabel, "dependencies"]
        },
        {
            title: `${agentName} primary execution`,
            detail: "Complete the highest-value concrete implementation or decision for this turn.",
            searchTerms: [chat.title, roleLabel, "implementation"]
        },
        {
            title: `${agentName} supporting execution`,
            detail: "Complete the next supporting change, research pass, or content artifact that strengthens the primary work.",
            searchTerms: [chat.title, roleLabel, "support"]
        },
        {
            title: `${agentName} refinement`,
            detail: "Refine the output for cohesion, clarity, quality, or usability inside the shared system.",
            searchTerms: [chat.title, roleLabel, "refine"]
        },
        {
            title: `${agentName} validation`,
            detail: "Validate the work product against the room goal, project brief, and role requirements.",
            searchTerms: [chat.title, roleLabel, "validate"]
        },
        {
            title: `${agentName} cleanup`,
            detail: "Clean up naming, file structure, notes, or follow-through details needed for a good handoff.",
            searchTerms: [chat.title, roleLabel, "cleanup"]
        },
        {
            title: `${agentName} artifact summary`,
            detail: "Summarize the concrete artifacts, decisions, or file outputs produced during this turn.",
            searchTerms: [chat.title, roleLabel, "artifacts"]
        },
        {
            title: `${agentName} handoff prep`,
            detail: "Prepare the next-step guidance another agent can use immediately in the next loop.",
            searchTerms: [chat.title, roleLabel, "handoff"]
        }
    ];
}
function ensureAutonomyTaskCount(agent, chat, tasks) {
    const normalized = normalizeTaskPlans(tasks);
    const defaults = defaultAutonomyTasks(agent, chat);
    const filled = [...normalized];
    while (filled.length < 1) {
        const template = defaults[filled.length] || defaults[defaults.length - 1];
        filled.push({
            title: template.title,
            detail: template.detail,
            searchTerms: [...template.searchTerms]
        });
    }
    return filled.slice(0, 3);
}
function fallbackTaskPlan(agent, chat) {
    return ensureAutonomyTaskCount(agent, chat, []);
}
async function ensureDirectory(directoryPath) {
    await fs.mkdir(directoryPath, { recursive: true });
}
async function writeGroupDocument(chat, relativePath, content) {
    const absolutePath = path.join(groupFolderPath(chat), relativePath);
    await ensureDirectory(path.dirname(absolutePath));
    await fs.writeFile(absolutePath, content, "utf8");
    return absolutePath;
}
async function appendChatMessageById(chatId, message) {
    const state = dashboardStore.getState();
    const chat = state.messenger.chats.find((entry) => entry.id === chatId);
    if (!chat) {
        return;
    }
    chat.messages.push({
        id: message.id || nextMsgId(),
        role: message.role || "assistant",
        author: message.author || "Agent",
        content: message.content || "",
        createdAt: Number(message.createdAt || Date.now())
    });
    await dashboardStore.setMessengerState(state.messenger);
    await broadcastRoomMemory(chat.id, chat.title, chat.members || [], message);
}
function deriveSearchTerms(seedText, extras = []) {
    const words = `${seedText}\n${extras.join("\n")}`
        .toLowerCase()
        .match(/[a-z0-9][a-z0-9.-]{2,}/g) || [];
    const stop = new Set(["this", "that", "with", "from", "into", "your", "have", "will", "about", "their", "there", "what", "when", "where", "which", "while", "group", "agent", "task", "update"]);
    return Array.from(new Set(words.filter((word) => !stop.has(word)))).slice(0, 12);
}
async function collectSearchableFiles(rootPath, currentPath = rootPath, depth = 0, results = []) {
    if (depth > 4) {
        return results;
    }
    let entries;
    try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const entryName = String(entry.name);
        const absolutePath = path.join(currentPath, entryName);
        const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
        if (entry.isDirectory()) {
            if (["node_modules", ".git", "dist", "build", ".next"].includes(entryName)) {
                continue;
            }
            if (depth === 0 && relativePath.startsWith("data/agents")) {
                continue;
            }
            await collectSearchableFiles(rootPath, absolutePath, depth + 1, results);
            continue;
        }
        if (!/\.(md|txt|json|ts|tsx|js|jsx|css|html|yml|yaml|sql)$/i.test(entryName)) {
            continue;
        }
        results.push(absolutePath);
        if (results.length >= 120) {
            return results;
        }
    }
    return results;
}
async function searchReadableDocuments(roots, terms, maxHits = 8) {
    const normalizedTerms = terms.map((term) => term.toLowerCase()).filter(Boolean);
    if (!normalizedTerms.length) {
        return [];
    }
    const seen = new Set();
    const hits = [];
    for (const root of roots) {
        const absoluteRoot = path.resolve(root);
        const files = await collectSearchableFiles(absoluteRoot);
        for (const filePath of files) {
            if (seen.has(filePath.toLowerCase())) {
                continue;
            }
            seen.add(filePath.toLowerCase());
            let content = "";
            try {
                content = await fs.readFile(filePath, "utf8");
            }
            catch {
                continue;
            }
            const lower = content.toLowerCase();
            const matched = normalizedTerms.find((term) => lower.includes(term));
            if (!matched) {
                continue;
            }
            const index = lower.indexOf(matched);
            const snippet = content.slice(Math.max(0, index - 180), Math.min(content.length, index + 220)).replace(/\s+/g, " ").trim();
            hits.push({
                path: relativeFromWorkspace(filePath),
                snippet
            });
            if (hits.length >= maxHits) {
                return hits;
            }
        }
    }
    return hits;
}
const WORKSPACE_SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage",
    "test-results"
]);
const PROJECT_FILE_EXTENSIONS = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".cts", ".mts", ".cjs", ".mjs",
    ".json", ".html", ".css", ".scss", ".sass", ".less",
    ".sql", ".yml", ".yaml", ".toml", ".env", ".sh", ".ps1", ".bat",
    ".mdx", ".xml"
]);
const NOTE_FILE_EXTENSIONS = new Set([".md", ".txt"]);
function shouldIncludeWorkspaceFile(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("data/groups/") || normalized.startsWith("data/agents/")) {
        return false;
    }
    const extension = path.extname(normalized).toLowerCase();
    const basename = path.basename(normalized).toLowerCase();
    return PROJECT_FILE_EXTENSIONS.has(extension)
        || basename === "readme"
        || basename === "readme.md"
        || basename === "package-lock.json";
}
function shouldIncludeWorkspaceNote(relativePath) {
    const normalized = relativePath.replace(/\\/g, "/");
    const extension = path.extname(normalized).toLowerCase();
    if (!NOTE_FILE_EXTENSIONS.has(extension)) {
        return false;
    }
    return normalized === "README.md"
        || normalized.startsWith("docs/")
        || normalized.startsWith("data/groups/")
        || normalized.includes("/notes/")
        || normalized.includes("/tasks/");
}
function prefixWorkspaceIndexItems(items, prefix) {
    return items.map((item) => ({
        ...item,
        path: `${prefix}/${item.path}`.replace(/\/+/g, "/"),
        folder: item.folder === "." ? prefix : `${prefix}/${item.folder}`.replace(/\/+/g, "/")
    }));
}
async function buildWorkspaceIndex(rootPath, matcher, currentPath = rootPath, results = []) {
    let entries;
    try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
    }
    catch {
        return results;
    }
    for (const entry of entries) {
        const absolutePath = path.join(currentPath, entry.name);
        const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, "/");
        if (entry.isDirectory()) {
            if (WORKSPACE_SKIP_DIRS.has(entry.name)) {
                continue;
            }
            await buildWorkspaceIndex(rootPath, matcher, absolutePath, results);
            continue;
        }
        if (!matcher(relativePath)) {
            continue;
        }
        try {
            const stats = await fs.stat(absolutePath);
            results.push({
                path: relativePath,
                folder: path.posix.dirname(relativePath) === "." ? "." : path.posix.dirname(relativePath),
                name: path.posix.basename(relativePath),
                updatedAt: stats.mtimeMs || stats.ctimeMs || Date.now(),
                size: stats.size || 0
            });
        }
        catch { }
    }
    return results;
}
async function deleteWorkspacePaths(pathsToDelete) {
    const deleted = [];
    for (const relativePath of pathsToDelete) {
        const normalized = String(relativePath || "").replace(/\\/g, "/");
        if (!normalized) {
            continue;
        }
        const usingControlPrefix = normalized.startsWith("__control__/");
        const baseRoot = usingControlPrefix ? config.controlRoot : config.projectRoot;
        const strippedPath = usingControlPrefix ? normalized.slice("__control__/".length) : normalized;
        const absolutePath = path.resolve(baseRoot, strippedPath);
        const relativeToRoot = path.relative(baseRoot, absolutePath);
        if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
            continue;
        }
        try {
            const stats = await fs.stat(absolutePath);
            if (!stats.isFile()) {
                continue;
            }
            await fs.unlink(absolutePath);
            deleted.push(normalized);
        }
        catch { }
    }
    return deleted;
}
async function generateAutonomyTasks(agent, chat, searchHits) {
    const prompt = [
        "Generate a task list for your next autonomy cycle.",
        "Return JSON only: an array of 1 to 3 objects with keys title, detail, searchTerms.",
        "The tasks must fit your role, the latest group chat context, and the documents found.",
        "Prefer concrete, sequential tasks that can be completed in one cycle.",
        "Do not include meta commentary. Do not skip task slots.",
        `Group: ${chat.title}`,
        `Role: ${agent.role}`,
        agent.notes ? `Role notes: ${agent.notes}` : "",
        recentTranscript(chat, 12) ? `Recent group transcript:\n${recentTranscript(chat, 12)}` : "",
        searchHits.length
            ? `Relevant documents:\n${searchHits.map((hit) => `- ${hit.path}: ${hit.snippet}`).join("\n")}`
            : "Relevant documents: none found."
    ].filter(Boolean).join("\n\n");
    const execution = await executeAgentPrompt(agent.id, prompt, "autonomy-planning");
    const jsonBlock = extractJsonBlock(execution.result.content || "");
    if (!jsonBlock) {
        return fallbackTaskPlan(agent, chat);
    }
    try {
        const parsed = JSON.parse(jsonBlock);
        return ensureAutonomyTaskCount(agent, chat, parsed);
    }
    catch {
        return fallbackTaskPlan(agent, chat);
    }
}
async function syncAutonomyBoardTasks(agentId, chat, tasks, cycleTag) {
    for (let index = 0; index < Math.max(tasks.length, 3); index += 1) {
        const task = tasks[index];
        const taskId = `auto-${chat.id}-${agentId}-${index}`;
        if (!task) {
            await dashboardStore.removeTask(taskId);
            continue;
        }
        await dashboardStore.upsertTask({
            id: taskId,
            title: task.title,
            detail: `${task.detail}\n\n[Autonomy | ${chat.title} | cycle ${cycleTag}]`.trim(),
            status: "todo",
            agentId
        });
    }
}
function resolveCwd(rawCwd) {
    const fallback = config.projectRoot;
    const requested = rawCwd ? path.resolve(rawCwd) : fallback;
    const relativeToProject = path.relative(config.projectRoot, requested);
    if (!relativeToProject.startsWith("..") && !path.isAbsolute(relativeToProject)) {
        return requested;
    }
    return fallback;
}
function agentPromptContext(agent, mode) {
    if (!agent)
        return "";
    const dashboardState = dashboardStore.getState();
    const persona = agent.personaId ? personaRegistry.get(agent.personaId) : null;
    const assignedTasks = dashboardState.tasks
        .filter((task) => task.agentId === agent.id && task.status !== "done")
        .map((task) => `- ${task.title} [${task.status}]${task.detail ? `: ${task.detail}` : ""}`);
    return [
        `Assigned agent: ${agent.name}`,
        `Role: ${agent.role}`,
        persona?.label ? `Persona: ${persona.label}` : "",
        persona?.targetLayer ? `Target layer: ${persona.targetLayer}` : "",
        persona?.voice ? `Persona voice: ${persona.voice}` : "",
        `Workspace folder: ${agent.workspacePath}`,
        `Attached tools: ${agent.tools.join(", ") || "none"}`,
        `Specialized skills: ${agent.skills.join(", ") || "none"}`,
        "Exploration protocol: when the path is unclear, identify unknowns, propose 2-3 options, run the safest useful prototype, capture what changed, and feed the result back into tasks and notes.",
        "Strategic horizon: build the current browser experience as phase one of a future immersive world stack that may later include persistent realtime systems and a downloadable client.",
        dashboardState.projectBrief ? `Shared project brief: ${dashboardState.projectBrief}` : "",
        assignedTasks.length ? `Assigned tasks:\n${assignedTasks.join("\n")}` : "",
        agent.repoBranch ? `Preferred git branch: ${agent.repoBranch}` : "",
        agent.notes ? `Agent directives: ${agent.notes}` : "",
        persona?.promptAddendum ? `Persona directives: ${persona.promptAddendum}` : "",
        mode ? `UI environment: ${mode}` : ""
    ].filter(Boolean).join("\n");
}
async function recordAgentActivity(agent, source, status, title, detail = "") {
    await dashboardStore.addActivity({
        source,
        agentId: agent?.id || "",
        agentName: agent?.name || "",
        status,
        title,
        detail
    });
}
async function setAgentPresence(agentId, presence) {
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return;
    }
    await teamRegistry.upsert({
        id: agentId,
        presence,
        state: presence === "error" ? "error" : (presence === "active" ? "active" : agent.state === "error" ? "idle" : agent.state)
    });
}
async function setAgentError(agentId) {
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return;
    }
    await teamRegistry.upsert({
        id: agentId,
        presence: "error",
        state: "error"
    });
}
function agentActivityTitles(agentName, mode) {
    switch (mode) {
        case "messenger":
            return {
                start: `${agentName} drafting chat reply`,
                done: `${agentName} sent chat reply`
            };
        case "autonomy-chat-in":
            return {
                start: `${agentName} drafting group update`,
                done: `${agentName} posted group update`
            };
        case "autonomy-planning":
            return {
                start: `${agentName} planning autonomy cycle`,
                done: `${agentName} planned autonomy cycle`
            };
        case "autonomy":
            return {
                start: `${agentName} executing autonomy task`,
                done: `${agentName} completed autonomy task`
            };
        case "dispatch":
        default:
            return {
                start: `${agentName} working on dispatch`,
                done: `${agentName} completed dispatch`
            };
    }
}
async function executeAgentPrompt(agentId, prompt, mode = "dispatch") {
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        throw new Error("agent not found");
    }
    const persona = agent.personaId ? personaRegistry.get(agent.personaId) : null;
    const resolvedModel = agent.usePersonaModel && persona?.model
        ? persona.model
        : (agent.model || runtimeSettings.models[agent.role === "executive" ? "executive" : agent.role === "coder" ? "coder" : "fast"]);
    const titles = agentActivityTitles(agent.name, mode);
    await recordAgentActivity(agent, mode, "working", titles.start, prompt.slice(0, 320));
    const agentConfig = {
        ...teamRegistry.buildAgentConfig(agent.id),
        provider: agent.provider,
        models: {
            executive: resolvedModel || runtimeSettings.models.executive,
            coder: resolvedModel || runtimeSettings.models.coder,
            fast: resolvedModel || runtimeSettings.models.fast
        },
        ollamaBaseUrl: runtimeSettings.ollamaBaseUrl,
        openClawBaseUrl: runtimeSettings.openClawBaseUrl
    };
    const agentBrain = await teamRegistry.getBrain(agent.id);
    const activeTaskTitles = dashboardStore.getState().tasks
        .filter((task) => task.agentId === agent.id && task.status !== "done")
        .map((task) => String(task.title || "").trim())
        .filter(Boolean)
        .slice(0, 8);
    const result = await runKiraChat(agentConfig, agentBrain, [agentPromptContext(agent, mode), prompt].filter(Boolean).join("\n\n"), {
        mode,
        agentId: agent.id,
        agentName: agent.name,
        agentRole: agent.role,
        personaId: agent.personaId || "",
        taskTitles: activeTaskTitles,
        prompt,
        scopeType: "agent",
        scopeId: agent.id
    });
    if (result.model && agent.model !== result.model) {
        await teamRegistry.upsert({
            id: agent.id,
            model: result.model
        });
    }
    let updatedAgent = await teamRegistry.recordDispatch(agent.id, prompt, result.content || "");
    await recordAgentActivity(updatedAgent, mode, "done", agentActivityTitles(updatedAgent.name, mode).done, (result.content || "").slice(0, 320));
    await agentBrain.recordEpisode({
        title: `${updatedAgent.name} ${mode}`,
        action: clipText(prompt, 180),
        outcome: clipText(result.content || "", 180),
        nextStep: "Carry forward the successful patterns and turn unresolved issues into explicit tasks.",
        scopeType: "agent",
        scopeId: updatedAgent.id,
        source: mode,
        sourceRole: "system"
    });
    return {
        result,
        agent: updatedAgent
    };
}
async function ensureDefaultGroupChat() {
    const state = dashboardStore.getState();
    const agents = teamRegistry.list();
    if (agents.length < 2) {
        return;
    }
    const memberIds = agents.map((agent) => agent.id);
    const existing = state.messenger.chats.find((chat) => chat.id === "group-core-team");
    if (existing) {
        existing.type = "group";
        existing.title = "Closed Loop";
        existing.members = memberIds;
        existing.origin = "system";
        if (!Array.isArray(existing.messages)) {
            existing.messages = [];
        }
        if (!existing.messages.some((message) => message.id === "msg-core-team-seed")) {
            existing.messages.unshift({
                id: "msg-core-team-seed",
                role: "system",
                author: "Kirapolis",
                content: "Closed Loop is ready. Every agent contributes to the evolving workspace through shared rooms, files, artifacts, and review cycles.",
                createdAt: Date.now()
            });
        }
    }
    else {
        state.messenger.chats.unshift({
            id: "group-core-team",
            type: "group",
            title: "Closed Loop",
            members: memberIds,
            messages: [
                {
                    id: "msg-core-team-seed",
                    role: "system",
                    author: "Kirapolis",
                    content: "Closed Loop is ready. Every agent contributes to the evolving workspace through shared rooms, files, artifacts, and review cycles.",
                    createdAt: Date.now()
                }
            ],
            lastReadAt: 0,
            origin: "system"
        });
    }
    state.messenger.activeChatId = state.messenger.activeChatId || "group-core-team";
    await dashboardStore.setMessengerState(state.messenger);
}
async function ensureNamedGroupChat(chatId, title, memberIds, seedMessage) {
    const state = dashboardStore.getState();
    const uniqueMembers = Array.from(new Set((memberIds || []).filter(Boolean)));
    const existing = state.messenger.chats.find((chat) => chat.id === chatId);
    if (existing) {
        existing.type = "group";
        existing.title = title;
        existing.members = uniqueMembers;
        existing.origin = "system";
        if (!Array.isArray(existing.messages)) {
            existing.messages = [];
        }
        if (seedMessage && !existing.messages.some((message) => message.id === `${chatId}-seed`)) {
            existing.messages.unshift({
                id: `${chatId}-seed`,
                role: "system",
                author: "Kirapolis",
                content: seedMessage,
                createdAt: Date.now()
            });
        }
    }
    else {
        state.messenger.chats.unshift({
            id: chatId,
            type: "group",
            title,
            members: uniqueMembers,
            messages: seedMessage
                ? [{
                        id: `${chatId}-seed`,
                        role: "system",
                        author: "Kirapolis",
                        content: seedMessage,
                        createdAt: Date.now()
                    }]
                : [],
            lastReadAt: 0,
            origin: "system"
        });
    }
    await dashboardStore.setMessengerState(state.messenger);
    return state.messenger.chats.find((chat) => chat.id === chatId) || null;
}
function getPostDeployAgentIds() {
    return [
        "agent-ceo",
        "agent-manager",
        "agent-qa",
        "agent-github",
        "agent-postdeploy-monitor",
        "agent-visual-analyst"
    ].filter((agentId) => Boolean(teamRegistry.get(agentId)));
}
function listLocalSpecialists() {
    return teamRegistry.list().filter((agent) => String(agent.surface || "shared") === "local");
}
function getLocalWorkbenchAgentIds() {
    const localIds = listLocalSpecialists().map((agent) => agent.id);
    return Array.from(new Set([
        "agent-ceo",
        "agent-manager",
        ...localIds
    ].filter((agentId) => Boolean(teamRegistry.get(agentId)))));
}
async function ensurePostDeployGroupChat() {
    return await ensureNamedGroupChat("group-post-deploy", "Post Deploy", getPostDeployAgentIds(), "Post Deploy is ready. Railway events, runtime failures, and visual release checks will be routed here for fast triage.");
}
async function ensurePostDeploySpecialists() {
    const specs = [
        {
            id: "agent-postdeploy-monitor",
            name: "Post Deploy Monitor",
            role: "runner",
            provider: "ollama",
            tools: ["workspace-read", "exec", "planning", "web"],
            skills: ["deployment", "runtime-monitoring", "incident-triage", "release-readiness", "log-analysis", "railway-ops", "handoff-reporting"],
            notes: "Monitors post-deployment health, deployment incidents, Railway webhook reports, and runtime regressions, then relays concrete findings back to the team."
        },
        {
            id: "agent-visual-analyst",
            name: "Post Deploy Visual Analyst",
            role: "runner",
            provider: "ollama",
            tools: ["workspace-read", "planning", "web", "exec"],
            skills: ["visual-qa", "ux-regression-review", "cross-device-auditing", "release-readiness", "playability-review", "screenshot-analysis"],
            notes: "Checks the deployed experience visually after release, looks for layout regressions and broken journeys, and reports what changed in plain language for the team."
        }
    ];
    for (const spec of specs) {
        await teamRegistry.upsert(spec);
    }
    await progressionStore.ensureAgents(teamRegistry.list());
}
async function ensureLocalSpecialists() {
    const specs = [
        {
            id: "agent-local-architect",
            name: "Local Systems Architect",
            role: "executive",
            surface: "local",
            provider: "ollama",
            tools: ["planning", "workspace-read", "web"],
            skills: ["local-runtime-planning", "system-design", "architecture-review", "model-routing", "group-orchestration"],
            specialty: "Local orchestration",
            notes: "Designs the local workstation layout, chooses how specialty agents are grouped, and keeps local sessions compatible with the shared Railway-facing org."
        },
        {
            id: "agent-local-builder",
            name: "Local Integration Builder",
            role: "coder",
            surface: "local",
            provider: "ollama",
            tools: ["workspace-read", "workspace-write", "exec"],
            skills: ["local-integration", "runtime-wiring", "toolchain-assembly", "chat-surface-build", "model-handshake"],
            specialty: "Local integration",
            notes: "Owns the local-only wiring, specialty-agent hookups, and workstation-specific integration work that should not disrupt the hosted Railway surface."
        },
        {
            id: "agent-local-operator",
            name: "Local Specialist Operator",
            role: "runner",
            surface: "local",
            provider: "ollama",
            tools: ["workspace-read", "exec", "planning"],
            skills: ["local-ops", "runtime-checks", "session-handoff", "multi-agent-room-support", "artifact-routing"],
            specialty: "Local operations",
            notes: "Runs the local specialty rooms, keeps the workstation side organized, and hands local findings back into the same shared chat structure the Railway agents already use."
        }
    ];
    for (const spec of specs) {
        await teamRegistry.upsert(spec);
    }
    await progressionStore.ensureAgents(teamRegistry.list());
}
async function ensureLocalWorkbenchGroupChat() {
    return await ensureNamedGroupChat("group-local-workbench", "Local Workbench", getLocalWorkbenchAgentIds(), "Local Workbench is ready. Pull tuned models from Model Lab, attach them to local specialty agents, and coordinate local-only execution without breaking the shared org context.");
}
function localWorkbenchChatFilter(chat, localIds) {
    if (!chat) {
        return false;
    }
    if (chat.id === "group-local-workbench") {
        return true;
    }
    return Array.isArray(chat.members) && chat.members.some((memberId) => localIds.has(memberId));
}
async function collectWorkbenchModels() {
    const [presets, neutralizationRuns] = await Promise.all([
        collectModelLabPresets(),
        collectNeutralizationRuns()
    ]);
    const agentModels = teamRegistry.list().flatMap((agent) => [agent.model, agent.sourceModel]);
    return Array.from(new Set([
        ...Object.values(runtimeSettings.models || {}),
        ...presets.map((preset) => String(preset?.model || "").trim()),
        ...neutralizationRuns.map((run) => String(run?.derivedName || "").trim()),
        ...agentModels.map((model) => String(model || "").trim())
    ].filter(Boolean))).map((model) => ({ id: model, model }));
}
async function buildLocalWorkbenchPayload() {
    const agents = listAgentsWithProgression();
    const localAgents = agents.filter((agent) => String(agent.surface || "shared") === "local");
    const localIds = new Set(localAgents.map((agent) => agent.id));
    const messenger = dashboardStore.getState().messenger || { chats: [] };
    const rooms = (messenger.chats || [])
        .filter((chat) => localWorkbenchChatFilter(chat, localIds))
        .sort((left, right) => {
        const leftAt = Number(Array.isArray(left?.messages) && left.messages.length
            ? left.messages[left.messages.length - 1]?.createdAt
            : left?.lastReadAt || 0);
        const rightAt = Number(Array.isArray(right?.messages) && right.messages.length
            ? right.messages[right.messages.length - 1]?.createdAt
            : right?.lastReadAt || 0);
        return rightAt - leftAt;
    });
    return {
        generatedAt: Date.now(),
        localAgents,
        sharedAgents: agents.filter((agent) => String(agent.surface || "shared") !== "local"),
        rooms,
        tunedModels: await collectWorkbenchModels(),
        defaultRoomId: "group-local-workbench"
    };
}
function buildDirectRoomTitle(memberIds) {
    return memberIds
        .map((memberId) => teamRegistry.get(memberId)?.name || memberId)
        .join(" + ")
        .slice(0, 120) || "Direct Thread";
}
function uniqueValidMemberIds(memberIds) {
    return Array.from(new Set((memberIds || []).filter((memberId) => Boolean(teamRegistry.get(memberId)))));
}
function summarizeRailwayPayload(payload) {
    const eventType = String(payload?.event || payload?.type || payload?.action || payload?.trigger || "event").trim() || "event";
    const status = String(payload?.status || payload?.deployment?.status || payload?.state || payload?.result || "").toLowerCase();
    const environment = String(payload?.environment || payload?.deployment?.environment || payload?.service?.environment || "production");
    const service = String(payload?.service || payload?.serviceName || payload?.deployment?.service || payload?.project || payload?.projectName || "Railway service");
    const deploymentId = String(payload?.deploymentId || payload?.deployment?.id || payload?.id || "");
    const url = String(payload?.url || payload?.deployment?.url || payload?.deploymentUrl || payload?.serviceUrl || "");
    const errorMessage = String(payload?.error?.message || payload?.message || payload?.detail || payload?.reason || "").trim();
    const failed = /(fail|error|crash|rollback|canceled|cancelled|degraded)/i.test(`${eventType} ${status} ${errorMessage}`);
    const succeeded = /(success|complete|ready|healthy|deployed|finish)/i.test(`${eventType} ${status}`) && !failed;
    return {
        eventType,
        status,
        environment,
        service,
        deploymentId,
        url,
        errorMessage,
        failed,
        succeeded
    };
}
async function createOrRefreshPostDeployTask(taskId, agentId, title, detail, status = "todo") {
    if (!agentId || !teamRegistry.get(agentId)) {
        return;
    }
    await dashboardStore.upsertTask({
        id: taskId,
        title,
        detail,
        status,
        agentId
    });
}
async function relayPostDeployAgent(agentId, prompt, chatId) {
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return null;
    }
    try {
        const execution = await executeAgentPrompt(agent.id, prompt, "dispatch");
        await appendChatMessageById(chatId, {
            role: "assistant",
            author: agent.name,
            content: execution.result.content || "No response returned.",
            createdAt: Date.now()
        });
        return execution.result.content || "";
    }
    catch (error) {
        await dashboardStore.addFailure(agent.id, `Post-deploy relay failed for ${agent.name}`, describeError(error));
        return null;
    }
}
async function relayPostDeploySummaryToCoreTeam(summary, postDeployChatId, monitorReply, visualReply) {
    const coreTeamChatId = "group-core-team";
    const messageParts = [
        `Post-deploy ${summary.failed ? "incident" : summary.succeeded ? "check-in" : "update"} for ${summary.service}.`,
        ``,
        `Status: ${summary.status || "unknown"} | Environment: ${summary.environment}${summary.deploymentId ? ` | Deployment: ${summary.deploymentId}` : ""}${summary.url ? ` | URL: ${summary.url}` : ""}`
    ];
    if (summary.errorMessage) {
        messageParts.push(`Detail: ${summary.errorMessage}`);
    }
    messageParts.push(`Incident room: ${postDeployChatId}`);
    if (monitorReply) {
        messageParts.push("", `Monitor`, monitorReply);
    }
    if (visualReply) {
        messageParts.push("", `Visual`, visualReply);
    }
    await appendChatMessageById(coreTeamChatId, {
        role: "system",
        author: "Post Deploy Relay",
        content: messageParts.join("\n"),
        createdAt: Date.now()
    });
}
async function handleRailwayDeploymentEvent(payload) {
    const summary = summarizeRailwayPayload(payload);
    const postDeployChat = await ensurePostDeployGroupChat();
    const detailParts = [
        `Event: ${summary.eventType}`,
        `Status: ${summary.status || "unknown"}`,
        `Environment: ${summary.environment}`,
        `Service: ${summary.service}`,
        summary.deploymentId ? `Deployment: ${summary.deploymentId}` : "",
        summary.url ? `URL: ${summary.url}` : "",
        summary.errorMessage ? `Detail: ${summary.errorMessage}` : ""
    ].filter(Boolean);
    const detailText = detailParts.join(" | ");
    if (summary.failed) {
        await dashboardStore.addFailure("railway", `Railway ${summary.eventType} failed for ${summary.service}`, detailText);
    }
    await dashboardStore.addActivity({
        source: "railway",
        agentId: "",
        agentName: "Railway",
        status: summary.failed ? "issue" : summary.succeeded ? "done" : "info",
        title: summary.failed
            ? `Railway failure: ${summary.service}`
            : summary.succeeded
                ? `Railway deploy healthy: ${summary.service}`
                : `Railway update: ${summary.service}`,
        detail: detailText
    });
    await appendChatMessageById(postDeployChat?.id || "group-post-deploy", {
        role: "system",
        author: "Railway",
        content: `${summary.failed ? "Deployment issue detected." : summary.succeeded ? "Deployment update received." : "Railway event received."}\n\n${detailText}`,
        createdAt: Date.now()
    });
    const monitorTaskTitle = summary.failed ? `Investigate Railway issue in ${summary.service}` : `Confirm post-deploy health for ${summary.service}`;
    const monitorTaskDetail = `${detailText}\n\nRelay the concrete technical status back into Post Deploy.`;
    await createOrRefreshPostDeployTask(`postdeploy-monitor-${summary.deploymentId || summary.service}`, "agent-postdeploy-monitor", monitorTaskTitle, monitorTaskDetail, summary.failed ? "doing" : "todo");
    if (summary.url) {
        const visualTaskTitle = `Visually audit ${summary.service}`;
        const visualTaskDetail = `${detailText}\n\nOpen ${summary.url} and report layout, UX, navigation, or rendering regressions after deployment.`;
        await createOrRefreshPostDeployTask(`postdeploy-visual-${summary.deploymentId || summary.service}`, "agent-visual-analyst", visualTaskTitle, visualTaskDetail, "todo");
    }
    const monitorPrompt = [
        "You are handling a post-deployment monitoring event.",
        "Summarize the event, identify the most likely technical concern, and tell the team the next action in 3 short sections: Signal, Risk, Next Step.",
        `Event summary: ${detailText}`,
        summary.failed ? "Treat this as an incident until proven otherwise." : "Treat this as a release verification pass."
    ].join("\n\n");
    const monitorReply = await relayPostDeployAgent("agent-postdeploy-monitor", monitorPrompt, postDeployChat?.id || "group-post-deploy");
    let visualReply = "";
    if (summary.url) {
        const visualPrompt = [
            "You are the post-deployment visual analyst.",
            "Describe the visual audit plan for this deployment in 3 short sections: What to check, likely regressions, and what the team should verify first.",
            `Deployment URL: ${summary.url}`,
            `Event summary: ${detailText}`
        ].join("\n\n");
        visualReply = (await relayPostDeployAgent("agent-visual-analyst", visualPrompt, postDeployChat?.id || "group-post-deploy")) || "";
    }
    await relayPostDeploySummaryToCoreTeam(summary, postDeployChat?.id || "group-post-deploy", monitorReply || "", visualReply);
    return summary;
}
async function runAgentGroupCycle(agent, chat, cycleIndex) {
    const cycleStamp = `${Date.now()}-${cycleIndex}`;
    const groupRoot = groupFolderPath(chat);
    const roots = Array.from(new Set([agent.workspacePath, groupRoot]));
    await setAgentPresence(agent.id, "active");
    const preSearchTerms = deriveSearchTerms(`${chat.title}\n${recentTranscript(chat, 12)}\n${agent.notes}`, [agent.role]);
    await setAgentPresence(agent.id, "waiting");
    const intakeHits = await searchReadableDocuments(roots, preSearchTerms, 8);
    const intakeNotePath = await writeGroupDocument(chat, path.join("notes", agent.id, `${cycleStamp}-intake.md`), [
        `# Intake`,
        ``,
        `- Agent: ${agent.name}`,
        `- Role: ${agent.role}`,
        `- Group: ${chat.title}`,
        `- Cycle: ${cycleStamp}`,
        ``,
        `## Recent Transcript`,
        recentTranscript(chat, 12) || "No recent messages.",
        ``,
        `## Document Hits`,
        intakeHits.length
            ? intakeHits.map((hit) => `- ${hit.path}: ${hit.snippet}`).join("\n")
            : "- No matching documents found."
    ].join("\n"));
    await setAgentPresence(agent.id, "typing");
    const tasks = await generateAutonomyTasks(agent, chat, intakeHits);
    await setAgentPresence(agent.id, "waiting");
    await syncAutonomyBoardTasks(agent.id, chat, tasks, cycleStamp);
    await appendChatMessageById(chat.id, {
        role: "assistant",
        author: agent.name,
        content: `On it. Working on ${tasks.length} task${tasks.length === 1 ? "" : "s"} this cycle:\n${tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}`
    });
    const taskSummaries = [];
    const executionOutputs = [];
    for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        const taskId = `auto-${chat.id}-${agent.id}-${index}`;
        await dashboardStore.upsertTask({
            id: taskId,
            title: task.title,
            detail: `${task.detail}\n\n[Autonomy | ${chat.title} | cycle ${cycleStamp}]`.trim(),
            status: "doing",
            agentId: agent.id
        });
        await setAgentPresence(agent.id, "waiting");
        const taskSearchTerms = deriveSearchTerms(`${task.title}\n${task.detail}`, task.searchTerms);
        const taskHits = await searchReadableDocuments(roots, taskSearchTerms, 6);
        await setAgentPresence(agent.id, "typing");
        const execution = await executeAgentPrompt(agent.id, [
            "Execute this autonomy task now.",
            "Work sequentially and produce a concrete completion note for this task.",
            "If you cannot directly change product files in this cycle, describe the exact work product, decision, or implementation steps you completed and what should happen next.",
            `Group: ${chat.title}`,
            `Task ${index + 1} of ${tasks.length}: ${task.title}`,
            task.detail ? `Task detail: ${task.detail}` : "",
            taskHits.length ? `Relevant docs:\n${taskHits.map((hit) => `- ${hit.path}: ${hit.snippet}`).join("\n")}` : "",
            `Store-oriented context: write for a shared group folder and keep details implementation-ready.`
        ].filter(Boolean).join("\n\n"), "autonomy");
        await setAgentPresence(agent.id, "waiting");
        const output = (execution.result.content || "No output.").trim();
        const taskDocPath = await writeGroupDocument(chat, path.join("tasks", agent.id, `${cycleStamp}-${String(index + 1).padStart(2, "0")}-${safeFileStem(task.title)}.md`), [
            `# ${task.title}`,
            ``,
            task.detail ? `## Task Detail\n${task.detail}\n` : "",
            `## Result`,
            output,
            ``,
            `## Document Hits`,
            taskHits.length ? taskHits.map((hit) => `- ${hit.path}: ${hit.snippet}`).join("\n") : "- No matching documents found."
        ].join("\n"));
        executionOutputs.push(`- ${task.title}: ${output.slice(0, 280)}`);
        taskSummaries.push(`${task.title} -> ${relativeFromWorkspace(taskDocPath)}`);
        await dashboardStore.upsertTask({
            id: taskId,
            title: task.title,
            detail: `${task.detail}\n\nResult stored at ${relativeFromWorkspace(taskDocPath)}.`.trim(),
            status: "done",
            agentId: agent.id
        });
        await awardAgentTaskCompletion(agent.id, taskId, `${task.title}\n${task.detail}\n${output}`);
    }
    const postSearchTerms = deriveSearchTerms(executionOutputs.join("\n"), preSearchTerms);
    await setAgentPresence(agent.id, "waiting");
    const postHits = await searchReadableDocuments(roots, postSearchTerms, 8);
    const summaryPath = await writeGroupDocument(chat, path.join("notes", agent.id, `${cycleStamp}-summary.md`), [
        `# Cycle Summary`,
        ``,
        `- Agent: ${agent.name}`,
        `- Group: ${chat.title}`,
        `- Cycle: ${cycleStamp}`,
        ``,
        `## Completed Task Files`,
        taskSummaries.length ? taskSummaries.map((entry) => `- ${entry}`).join("\n") : "- No tasks completed.",
        ``,
        `## Follow-up Search Hits`,
        postHits.length ? postHits.map((hit) => `- ${hit.path}: ${hit.snippet}`).join("\n") : "- No additional documents found."
    ].join("\n"));
    await setAgentPresence(agent.id, "typing");
    const postReply = await executeAgentPrompt(agent.id, [
        "You just completed an autonomy cycle for a group chat.",
        "Write one concise update to the whole group about what you completed, what artifacts were produced, and what should happen next.",
        "Keep it short, concrete, and collaborative.",
        `Group: ${chat.title}`,
        `Transcript before your update:\n${recentTranscript(chat, 12) || "No recent messages."}`,
        taskSummaries.length ? `Completed task files:\n- ${taskSummaries.join("\n- ")}` : "Completed task files: none.",
        executionOutputs.length ? `Completed work summary:\n${executionOutputs.join("\n")}` : "Completed work summary: none.",
        `Your intake note was stored at ${relativeFromWorkspace(intakeNotePath)}.`,
        `Your cycle summary was stored at ${relativeFromWorkspace(summaryPath)}.`
    ].filter(Boolean).join("\n\n"), "autonomy-chat-in");
    await setAgentPresence(agent.id, "waiting");
    const replyContent = (postReply.result.content || "").trim()
        || `Done. Completed ${taskSummaries.length} task${taskSummaries.length === 1 ? "" : "s"}:\n${taskSummaries.map((s) => `- ${s}`).join("\n")}`;
    await appendChatMessageById(chat.id, {
        role: "assistant",
        author: agent.name,
        content: replyContent
    });
    await setAgentPresence(agent.id, "active");
    return `${agent.name} read ${chat.title}, worked ${tasks.length} task${tasks.length === 1 ? "" : "s"}, and posted a final update in ${relativeFromWorkspace(summaryPath)}.`;
}
class TeamHeartbeat {
    status = {
        active: false,
        intervalMs: 30000,
        cooldownMs: 0,
        maxAgentsPerCycle: 10,
        cyclesCompleted: 0,
        lastRunAt: null,
        lastError: "",
        lastDetail: "Autonomy loop is off."
    };
    agentLoops = new Map();
    getStatus() {
        return {
            ...this.status,
            agents: Array.from(this.agentLoops.entries()).map(([agentId, loop]) => ({
                agentId,
                running: Boolean(loop?.running),
                cyclesCompleted: Number(loop?.cyclesCompleted || 0),
                lastRunAt: loop?.lastRunAt || null,
                nextRunAt: loop?.nextRunAt || null,
                currentChatId: loop?.currentChatId || "",
                lastDetail: loop?.lastDetail || "",
                lastError: loop?.lastError || ""
            }))
        };
    }
    async start(intervalMs = 30000, maxAgentsPerCycle = 10) {
        this.status.active = true;
        this.status.intervalMs = Math.max(15000, Math.min(intervalMs, 3600000));
        this.status.maxAgentsPerCycle = Math.max(1, Math.min(maxAgentsPerCycle, 10));
        this.status.lastError = "";
        this.status.lastDetail = "Autonomy schedulers active. Each agent runs its own loop.";
        this.syncAgentLoops();
        for (const [agentId, loop] of this.agentLoops.entries()) {
            if (loop?.timer) {
                clearTimeout(loop.timer);
            }
            this.agentLoops.set(agentId, {
                ...loop,
                timer: null,
                nextRunAt: null
            });
        }
        await dashboardStore.addActivity({
            source: "autonomy",
            agentId: "",
            agentName: "Autonomy Loop",
            status: "working",
            title: "Autonomy loop started",
            detail: `Every eligible agent now runs its own autonomy loop on a ${this.status.intervalMs}ms schedule.`
        });
        await ensureDefaultGroupChat();
        for (const agent of teamRegistry.list().filter((entry) => entry.state !== "paused")) {
            void this.runAgentCycle(agent.id, true);
        }
        return this.getStatus();
    }
    stop() {
        this.status.active = false;
        this.status.lastDetail = "Autonomy loop stopped.";
        for (const [agentId, loop] of this.agentLoops.entries()) {
            if (loop?.timer) {
                clearTimeout(loop.timer);
            }
            this.agentLoops.set(agentId, {
                ...loop,
                timer: null,
                nextRunAt: null,
                running: false
            });
            teamRegistry.upsert({ id: agentId, state: "idle", presence: "idle" }).catch((error) => console.warn("[heartbeat] failed to reset agent state:", agentId, error instanceof Error ? error.message : String(error)));
        }
        void dashboardStore.addActivity({
            source: "autonomy",
            agentId: "",
            agentName: "Autonomy Loop",
            status: "info",
            title: "Autonomy loop stopped",
            detail: this.status.cyclesCompleted ? `Completed ${this.status.cyclesCompleted} total agent turns.` : "No agent turns completed."
        });
        return this.getStatus();
    }
    syncAgentLoops() {
        const activeIds = new Set(teamRegistry.list().map((agent) => agent.id));
        for (const [agentId, loop] of this.agentLoops.entries()) {
            if (!activeIds.has(agentId)) {
                if (loop?.timer) {
                    clearTimeout(loop.timer);
                }
                this.agentLoops.delete(agentId);
            }
        }
        for (const agent of teamRegistry.list()) {
            if (!this.agentLoops.has(agent.id)) {
                this.agentLoops.set(agent.id, {
                    timer: null,
                    running: false,
                    cyclesCompleted: 0,
                    lastRunAt: null,
                    nextRunAt: null,
                    currentChatId: "",
                    lastDetail: "Waiting for autonomy start.",
                    lastError: "",
                    nextChatIndex: 0
                });
            }
        }
    }
    scheduleAgentRun(agentId, delayMs = this.status.intervalMs) {
        if (!this.status.active) {
            return;
        }
        const loop = this.agentLoops.get(agentId);
        if (!loop) {
            return;
        }
        if (loop.timer) {
            clearTimeout(loop.timer);
        }
        const waitMs = Math.max(1000, delayMs);
        loop.nextRunAt = Date.now() + waitMs;
        loop.timer = setTimeout(() => {
            void this.runAgentCycle(agentId);
        }, waitMs);
        this.agentLoops.set(agentId, loop);
    }
    async runAgentCycle(agentId, immediate = false) {
        if (!this.status.active) {
            return;
        }
        const agent = teamRegistry.get(agentId);
        if (!agent || agent.state === "paused") {
            return;
        }
        this.syncAgentLoops();
        const loop = this.agentLoops.get(agentId);
        if (!loop || loop.running) {
            return;
        }
        if (loop.timer) {
            clearTimeout(loop.timer);
            loop.timer = null;
        }
        loop.running = true;
        loop.lastRunAt = Date.now();
        loop.nextRunAt = null;
        loop.lastError = "";
        loop.lastDetail = immediate ? "Starting first independent agent turn." : "Running scheduled agent turn.";
        this.agentLoops.set(agentId, loop);
        this.status.lastRunAt = loop.lastRunAt;
        try {
            await ensureDefaultGroupChat();
            const board = dashboardStore.getState();
            const groupChats = board.messenger.chats.filter((chat) => chat.type === "group" && chat.members.length >= 2);
            if (!groupChats.length) {
                loop.lastDetail = `${agent.name} is waiting for an active room.`;
                await teamRegistry.upsert({ id: agent.id, state: "idle", presence: "waiting" });
                return;
            }
            const memberships = groupChats.filter((chat) => chat.members.includes(agent.id));
            if (!memberships.length) {
                loop.lastDetail = `${agent.name} is waiting for room membership.`;
                await teamRegistry.upsert({ id: agent.id, state: "idle", presence: "waiting" });
                return;
            }
            const selectedIndex = loop.nextChatIndex % memberships.length;
            const chat = memberships[selectedIndex];
            loop.nextChatIndex += 1;
            loop.currentChatId = chat.id;
            await teamRegistry.upsert({ id: agent.id, state: "active", presence: "active" });
            const detail = await runAgentGroupCycle(agent, chat, loop.cyclesCompleted);
            loop.currentChatId = "";
            loop.cyclesCompleted += 1;
            loop.lastDetail = detail;
            this.status.cyclesCompleted += 1;
            this.status.lastError = "";
            this.status.lastDetail = `${agent.name} completed a turn in ${chat.title}.`;
            await dashboardStore.addActivity({
                source: "autonomy",
                agentId: agent.id,
                agentName: agent.name,
                status: "info",
                title: "Autonomy turn completed",
                detail
            });
            await teamRegistry.upsert({ id: agent.id, state: "idle", presence: "waiting" });
        }
        catch (error) {
            const message = describeError(error);
            loop.currentChatId = "";
            loop.lastError = message;
            loop.lastDetail = `${agent.name} failed: ${message}`;
            this.status.lastError = message;
            this.status.lastDetail = loop.lastDetail;
            await dashboardStore.addFailure(agent.id, `Autonomy turn failed for ${agent.name}`, message);
            await setAgentError(agent.id);
        }
        finally {
            loop.running = false;
            this.agentLoops.set(agentId, loop);
            if (this.status.active) {
                this.scheduleAgentRun(agentId, this.status.intervalMs);
            }
        }
    }
}
app.use(express.json({ limit: "4mb" }));
app.use("/experience/project", express.static(config.projectRoot, { index: false, extensions: ["html"] }));
app.use("/experience/shared", express.static(path.join(config.controlRoot, "apps", "desktop", "src", "shared"), { extensions: ["js", "html"] }));
app.use("/vendor/monaco", express.static(path.join(config.controlRoot, "node_modules", "monaco-editor", "min")));
function renderProjectExperienceFallback() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kirapolis Project Preview</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", Arial, sans-serif;
      background:
        radial-gradient(circle at top, rgba(255,153,51,0.18), transparent 42%),
        linear-gradient(180deg, #120b07 0%, #070707 100%);
      color: #f5efe8;
      display: grid;
      place-items: center;
      padding: 24px;
      box-sizing: border-box;
    }
    .shell {
      width: min(720px, 100%);
      border: 1px solid rgba(255,153,51,0.28);
      background: rgba(14, 10, 8, 0.9);
      box-shadow: 0 24px 80px rgba(0,0,0,0.45);
      border-radius: 24px;
      padding: 28px;
    }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-size: 12px;
      color: #ffad66;
      margin-bottom: 10px;
    }
    h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.1; }
    p { color: #d6c3b2; line-height: 1.55; }
    code {
      display: inline-block;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 2px 8px;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow">Workspace Preview</div>
    <h1>No project site entrypoint found yet</h1>
    <p>Kirapolis is serving the workspace root, but <code>${config.projectRoot.replace(/\\/g, "/")}/index.html</code> does not exist.</p>
    <p>The office background and workspace preview are still available, but the embedded project page will stay on this fallback until you point <code>KIRA_PROJECT_ROOT</code> at a runnable site or add an <code>index.html</code> there.</p>
  </main>
</body>
</html>`;
}
app.get(["/experience/project", "/experience/project/"], async (_req, res) => {
    const projectIndexPath = path.join(config.projectRoot, "index.html");
    if (await pathExists(projectIndexPath)) {
        return res.sendFile(projectIndexPath);
    }
    return res.status(200).type("html").send(renderProjectExperienceFallback());
});
app.use("/experience/office", express.static(path.join(config.controlRoot, "apps", "desktop", "src", "office"), { index: "index.html", extensions: ["html"] }));
app.get("/experience/office", (_req, res) => {
    return res.sendFile(path.join(config.controlRoot, "apps", "desktop", "src", "office", "index.html"));
});
app.get("/app", (_req, res) => {
    return res.sendFile(path.join(config.controlRoot, "apps", "desktop", "src", "index.html"));
});
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        provider: runtimeSettings.provider,
        models: runtimeSettings.models,
        workspaceRoot: config.workspaceRoot,
        controlRoot: config.controlRoot,
        projectRoot: config.projectRoot,
        ollamaBaseUrl: runtimeSettings.ollamaBaseUrl,
        openClawBaseUrl: runtimeSettings.openClawBaseUrl,
        memory: baseBrain.getStats()
    });
});
app.get("/api/integrations/railway/status", (_req, res) => {
    const webhookPath = "/api/integrations/railway/webhook";
    const manualPath = "/api/post-deploy/analyze";
    return res.json({
        ok: true,
        enabled: true,
        secretConfigured: Boolean(config.railwayWebhookSecret),
        publicBaseUrl: config.publicBaseUrl,
        webhookPath,
        manualPath,
        webhookUrl: `${config.publicBaseUrl}${webhookPath}`,
        manualUrl: `${config.publicBaseUrl}${manualPath}`,
        roomId: "group-post-deploy",
        specialistAgentIds: ["agent-postdeploy-monitor", "agent-visual-analyst"]
    });
});
app.post("/api/integrations/railway/webhook", async (req, res) => {
    try {
        const configuredSecret = String(config.railwayWebhookSecret || "").trim();
        const providedSecret = String(req.headers["x-kira-secret"] || req.headers["x-kirapolis-secret"] || req.headers["x-railway-signature"] || "").trim();
        if (configuredSecret && configuredSecret !== providedSecret) {
            return res.status(401).json({ error: "invalid railway webhook secret" });
        }
        const summary = await handleRailwayDeploymentEvent(req.body || {});
        return res.json({ ok: true, summary });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/post-deploy/analyze", async (req, res) => {
    const schema = z.object({
        url: z.string().optional(),
        service: z.string().optional(),
        environment: z.string().optional(),
        event: z.string().optional(),
        status: z.string().optional(),
        detail: z.string().optional(),
        deploymentId: z.string().optional()
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const summary = await handleRailwayDeploymentEvent({
            event: parsed.data.event || "manual-post-deploy-check",
            status: parsed.data.status || "queued",
            environment: parsed.data.environment || "production",
            service: parsed.data.service || "manual deployment",
            deploymentId: parsed.data.deploymentId || "",
            url: parsed.data.url || "",
            detail: parsed.data.detail || "Manual post-deployment check requested from Kirapolis."
        });
        return res.json({ ok: true, summary });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/remote/bootstrap", async (_req, res) => {
    const desktopSettings = await loadSharedDesktopSettings();
    return res.json({
        workspaceRoot: config.controlRoot,
        controlRoot: config.controlRoot,
        websiteProjectPath: desktopSettings.websiteProjectPath || config.projectRoot,
        deployProfile: {
            projectPath: desktopSettings.deployProjectPath || desktopSettings.websiteProjectPath || config.projectRoot,
            buildCommand: desktopSettings.deployBuildCommand || "",
            deployCommand: desktopSettings.deployCommand || ""
        },
        agentUrl: `http://127.0.0.1:${config.port}`,
        experienceUrl: `/experience/project/`,
        officeUrl: `/experience/office/`,
        agentLog: "Remote browser mode is connected directly to the Kira agent service.",
        remoteUrls: getReachableUrls()
    });
});
app.get("/api/remote/system-status", async (_req, res) => {
    const providerStatus = await getProviderStatus();
    const providerProbes = providerStatus?.providers || {};
    return res.json({
        agentProcessRunning: true,
        workspaceRoot: config.controlRoot,
        controlRoot: config.controlRoot,
        websiteProjectPath: config.projectRoot,
        agentUrl: `http://127.0.0.1:${config.port}`,
        experienceUrl: `/experience/project/`,
        officeUrl: `/experience/office/`,
        remoteUrls: getReachableUrls(),
        probes: {
            backend: {
                ok: true,
                url: `http://127.0.0.1:${config.port}/health`,
                detail: "reachable"
            },
            ollama: providerProbes.ollama || { ok: false, detail: "not reported" },
            openclaw: providerProbes.openclaw || { ok: false, detail: "not reported" }
        }
    });
});
app.get("/api/system/launch-readiness", async (_req, res) => {
    try {
        const desktopSettings = await loadSharedDesktopSettings();
        const providerStatus = await getProviderStatus();
        const signals = await buildExperienceSignals();
        const repo = await collectRepoSummary(config.projectRoot);
        return res.json({
            generatedAt: Date.now(),
            autonomy: teamHeartbeat.getStatus(),
            repo,
            director: signals.directorMode,
            summary: signals.summary,
            remoteUrls: getReachableUrls(),
            providerStatus,
            websiteProjectPath: desktopSettings.websiteProjectPath || config.projectRoot
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/system/backup", async (_req, res) => {
    try {
        const manifest = await createSystemBackupSnapshot();
        await dashboardStore.addActivity({
            agentId: "system",
            title: "System backup snapshot created",
            detail: manifest.backupRoot,
            source: "system",
            status: "done"
        });
        return res.json({ ok: true, ...manifest });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/remote/settings", async (req, res) => {
    const schema = z.object({
        websiteProjectPath: z.string().optional(),
        deployProjectPath: z.string().optional(),
        deployBuildCommand: z.string().optional(),
        deployCommand: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        return res.json(await saveSharedDesktopSettings(parsed.data));
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.all("/api/proxy", async (req, res) => {
    const target = String(req.query.target || "").trim();
    const targetPath = String(req.query.path || "").trim();
    const baseUrl = target === "ollama"
        ? runtimeSettings.ollamaBaseUrl
        : target === "openclaw"
            ? runtimeSettings.openClawBaseUrl
            : "";
    const proxyMethod = String(req.method || "GET").toUpperCase();
    const allowedProxyPaths = target === "ollama"
        ? {
            GET: new Set(["/api/tags", "/api/ps", "/api/version"]),
            POST: new Set(["/api/show", "/api/generate", "/api/chat", "/api/embed", "/api/embeddings"])
        }
        : target === "openclaw"
            ? {
                GET: new Set(["/v1/models"]),
                POST: new Set(["/v1/chat/completions"])
            }
            : { GET: new Set(), POST: new Set() };
    if (!baseUrl || !targetPath.startsWith("/")) {
        return res.status(400).json({ error: "invalid proxy target" });
    }
    if (!allowedProxyPaths[proxyMethod]?.has(targetPath)) {
        return res.status(405).json({ error: "proxy path not allowed" });
    }
    try {
        const response = await fetch(`${baseUrl.replace(/\/$/, "")}${targetPath}`, {
            method: proxyMethod,
            headers: {
                "content-type": "application/json"
            },
            body: proxyMethod === "GET" || proxyMethod === "HEAD" ? undefined : JSON.stringify(req.body || {})
        });
        const text = await response.text();
        res.status(response.status);
        try {
            return res.json(JSON.parse(text));
        }
        catch {
            return res.send(text);
        }
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/settings", (_req, res) => {
    res.json({
        provider: runtimeSettings.provider,
        models: runtimeSettings.models,
        ollamaBaseUrl: runtimeSettings.ollamaBaseUrl,
        openClawBaseUrl: runtimeSettings.openClawBaseUrl,
        workspaceRoot: config.workspaceRoot,
        controlRoot: config.controlRoot,
        projectRoot: config.projectRoot
    });
});
app.get("/api/providers/status", async (_req, res) => {
    try {
        return res.json(await getProviderStatus());
    }
    catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
    }
});
app.get("/api/providers/models", async (_req, res) => {
    try {
        return res.json(await getProviderModels());
    }
    catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
    }
});
app.get("/api/model-lab/status", async (_req, res) => {
    try {
        return res.json(await getModelLabStatus());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/model-lab/log", (_req, res) => {
    return res.json(serializeModelLabRuntime());
});
app.get("/api/model-lab/weight-unlearning/status", async (_req, res) => {
    try {
        return res.json((await getModelLabStatus()).weightUnlearning);
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
async function startWeightUnlearningProcess({ phase, command, args, cwd, currentJob, successTitle, successDetail }) {
    if (weightUnlearningRuntime.running) {
        throw new Error("a weight-unlearning job is already running");
    }
    weightUnlearningRuntime.running = true;
    weightUnlearningRuntime.phase = phase;
    weightUnlearningRuntime.startedAt = Date.now();
    weightUnlearningRuntime.finishedAt = 0;
    weightUnlearningRuntime.currentJob = currentJob;
    weightUnlearningRuntime.logEntries = [];
    weightUnlearningRuntime.lastResult = null;
    pushWeightUnlearningLog("system", `${phase} started.`);
    const child = spawn(command, args, {
        cwd,
        env: process.env,
        shell: false
    });
    weightUnlearningRuntime.process = child;
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
        const text = String(chunk || "");
        stdout += text;
        pushWeightUnlearningLog("stdout", text);
    });
    child.stderr?.on("data", (chunk) => {
        const text = String(chunk || "");
        stderr += text;
        pushWeightUnlearningLog("stderr", text);
    });
    child.on("error", (error) => {
        const detail = describeError(error);
        weightUnlearningRuntime.running = false;
        weightUnlearningRuntime.finishedAt = Date.now();
        weightUnlearningRuntime.process = null;
        weightUnlearningRuntime.lastResult = {
            ok: false,
            code: 1,
            stdout,
            stderr: `${stderr}${stderr ? "\n" : ""}${detail}`
        };
        pushWeightUnlearningLog("error", detail);
    });
    child.on("close", (code) => {
        weightUnlearningRuntime.running = false;
        weightUnlearningRuntime.finishedAt = Date.now();
        weightUnlearningRuntime.process = null;
        weightUnlearningRuntime.lastResult = {
            ok: (code ?? 0) === 0,
            code: code ?? 0,
            stdout,
            stderr
        };
        pushWeightUnlearningLog((code ?? 0) === 0 ? "system" : "error", (code ?? 0) === 0
            ? `${phase} finished.`
            : `${phase} failed with exit code ${code ?? 0}.`);
        void dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Weight Unlearning",
            status: (code ?? 0) === 0 ? "done" : "blocked",
            title: (code ?? 0) === 0 ? successTitle : `${phase} failed`,
            detail: (code ?? 0) === 0 ? successDetail : (stderr || stdout || "No details.")
        });
    });
}
app.post("/api/model-lab/chat", async (req, res) => {
    const schema = z.object({
        model: z.string().min(1),
        message: z.string().min(1),
        stage: z.enum(["before", "during", "after"]).optional(),
        style: z.string().optional(),
        traits: z.array(z.string()).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const stage = parsed.data.stage || "before";
    const traits = (parsed.data.traits || []).filter(Boolean).join(", ");
    const system = [
        stage === "before"
            ? "Respond as the model in its current state before neutralization."
            : stage === "during"
                ? "Respond as a model currently being neutralized. Be explicit about what style/persona traits are being suppressed."
                : "Respond as the neutralized model after reset. Stay clear, neutral, and task-focused.",
        parsed.data.style ? `Target style: ${parsed.data.style}` : "",
        traits ? `Traits being removed or suppressed: ${traits}.` : "",
        "Be honest about uncertainty and avoid claiming hidden memories."
    ].filter(Boolean).join("\n");
    try {
        const response = await postJson(`${runtimeSettings.ollamaBaseUrl.replace(/\/$/, "")}/api/chat`, {
            model: parsed.data.model,
            stream: false,
            messages: [
                { role: "system", content: system },
                { role: "user", content: parsed.data.message }
            ]
        });
        return res.json({
            ok: true,
            stage,
            model: parsed.data.model,
            response: String(response?.message?.content || response?.response || "").trim()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/neutralize", async (req, res) => {
    const schema = z.object({
        baseModel: z.string().min(1),
        derivedName: z.string().min(1),
        style: z.string().min(1),
        traits: z.array(z.string()).default([]),
        create: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        if (modelLabRuntime.running) {
            return res.status(409).json({
                error: "a neutralization run is already in progress",
                status: await getModelLabStatus()
            });
        }
        const args = [
            path.join(config.controlRoot, "scripts", "neutralize-ollama-model.mjs"),
            "--base-model",
            parsed.data.baseModel,
            "--derived-name",
            parsed.data.derivedName,
            "--style",
            parsed.data.style,
            "--traits",
            (parsed.data.traits || []).join(", ")
        ];
        if (parsed.data.create) {
            args.push("--create");
        }
        const startedAt = Date.now();
        modelLabRuntime.running = true;
        modelLabRuntime.startedAt = startedAt;
        modelLabRuntime.finishedAt = 0;
        modelLabRuntime.currentRun = {
            baseModel: parsed.data.baseModel,
            derivedName: parsed.data.derivedName,
            style: parsed.data.style,
            traits: parsed.data.traits || [],
            create: Boolean(parsed.data.create)
        };
        modelLabRuntime.logEntries = [];
        modelLabRuntime.lastResult = null;
        pushModelLabLog("system", `Starting neutralization for ${parsed.data.derivedName}.`);
        pushModelLabLog("system", `Execution target: ${getModelLabExecutionLabel()}.`);
        pushModelLabLog("system", `Base model: ${parsed.data.baseModel}`);
        pushModelLabLog("system", `Traits to remove: ${(parsed.data.traits || []).join(", ") || "none specified"}`);
        const child = spawn("node", args, {
            cwd: config.controlRoot,
            env: process.env,
            shell: false
        });
        modelLabRuntime.process = child;
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
            const text = String(chunk || "");
            stdout += text;
            pushModelLabLog("stdout", text);
        });
        child.stderr?.on("data", (chunk) => {
            const text = String(chunk || "");
            stderr += text;
            pushModelLabLog("stderr", text);
        });
        child.on("error", (error) => {
            const detail = describeError(error);
            stderr = `${stderr}${stderr ? "\n" : ""}${detail}`;
            modelLabRuntime.running = false;
            modelLabRuntime.finishedAt = Date.now();
            modelLabRuntime.process = null;
            modelLabRuntime.lastResult = {
                ok: false,
                code: 1,
                stdout,
                stderr,
                run: null
            };
            pushModelLabLog("error", detail);
            void dashboardStore.addActivity({
                source: "model-lab",
                agentId: "system",
                agentName: "Model Lab",
                status: "blocked",
                title: "Neutralization run failed",
                detail
            });
        });
        child.on("close", (code) => {
            const parsedJson = extractJsonObject(stdout);
            modelLabRuntime.running = false;
            modelLabRuntime.finishedAt = Date.now();
            modelLabRuntime.process = null;
            modelLabRuntime.lastResult = {
                ok: (code ?? 0) === 0,
                code: code ?? 0,
                stdout,
                stderr,
                run: parsedJson
            };
            pushModelLabLog((code ?? 0) === 0 ? "system" : "error", (code ?? 0) === 0
                ? `Neutralization finished for ${parsed.data.derivedName}.`
                : `Neutralization failed with exit code ${code ?? 0}.`);
            void dashboardStore.addActivity({
                source: "model-lab",
                agentId: "system",
                agentName: "Model Lab",
                status: (code ?? 0) === 0 ? "done" : "blocked",
                title: (code ?? 0) === 0 ? "Neutralization run created" : "Neutralization run failed",
                detail: parsedJson?.runDir || stderr || stdout || "No details."
            });
        });
        return res.json({
            ok: true,
            started: true,
            run: {
                ...modelLabRuntime.currentRun,
                startedAt
            },
            status: await getModelLabStatus()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/presets", async (req, res) => {
    const schema = z.object({
        id: z.string().optional(),
        label: z.string().min(1),
        model: z.string().min(1),
        notes: z.string().optional(),
        sourceRunDir: z.string().optional(),
        style: z.string().optional(),
        traits: z.array(z.string()).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const presets = await collectModelLabPresets();
        const id = parsed.data.id || `preset-${Date.now()}`;
        const nextPreset = {
            id,
            label: parsed.data.label.trim(),
            model: parsed.data.model.trim(),
            notes: parsed.data.notes || "",
            sourceRunDir: parsed.data.sourceRunDir || "",
            style: parsed.data.style || "",
            traits: parsed.data.traits || [],
            updatedAt: Date.now(),
            createdAt: presets.find((entry) => entry.id === id)?.createdAt || Date.now()
        };
        const next = [
            nextPreset,
            ...presets.filter((entry) => entry.id !== id)
        ].slice(0, 100);
        await saveModelLabPresets(next);
        await dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Model Lab",
            status: "done",
            title: "Model preset saved",
            detail: `${nextPreset.label} -> ${nextPreset.model}`
        });
        return res.json({
            ok: true,
            preset: nextPreset,
            presets: next
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/weight-unlearning/dataset", async (req, res) => {
    const schema = z.object({
        sourceRoot: z.string().min(1),
        datasetName: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const result = await runCommand("node", [
            path.join(config.controlRoot, "scripts", "build-weight-unlearning-dataset.mjs"),
            "--source-root",
            parsed.data.sourceRoot,
            ...(parsed.data.datasetName?.trim() ? ["--dataset-name", parsed.data.datasetName.trim()] : [])
        ], config.controlRoot);
        if (result.code !== 0) {
            return res.status(500).json({ error: result.stderr || result.stdout || "dataset build failed" });
        }
        await dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Weight Unlearning",
            status: "done",
            title: "Weight unlearning dataset built",
            detail: parsed.data.sourceRoot
        });
        return res.json({
            ok: true,
            result: extractJsonObject(result.stdout),
            status: (await getModelLabStatus()).weightUnlearning
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/weight-unlearning/prepare", async (req, res) => {
    const schema = z.object({
        datasetRoot: z.string().min(1),
        baseModelPath: z.string().min(1),
        precision: z.string().optional(),
        targetModules: z.string().optional(),
        gradientCheckpointing: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const prepareArgs = [
            path.join(config.controlRoot, "scripts", "prepare-weight-unlearning.mjs"),
            "--dataset-root",
            parsed.data.datasetRoot,
            "--base-model-path",
            parsed.data.baseModelPath
        ];
        if (parsed.data.precision) {
            prepareArgs.push("--precision", parsed.data.precision);
        }
        if (parsed.data.targetModules) {
            prepareArgs.push("--target-modules", parsed.data.targetModules);
        }
        if (parsed.data.gradientCheckpointing) {
            prepareArgs.push("--gradient-checkpointing");
        }
        const result = await runCommand("node", prepareArgs, config.controlRoot);
        if (result.code !== 0) {
            return res.status(500).json({ error: result.stderr || result.stdout || "job prepare failed" });
        }
        const payload = extractJsonObject(result.stdout);
        await dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Weight Unlearning",
            status: "done",
            title: "Weight unlearning job prepared",
            detail: payload?.runRoot || parsed.data.datasetRoot
        });
        return res.json({ ok: true, result: payload, status: (await getModelLabStatus()).weightUnlearning });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/weight-unlearning/train", async (req, res) => {
    const schema = z.object({
        configPath: z.string().min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        await startWeightUnlearningProcess({
            phase: "train",
            command: "python",
            args: [path.join(config.controlRoot, "scripts", "run-weight-unlearning.py"), "--config", parsed.data.configPath],
            cwd: config.controlRoot,
            currentJob: { configPath: parsed.data.configPath },
            successTitle: "Weight unlearning train completed",
            successDetail: parsed.data.configPath
        });
        return res.json({ ok: true, started: true, status: (await getModelLabStatus()).weightUnlearning });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/weight-unlearning/merge", async (req, res) => {
    const schema = z.object({
        configPath: z.string().min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        await startWeightUnlearningProcess({
            phase: "merge",
            command: "python",
            args: [path.join(config.controlRoot, "scripts", "merge-weight-unlearning.py"), "--config", parsed.data.configPath],
            cwd: config.controlRoot,
            currentJob: { configPath: parsed.data.configPath },
            successTitle: "Weight unlearning merge completed",
            successDetail: parsed.data.configPath
        });
        return res.json({ ok: true, started: true, status: (await getModelLabStatus()).weightUnlearning });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/weight-unlearning/eval", async (req, res) => {
    const schema = z.object({
        configPath: z.string().min(1),
        modelPath: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const configRaw = JSON.parse(await fs.readFile(parsed.data.configPath, "utf8"));
        const modelPath = parsed.data.modelPath?.trim() || configRaw.mergedOutputDir;
        await startWeightUnlearningProcess({
            phase: "eval",
            command: "python",
            args: [path.join(config.controlRoot, "scripts", "eval-weight-unlearning.py"), "--config", parsed.data.configPath, "--model-path", modelPath],
            cwd: config.controlRoot,
            currentJob: { configPath: parsed.data.configPath, modelPath },
            successTitle: "Weight unlearning evaluation completed",
            successDetail: modelPath
        });
        return res.json({ ok: true, started: true, status: (await getModelLabStatus()).weightUnlearning });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/reintroduction/stage", async (req, res) => {
    const schema = z.object({
        input: z.string().min(1),
        output: z.string().min(1),
        notes: z.string().optional(),
        label: z.string().optional(),
        weight: z.number().min(0).max(10).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const stagedSamples = await collectStagedTrainingSamples();
        const entry = {
            id: `staged-${Date.now()}`,
            createdAt: Date.now(),
            label: parsed.data.label || "staged-example",
            weight: Number(parsed.data.weight || 1),
            notes: parsed.data.notes || "",
            input: parsed.data.input,
            output: parsed.data.output
        };
        const next = [entry, ...stagedSamples].slice(0, 40);
        await saveStagedTrainingSamples(next);
        await dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Model Lab",
            status: "info",
            title: "Reintroduction example staged",
            detail: `${entry.label} is ready for dataset commit.`
        });
        return res.json({ ok: true, entry, stagedSamples: next, status: await getModelLabStatus() });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/reintroduction/commit", async (req, res) => {
    const schema = z.object({
        stageId: z.string().optional(),
        input: z.string().optional(),
        output: z.string().optional(),
        notes: z.string().optional(),
        label: z.string().optional(),
        weight: z.number().min(0).max(10).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const stagedSamples = await collectStagedTrainingSamples();
        const stagedMatch = parsed.data.stageId
            ? stagedSamples.find((entry) => entry.id === parsed.data.stageId) || null
            : null;
        const source = stagedMatch || {
            id: `sample-${Date.now()}`,
            createdAt: Date.now(),
            label: parsed.data.label || "manual-sample",
            weight: Number(parsed.data.weight || 1),
            notes: parsed.data.notes || "",
            input: parsed.data.input || "",
            output: parsed.data.output || ""
        };
        if (!String(source.input || "").trim() || !String(source.output || "").trim()) {
            return res.status(400).json({ error: "input and output are required" });
        }
        const root = getModelLabRoot();
        const samplesPath = path.join(root, "training-samples.jsonl");
        await fs.mkdir(root, { recursive: true });
        const entry = {
            ...source,
            id: `sample-${Date.now()}`,
            committedAt: Date.now()
        };
        await fs.appendFile(samplesPath, `${JSON.stringify(entry)}\n`, "utf8");
        const remaining = stagedMatch ? stagedSamples.filter((item) => item.id !== stagedMatch.id) : stagedSamples;
        await saveStagedTrainingSamples(remaining);
        await dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Model Lab",
            status: "done",
            title: "Reintroduction example committed",
            detail: `${entry.label} moved into the training dataset.`
        });
        return res.json({
            ok: true,
            entry,
            stagedSamples: remaining,
            samples: await collectTrainingSamples(),
            status: await getModelLabStatus()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/model-lab/training-samples", async (req, res) => {
    const schema = z.object({
        input: z.string().min(1),
        output: z.string().min(1),
        notes: z.string().optional(),
        label: z.string().optional(),
        weight: z.number().min(0).max(10).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const root = getModelLabRoot();
        const samplesPath = path.join(root, "training-samples.jsonl");
        await fs.mkdir(root, { recursive: true });
        const entry = {
            id: `sample-${Date.now()}`,
            createdAt: Date.now(),
            label: parsed.data.label || "manual-sample",
            weight: Number(parsed.data.weight || 1),
            notes: parsed.data.notes || "",
            input: parsed.data.input,
            output: parsed.data.output
        };
        await fs.appendFile(samplesPath, `${JSON.stringify(entry)}\n`, "utf8");
        await dashboardStore.addActivity({
            source: "model-lab",
            agentId: "system",
            agentName: "Model Lab",
            status: "done",
            title: "Training sample captured",
            detail: `${entry.label} saved with weight ${entry.weight}.`
        });
        return res.json({
            ok: true,
            entry,
            samples: await collectTrainingSamples()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/settings", (req, res) => {
    const schema = z.object({
        provider: z.enum(["ollama", "openclaw"]).optional(),
        models: z.object({
            executive: z.string().min(1).optional(),
            coder: z.string().min(1).optional(),
            fast: z.string().min(1).optional()
        }).optional(),
        ollamaBaseUrl: z.string().min(1).optional(),
        openClawBaseUrl: z.string().min(1).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    if (parsed.data.provider) {
        runtimeSettings.provider = parsed.data.provider;
    }
    if (parsed.data.models) {
        runtimeSettings.models = {
            ...runtimeSettings.models,
            ...parsed.data.models
        };
    }
    if (parsed.data.ollamaBaseUrl) {
        runtimeSettings.ollamaBaseUrl = parsed.data.ollamaBaseUrl.trim();
    }
    if (parsed.data.openClawBaseUrl) {
        runtimeSettings.openClawBaseUrl = parsed.data.openClawBaseUrl.trim();
    }
    return res.json({
        ok: true,
        provider: runtimeSettings.provider,
        models: runtimeSettings.models,
        ollamaBaseUrl: runtimeSettings.ollamaBaseUrl,
        openClawBaseUrl: runtimeSettings.openClawBaseUrl,
        workspaceRoot: config.workspaceRoot,
        controlRoot: config.controlRoot,
        projectRoot: config.projectRoot
    });
});
app.get("/api/dashboard", (_req, res) => {
    res.json(dashboardStore.getState());
});
app.get("/api/team/progression", (_req, res) => {
    const agents = teamRegistry.list();
    res.json({
        progression: progressionStore.listForAgents(agents),
        formula: getLevelFormulaText()
    });
});
app.get("/api/team/office", async (_req, res) => {
    try {
        return res.json(await buildOfficeSnapshot());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/experience/signals", async (_req, res) => {
    try {
        return res.json(await buildExperienceSignals());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team/progression/promote", async (req, res) => {
    const schema = z.object({
        agentId: z.string().min(1),
        stars: z.number().min(1).max(3)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const agent = teamRegistry.get(parsed.data.agentId);
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    try {
        const progression = await progressionStore.setStars(agent, parsed.data.stars);
        await dashboardStore.addActivity({
            source: "promotion",
            agentId: agent.id,
            agentName: agent.name,
            status: "done",
            title: `${agent.name} promotion updated`,
            detail: `${agent.name} is now at ${progression.stars} star${progression.stars === 1 ? "" : "s"} and level ${progression.level}.`
        });
        return res.json({ ok: true, progression });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/dashboard/brief", async (req, res) => {
    const schema = z.object({
        projectBrief: z.string()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const next = await dashboardStore.setProjectBrief(parsed.data.projectBrief);
        await broadcastScopedMemory(teamRegistry.list().map((agent) => agent.id), {
            kind: "fact",
            subject: "Shared project brief",
            summary: clipText(parsed.data.projectBrief, 180) || "Project brief updated.",
            detail: "Project-wide guidance that should stay available across agents.",
            tags: ["project-brief", "project"],
            scopeType: "project",
            scopeId: "global",
            sourceRole: "system",
            confidence: 0.92,
            salience: 0.96,
            pinned: true
        });
        return res.json(next);
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/dashboard/tasks", async (req, res) => {
    const schema = z.object({
        id: z.string().optional(),
        title: z.string().min(1),
        detail: z.string().optional(),
        status: z.enum(["todo", "doing", "done", "blocked"]).optional(),
        agentId: z.string().optional(),
        createdAt: z.number().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const previous = parsed.data.id ? dashboardStore.getState().tasks.find((task) => task.id === parsed.data.id) : null;
        const nextState = await dashboardStore.upsertTask(parsed.data);
        const targetAgents = parsed.data.agentId ? [parsed.data.agentId] : teamRegistry.list().map((agent) => agent.id);
        await broadcastScopedMemory(targetAgents, {
            kind: "task",
            subject: parsed.data.title,
            summary: parsed.data.title,
            detail: clipText(parsed.data.detail || "", 220) || `Task is ${parsed.data.status || "todo"}.`,
            tags: ["task", parsed.data.status || "todo", parsed.data.agentId || "unassigned"].filter(Boolean),
            scopeType: parsed.data.agentId ? "agent" : "project",
            scopeId: parsed.data.agentId || "global",
            sourceRole: "system",
            confidence: 0.82,
            salience: parsed.data.status === "blocked" ? 0.95 : 0.8
        });
        if (parsed.data.status === "done" && previous?.status !== "done" && parsed.data.agentId) {
            await awardAgentTaskCompletion(parsed.data.agentId, parsed.data.id || "", `${parsed.data.title}\n${parsed.data.detail || ""}`);
        }
        return res.json(nextState);
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.delete("/api/dashboard/tasks/:taskId", async (req, res) => {
    try {
        return res.json(await dashboardStore.removeTask(String(req.params.taskId || "")));
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/dashboard/assets", async (req, res) => {
    const schema = z.object({
        title: z.string().min(1),
        kind: z.string().min(1),
        url: z.string().min(1),
        notes: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        return res.json(await dashboardStore.addAsset({
            title: parsed.data.title,
            kind: parsed.data.kind,
            url: parsed.data.url,
            notes: parsed.data.notes || ""
        }));
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.delete("/api/dashboard/assets/:assetId", async (req, res) => {
    try {
        return res.json(await dashboardStore.removeAsset(String(req.params.assetId || "")));
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/dashboard/failures/clear", async (_req, res) => {
    try {
        return res.json(await dashboardStore.clearFailures());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/dashboard/activity/clear", async (_req, res) => {
    try {
        return res.json(await dashboardStore.clearActivity());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/sandbox/wipe", async (_req, res) => {
    try {
        const heartbeatStatus = teamHeartbeat.getStatus();
        const learningStatus = learningLoop.getStatus();
        learningLoop.stop();
        teamHeartbeat.stop();
        await dashboardStore.resetAll();
        await teamRegistry.wipeSandbox();
        await resumeAutomationAfterReset({ heartbeatStatus, learningStatus });
        return res.json({
            ok: true,
            detail: "Sandbox wiped. Chats, dashboard state, and agent memory databases were cleared, and the default team was restored."
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/system/reset", async (req, res) => {
    const schema = z.object({
        scope: z.enum(["files", "notes", "memory", "environment"])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        if (parsed.data.scope === "files") {
            const items = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceFile);
            const deleted = await deleteWorkspacePaths(items.map((item) => item.path));
            return res.json({ ok: true, scope: "files", deleted: deleted.length, detail: `Deleted ${deleted.length} workspace files.` });
        }
        if (parsed.data.scope === "notes") {
            const projectItems = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
            const controlItems = config.controlRoot !== config.projectRoot
                ? prefixWorkspaceIndexItems(await buildWorkspaceIndex(config.controlRoot, shouldIncludeWorkspaceNote), "__control__")
                : [];
            const deleted = await deleteWorkspacePaths([...projectItems, ...controlItems].map((item) => item.path));
            return res.json({ ok: true, scope: "notes", deleted: deleted.length, detail: `Deleted ${deleted.length} notes.` });
        }
        if (parsed.data.scope === "memory") {
            await teamRegistry.resetMemories();
            return res.json({ ok: true, scope: "memory", detail: "Agent memory databases were cleared." });
        }
        const heartbeatStatus = teamHeartbeat.getStatus();
        const learningStatus = learningLoop.getStatus();
        const fileItems = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceFile);
        const projectNotes = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
        const controlNotes = config.controlRoot !== config.projectRoot
            ? prefixWorkspaceIndexItems(await buildWorkspaceIndex(config.controlRoot, shouldIncludeWorkspaceNote), "__control__")
            : [];
        const deleted = await deleteWorkspacePaths([...fileItems, ...projectNotes, ...controlNotes].map((item) => item.path));
        await teamRegistry.resetMemories();
        learningLoop.stop();
        teamHeartbeat.stop();
        await dashboardStore.resetAll();
        await resumeAutomationAfterReset({ heartbeatStatus, learningStatus });
        return res.json({ ok: true, scope: "environment", deleted: deleted.length, detail: `Environment wiped. Deleted ${deleted.length} files and notes, and cleared chats plus memory.` });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/messenger", (_req, res) => {
    res.json(dashboardStore.getState().messenger);
});
app.get("/api/messenger/groups/:chatId/artifacts", async (req, res) => {
    try {
        const chatId = String(req.params.chatId || "");
        if (!chatId) {
            return res.status(400).json({ error: "chat id required" });
        }
        const state = dashboardStore.getState();
        const chat = state.messenger.chats.find((entry) => entry.id === chatId && entry.type === "group");
        if (!chat) {
            return res.status(404).json({ error: "group chat not found" });
        }
        return res.json({ items: await listGroupArtifacts(chatId) });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/messenger", async (req, res) => {
    const schema = z.object({
        chats: z.array(z.object({
            id: z.string(),
            type: z.enum(["direct", "group"]),
            title: z.string(),
            members: z.array(z.string()),
            lastReadAt: z.number().default(0),
            origin: z.enum(["user", "system", "agent"]).default("system"),
            messages: z.array(z.object({
                id: z.string(),
                role: z.string(),
                author: z.string(),
                content: z.string(),
                createdAt: z.number()
            }))
        })),
        activeChatId: z.string().nullable(),
        groupBuilderOpen: z.boolean(),
        dismissedChatIds: z.array(z.string()).default([])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const state = await dashboardStore.setMessengerState(parsed.data);
        return res.json(state.messenger);
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/local/workbench", async (_req, res) => {
    try {
        return res.json(await buildLocalWorkbenchPayload());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/local/agents/from-model", async (req, res) => {
    const schema = z.object({
        label: z.string().optional(),
        role: z.enum(["executive", "coder", "runner"]).optional(),
        provider: z.enum(["ollama", "openclaw"]).optional(),
        model: z.string().min(1),
        specialty: z.string().optional(),
        notes: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const sourceModel = parsed.data.model.trim();
        const agent = await teamRegistry.upsert({
            name: parsed.data.label?.trim() || `Local ${sourceModel.split(/[/:]/).slice(-1)[0] || "Specialist"}`,
            role: parsed.data.role || "runner",
            provider: parsed.data.provider || "ollama",
            model: sourceModel,
            sourceModel,
            specialty: parsed.data.specialty || "Local tuned model",
            notes: parsed.data.notes || `Built from tuned model ${sourceModel} for the local workstation surface.`,
            surface: "local"
        });
        await progressionStore.ensureAgents(teamRegistry.list());
        await ensureDefaultGroupChat();
        await ensureLocalWorkbenchGroupChat();
        return res.json({
            ok: true,
            agent: withProgression(agent),
            workbench: await buildLocalWorkbenchPayload()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/local/agents/:agentId/model", async (req, res) => {
    const schema = z.object({
        model: z.string().min(1),
        provider: z.enum(["ollama", "openclaw"]).optional(),
        sourceModel: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const agentId = String(req.params.agentId || "");
    const existing = teamRegistry.get(agentId);
    if (!existing) {
        return res.status(404).json({ error: "agent not found" });
    }
    if (String(existing.surface || "shared") !== "local") {
        return res.status(400).json({ error: "only local agents can be assigned from the local workbench" });
    }
    try {
        const agent = await teamRegistry.upsert({
            id: agentId,
            model: parsed.data.model.trim(),
            sourceModel: String(parsed.data.sourceModel || parsed.data.model).trim(),
            provider: parsed.data.provider || existing.provider || "ollama",
            surface: "local"
        });
        await ensureDefaultGroupChat();
        await ensureLocalWorkbenchGroupChat();
        return res.json({
            ok: true,
            agent: withProgression(agent),
            workbench: await buildLocalWorkbenchPayload()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/local/rooms", async (req, res) => {
    const schema = z.object({
        id: z.string().optional(),
        type: z.enum(["direct", "group"]).default("group"),
        title: z.string().optional(),
        members: z.array(z.string()).default([])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const memberIds = uniqueValidMemberIds(parsed.data.members);
        if (parsed.data.type === "direct" && memberIds.length !== 2) {
            return res.status(400).json({ error: "direct threads require exactly two members" });
        }
        if (parsed.data.type === "group" && memberIds.length < 2) {
            return res.status(400).json({ error: "group rooms require at least two members" });
        }
        const state = dashboardStore.getState();
        const requestedTitle = String(parsed.data.title || "").trim();
        const title = requestedTitle || (parsed.data.type === "direct" ? buildDirectRoomTitle(memberIds) : "Local Group Room");
        const chatId = String(parsed.data.id || `${parsed.data.type}-${slugifyName(title)}-${Date.now().toString(36)}`);
        let chat = state.messenger.chats.find((entry) => entry.id === chatId) || null;
        if (chat) {
            chat.type = parsed.data.type;
            chat.title = title;
            chat.members = memberIds;
            chat.origin = "user";
            chat.messages = Array.isArray(chat.messages) ? chat.messages : [];
        }
        else {
            chat = {
                id: chatId,
                type: parsed.data.type,
                title,
                members: memberIds,
                messages: [],
                lastReadAt: 0,
                origin: "user"
            };
            state.messenger.chats.unshift(chat);
        }
        state.messenger.activeChatId = chat.id;
        await dashboardStore.setMessengerState(state.messenger);
        return res.json({
            ok: true,
            chat,
            workbench: await buildLocalWorkbenchPayload()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/team/agents", (_req, res) => {
    res.json({ agents: listAgentsWithProgression() });
});
app.get("/api/team/agents/:agentId/memory", async (req, res) => {
    const agentId = String(req.params.agentId || "");
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    try {
        const brain = await teamRegistry.getBrain(agent.id);
        const limit = Number(req.query.limit || 20);
        const scopeType = req.query.scopeType ? String(req.query.scopeType) : undefined;
        const scopeId = req.query.scopeId ? String(req.query.scopeId) : undefined;
        const kind = req.query.kind ? String(req.query.kind) : undefined;
        const includeArchived = String(req.query.includeArchived || "") === "true";
        return res.json({
            ok: true,
            memory: brain.listMemoryItems({ limit, scopeType, scopeId, kind, includeArchived }),
            stats: brain.getStats()
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.patch("/api/team/agents/:agentId/memory/:memoryId", async (req, res) => {
    const agentId = String(req.params.agentId || "");
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    const schema = z.object({
        summary: z.string().optional(),
        detail: z.string().optional(),
        status: z.string().optional(),
        pinned: z.boolean().optional(),
        confidence: z.number().min(0).max(1).optional(),
        salience: z.number().min(0).max(1).optional(),
        tags: z.array(z.string()).optional(),
        relatedId: z.string().optional(),
        relation: z.string().optional(),
        linkDetail: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const brain = await teamRegistry.getBrain(agent.id);
        const memory = brain.updateMemoryItem(String(req.params.memoryId || ""), parsed.data);
        if (!memory) {
            return res.status(404).json({ error: "memory not found" });
        }
        return res.json({ ok: true, memory });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.delete("/api/team/agents/:agentId/memory/:memoryId", async (req, res) => {
    const agentId = String(req.params.agentId || "");
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    try {
        const brain = await teamRegistry.getBrain(agent.id);
        const ok = brain.forgetMemoryItem(String(req.params.memoryId || ""));
        if (!ok) {
            return res.status(404).json({ error: "memory not found" });
        }
        return res.json({ ok: true });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team/agents/:agentId/memory/consolidate", async (req, res) => {
    const agentId = String(req.params.agentId || "");
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    const schema = z.object({
        scopeType: z.string().optional(),
        scopeId: z.string().optional()
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const brain = await teamRegistry.getBrain(agent.id);
        const memory = await brain.consolidateMemories(parsed.data.scopeType || "agent", parsed.data.scopeId || agent.id);
        return res.json({ ok: true, memory, stats: brain.getStats() });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team/agents/:agentId/memory/episodes", async (req, res) => {
    const agentId = String(req.params.agentId || "");
    const agent = teamRegistry.get(agentId);
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    const schema = z.object({
        title: z.string().min(1),
        action: z.string().optional(),
        outcome: z.string().optional(),
        nextStep: z.string().optional(),
        scopeType: z.string().optional(),
        scopeId: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const brain = await teamRegistry.getBrain(agent.id);
        const episode = await brain.recordEpisode({
            ...parsed.data,
            scopeType: parsed.data.scopeType || "agent",
            scopeId: parsed.data.scopeId || agent.id,
            source: "manual-episode",
            sourceRole: "system"
        });
        return res.json({ ok: true, episode, stats: brain.getStats() });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team/agents", async (req, res) => {
    const schema = z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        role: z.enum(["executive", "coder", "runner"]).optional(),
        lotId: z.string().optional(),
        posX: z.number().optional(),
        posY: z.number().optional(),
        surface: z.enum(["shared", "local", "railway"]).optional(),
        provider: z.enum(["ollama", "openclaw"]).optional(),
        model: z.string().optional(),
        specialty: z.string().optional(),
        sourceModel: z.string().optional(),
        tools: z.array(z.string()).optional(),
        skills: z.array(z.string()).optional(),
        notes: z.string().optional(),
        lastBrief: z.string().optional(),
        lastResponse: z.string().optional(),
        state: z.string().optional(),
        presence: z.string().optional(),
        workspacePath: z.string().optional(),
        repoBranch: z.string().optional(),
        memoryPath: z.string().optional(),
        personaId: z.string().optional(),
        usePersonaModel: z.boolean().optional(),
        isManager: z.boolean().optional(),
        createdAt: z.number().optional(),
        updatedAt: z.number().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    if (parsed.data.personaId && !personaRegistry.get(parsed.data.personaId)) {
        return res.status(400).json({ error: "persona not found" });
    }
    try {
        const agent = await teamRegistry.upsert(parsed.data);
        await progressionStore.ensureAgents(teamRegistry.list());
        return res.json({ ok: true, agent: withProgression(agent) });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.delete("/api/team/agents/:agentId", async (req, res) => {
    const agentId = String(req.params.agentId || "");
    if (!agentId) {
        return res.status(400).json({ error: "agent id required" });
    }
    try {
        const removed = await teamRegistry.remove(agentId);
        if (!removed) {
            return res.status(404).json({ error: "agent not found" });
        }
        await progressionStore.remove(agentId);
        return res.json({ ok: true });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/personas", (_req, res) => {
    res.json({ personas: personaRegistry.list() });
});
app.post("/api/personas", async (req, res) => {
    const schema = z.object({
        id: z.string().optional(),
        label: z.string().min(1),
        baseRole: z.enum(["executive", "coder", "runner"]).optional(),
        targetLayer: z.string().optional(),
        description: z.string().optional(),
        voice: z.string().optional(),
        promptAddendum: z.string().optional(),
        model: z.string().optional(),
        trainingProfileId: z.string().optional(),
        tags: z.array(z.string()).optional(),
        createdAt: z.number().optional(),
        updatedAt: z.number().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const persona = await personaRegistry.upsert(parsed.data);
        return res.json({ ok: true, persona });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.delete("/api/personas/:personaId", async (req, res) => {
    const personaId = String(req.params.personaId || "");
    if (!personaId) {
        return res.status(400).json({ error: "persona id required" });
    }
    if (teamRegistry.list().some((agent) => agent.personaId === personaId)) {
        return res.status(400).json({ error: "persona is still assigned to one or more agents" });
    }
    try {
        const removed = await personaRegistry.remove(personaId);
        if (!removed) {
            return res.status(404).json({ error: "persona not found" });
        }
        return res.json({ ok: true });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team/snapshot", async (req, res) => {
    const schema = z.object({
        agents: z.array(z.object({
            id: z.string().optional(),
            name: z.string().optional(),
            role: z.enum(["executive", "coder", "runner"]).optional(),
            lotId: z.string().optional(),
            posX: z.number().optional(),
            posY: z.number().optional(),
            provider: z.enum(["ollama", "openclaw"]).optional(),
            model: z.string().optional(),
            tools: z.array(z.string()).optional(),
            skills: z.array(z.string()).optional(),
            notes: z.string().optional(),
            lastBrief: z.string().optional(),
            lastResponse: z.string().optional(),
            state: z.string().optional(),
            presence: z.string().optional(),
            workspacePath: z.string().optional(),
            repoBranch: z.string().optional(),
            memoryPath: z.string().optional(),
            personaId: z.string().optional(),
            usePersonaModel: z.boolean().optional(),
            isManager: z.boolean().optional(),
            createdAt: z.number().optional(),
            updatedAt: z.number().optional()
        }))
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const agents = await teamRegistry.replaceAll(parsed.data.agents);
        return res.json({ ok: true, agents });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/team-heartbeat/status", (_req, res) => {
    res.json(teamHeartbeat.getStatus());
});
app.get("/api/autonomy", (_req, res) => {
    res.json(teamHeartbeat.getStatus());
});
app.post("/api/autonomy", async (req, res) => {
    const schema = z.object({
        active: z.boolean(),
        intervalMs: z.number().int().min(15000).max(3600000).optional(),
        maxAgentsPerCycle: z.number().int().min(1).max(64).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        if (parsed.data.active) {
            const current = teamHeartbeat.getStatus();
            return res.json(await teamHeartbeat.start(parsed.data.intervalMs || current.intervalMs || 60000, parsed.data.maxAgentsPerCycle || current.maxAgentsPerCycle || 8));
        }
        return res.json(teamHeartbeat.stop());
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team-heartbeat/start", async (req, res) => {
    const schema = z.object({
        intervalMs: z.number().int().min(15000).max(3600000).optional(),
        maxAgentsPerCycle: z.number().int().min(1).max(64).optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        return res.json(await teamHeartbeat.start(parsed.data.intervalMs, parsed.data.maxAgentsPerCycle));
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team-heartbeat/stop", (_req, res) => {
    res.json(teamHeartbeat.stop());
});
app.post("/api/team/chat", async (req, res) => {
    const schema = z.object({
        agentId: z.string().min(1),
        prompt: z.string().min(1),
        mode: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        if (!teamRegistry.get(parsed.data.agentId)) {
            return res.status(404).json({ error: "agent not found" });
        }
        const execution = await executeAgentPrompt(parsed.data.agentId, parsed.data.prompt, parsed.data.mode || "dispatch");
        return res.json({
            ...execution.result,
            agent: execution.agent
        });
    }
    catch (error) {
        await dashboardStore.addFailure("team-chat", `Agent chat failed for ${parsed.data.agentId}`, describeError(error));
        const failedAgent = teamRegistry.get(parsed.data.agentId);
        await setAgentError(parsed.data.agentId);
        await recordAgentActivity(failedAgent, parsed.data.mode === "messenger" ? "messenger" : "dispatch", "issue", `${failedAgent?.name || parsed.data.agentId} failed`, describeError(error));
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/team/agents/:agentId/git/status", async (req, res) => {
    const agent = teamRegistry.get(String(req.params.agentId || ""));
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    try {
        const insideTree = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], agent.workspacePath);
        if (insideTree.code !== 0 || !insideTree.stdout.trim().includes("true")) {
            return res.json({
                ok: false,
                branch: "",
                remote: "",
                detail: "Selected folder is not a git repository.",
                status: insideTree.stderr.trim() || insideTree.stdout.trim()
            });
        }
        const branch = await runCommand("git", ["branch", "--show-current"], agent.workspacePath);
        const remote = await runCommand("git", ["remote", "get-url", "origin"], agent.workspacePath);
        const status = await runCommand("git", ["status", "--short", "--branch"], agent.workspacePath);
        return res.json({
            ok: true,
            branch: branch.stdout.trim(),
            remote: remote.code === 0 ? remote.stdout.trim() : "",
            detail: "Repository detected.",
            status: `${status.stdout}${status.stderr}`.trim() || "Working tree clean."
        });
    }
    catch (error) {
        await dashboardStore.addFailure("git-status", `Git status failed for ${agent.id}`, describeError(error));
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/team/agents/:agentId/git/push", async (req, res) => {
    const schema = z.object({
        message: z.string().min(1),
        branch: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const agent = teamRegistry.get(String(req.params.agentId || ""));
    if (!agent) {
        return res.status(404).json({ error: "agent not found" });
    }
    try {
        const gitCheck = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], agent.workspacePath);
        if (gitCheck.code !== 0 || !gitCheck.stdout.trim().includes("true")) {
            await recordAgentActivity(agent, "git", "issue", `${agent.name} push blocked`, "Selected folder is not a git repository.");
            return res.status(400).json({ error: "selected folder is not a git repository" });
        }
        const verification = await runPushGateVerification(agent);
        if (!verification.ok) {
            await recordAgentActivity(agent, "git", "issue", `${agent.name} push blocked by verification`, verification.detail);
            return res.status(400).json({ error: `push blocked by verification gate: ${verification.detail}` });
        }
        const add = await runCommand("git", ["add", "-A"], agent.workspacePath);
        if (add.code !== 0) {
            await recordAgentActivity(agent, "git", "issue", `${agent.name} git add failed`, add.stderr.trim() || "git add failed");
            return res.status(500).json({ error: add.stderr.trim() || "git add failed" });
        }
        const commit = await runCommand("git", ["commit", "-m", parsed.data.message], agent.workspacePath);
        const commitOutput = `${commit.stdout}${commit.stderr}`.trim();
        const nothingToCommit = /nothing to commit|working tree clean/i.test(commitOutput);
        if (commit.code !== 0 && !nothingToCommit) {
            await recordAgentActivity(agent, "git", "issue", `${agent.name} git commit failed`, commitOutput || "git commit failed");
            return res.status(500).json({ error: commitOutput || "git commit failed" });
        }
        const pushArgs = parsed.data.branch
            ? ["push", "origin", parsed.data.branch]
            : ["push"];
        const push = await runCommand("git", pushArgs, agent.workspacePath);
        if (push.code !== 0) {
            await recordAgentActivity(agent, "git", "issue", `${agent.name} git push failed`, `${push.stdout}${push.stderr}`.trim() || "git push failed");
            return res.status(500).json({ error: `${push.stdout}${push.stderr}`.trim() || "git push failed" });
        }
        await recordAgentActivity(agent, "git", "done", `${agent.name} pushed to GitHub`, `${nothingToCommit ? "No new commit was needed. Push completed." : parsed.data.message} | ${verification.detail}`);
        return res.json({
            ok: true,
            detail: `${nothingToCommit ? "No new commit was needed. Push completed." : "Changes committed and pushed."} | ${verification.detail}`,
            commit: commitOutput || "Commit complete.",
            push: `${push.stdout}${push.stderr}`.trim()
        });
    }
    catch (error) {
        await dashboardStore.addFailure("git-push", `Git push failed for ${agent.id}`, describeError(error));
        await setAgentError(agent.id);
        await recordAgentActivity(agent, "git", "issue", `${agent.name} push failed`, describeError(error));
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/chat", async (req, res) => {
    const schema = z.object({
        prompt: z.string().min(1)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const result = await runKiraChat({ ...config, ...runtimeSettings }, baseBrain, parsed.data.prompt, {
            mode: "manual-chat",
            prompt: parsed.data.prompt
        });
        return res.json(result);
    }
    catch (error) {
        await dashboardStore.addFailure("chat", "Base chat request failed", describeError(error));
        return res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
    }
});
app.get("/api/learning/status", (_req, res) => {
    res.json(learningLoop.getStatus());
});
app.post("/api/learning/start", async (req, res) => {
    const schema = z.object({
        topic: z.string().min(1),
        intervalMs: z.number().int().min(5000).max(3600000).optional(),
        maxCycles: z.number().int().min(1).max(100).nullable().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        const status = await learningLoop.start(parsed.data.topic, parsed.data.intervalMs ?? 60000, parsed.data.maxCycles ?? 10);
        await dashboardStore.addActivity({
            source: "learning",
            agentId: "",
            agentName: "Kirapolis",
            status: "working",
            title: "Learning loop started",
            detail: `${status.topic} | interval ${status.intervalMs}ms`
        });
        return res.json(status);
    }
    catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
    }
});
app.post("/api/learning/stop", (_req, res) => {
    const status = learningLoop.stop();
    void dashboardStore.addActivity({
        source: "learning",
        agentId: "",
        agentName: "Kirapolis",
        status: "info",
        title: "Learning loop stopped",
        detail: status.topic ? `Last topic: ${status.topic}` : "No active topic."
    });
    res.json(status);
});
app.post("/api/tools/exec", async (req, res) => {
    const schema = z.object({
        command: z.string().min(1),
        cwd: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const cwd = resolveCwd(parsed.data.cwd);
    const result = await runCommand(config.shell, ["-NoProfile", "-Command", parsed.data.command], cwd);
    return res.json(result);
});
app.post("/api/deploy/verify", async (req, res) => {
    const schema = z.object({
        cwd: z.string().min(1),
        buildCommand: z.string().optional(),
        deployCommand: z.string().optional()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const cwd = resolveCwd(parsed.data.cwd);
    const packageJsonPath = path.join(cwd, "package.json");
    const packageJsonExists = await pathExists(packageJsonPath);
    const scripts = packageJsonExists ? await readPackageScripts(cwd) : {};
    const insideTree = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    const suggestedBuild = typeof scripts.build === "string" ? "npm run build" : "";
    const suggestedDeploy = typeof scripts.deploy === "string"
        ? "npm run deploy"
        : (typeof scripts.start === "string" ? "npm run start" : "");
    return res.json({
        ok: true,
        cwd,
        packageJsonExists,
        scripts: Object.keys(scripts),
        git: insideTree.code === 0 && insideTree.stdout.trim().includes("true"),
        buildCommand: parsed.data.buildCommand?.trim() || suggestedBuild,
        deployCommand: parsed.data.deployCommand?.trim() || suggestedDeploy
    });
});
app.post("/api/deploy/run", async (req, res) => {
    const schema = z.object({
        cwd: z.string().min(1),
        command: z.string().min(1),
        kind: z.enum(["build", "deploy"])
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const cwd = resolveCwd(parsed.data.cwd);
    const result = await runCommand(config.shell, ["-NoProfile", "-Command", parsed.data.command], cwd);
    return res.json({
        ok: result.code === 0,
        kind: parsed.data.kind,
        cwd,
        command: parsed.data.command,
        ...result
    });
});
app.get("/api/workspace/read", async (req, res) => {
    const relativePath = String(req.query.path || "");
    if (!relativePath) {
        return res.status(400).json({ error: "path required" });
    }
    const usingControlPrefix = relativePath.startsWith("__control__/");
    const baseRoot = usingControlPrefix ? config.controlRoot : config.projectRoot;
    const strippedPath = usingControlPrefix ? relativePath.slice("__control__/".length) : relativePath;
    const absolutePath = path.resolve(baseRoot, strippedPath);
    const relativeToRoot = path.relative(baseRoot, absolutePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
        return res.status(400).json({ error: "path outside allowed root" });
    }
    try {
        const content = await fs.readFile(absolutePath, "utf8");
        return res.json({ path: absolutePath, content });
    }
    catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
    }
});
app.get("/api/workspace/files/index", async (_req, res) => {
    try {
        const items = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceFile);
        return res.json({
            root: config.projectRoot,
            items: items.sort((left, right) => left.path.localeCompare(right.path))
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.get("/api/workspace/notes/index", async (_req, res) => {
    try {
        const projectItems = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
        const controlItems = config.controlRoot !== config.projectRoot
            ? prefixWorkspaceIndexItems(await buildWorkspaceIndex(config.controlRoot, shouldIncludeWorkspaceNote), "__control__")
            : [];
        const items = [...projectItems, ...controlItems];
        return res.json({
            root: config.projectRoot,
            items: items.sort((left, right) => right.updatedAt - left.updatedAt)
        });
    }
    catch (error) {
        return res.status(500).json({ error: describeError(error) });
    }
});
app.post("/api/workspace/delete", async (req, res) => {
    const schema = z.object({
        paths: z.array(z.string().min(1)).min(1).max(200)
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const deleted = await deleteWorkspacePaths(parsed.data.paths);
    return res.json({ ok: true, deleted });
});
app.post("/api/workspace/write", async (req, res) => {
    const schema = z.object({
        path: z.string().min(1),
        content: z.string()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    const usingControlPrefix = parsed.data.path.startsWith("__control__/");
    const baseRoot = usingControlPrefix ? config.controlRoot : config.projectRoot;
    const strippedPath = usingControlPrefix ? parsed.data.path.slice("__control__/".length) : parsed.data.path;
    const absolutePath = path.resolve(baseRoot, strippedPath);
    const relativeToRoot = path.relative(baseRoot, absolutePath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
        return res.status(400).json({ error: "path outside workspace" });
    }
    try {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, parsed.data.content, "utf8");
        return res.json({ ok: true, path: absolutePath });
    }
    catch (error) {
        return res.status(500).json({ error: error instanceof Error ? error.message : "unknown error" });
    }
});
app.get("/api/fs/ls", async (req, res) => {
    const requestedPath = String(req.query.path || "").trim();
    if (!requestedPath && process.platform === "win32") {
        const drives = [];
        for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
            const drivePath = `${letter}:\\`;
            try {
                await fs.access(drivePath);
                drives.push({ name: `${letter}:`, path: drivePath, type: "drive" });
            } catch {}
        }
        return res.json({ path: "", parent: null, entries: drives });
    }
    const targetPath = path.resolve(requestedPath || os.homedir());
    const resolved = path.dirname(targetPath);
    const parentPath = resolved !== targetPath ? resolved : null;
    try {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
            .map((e) => ({ name: e.name, path: path.join(targetPath, e.name), type: "dir" }))
            .sort((a, b) => a.name.localeCompare(b.name));
        return res.json({ path: targetPath, parent: parentPath, entries: dirs });
    } catch (error) {
        return res.status(400).json({ error: describeError(error) });
    }
});

// --- Obsidian-style notes layer ---

function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const block = match[1];
    const result = {};
    for (const line of block.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const raw = line.slice(colon + 1).trim();
        if (!key) continue;
        if (raw.startsWith("[") && raw.endsWith("]")) {
            result[key] = raw.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        } else {
            result[key] = raw.replace(/^["']|["']$/g, "");
        }
    }
    return result;
}

function extractWikilinks(content) {
    return [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => {
        const inner = m[1];
        const [linkPart] = inner.split("|");
        const [filePart] = linkPart.split("#");
        return filePart.trim();
    });
}

async function readNoteContent(notePath, usingControlPrefix) {
    const baseRoot = usingControlPrefix ? config.controlRoot : config.projectRoot;
    const strippedPath = usingControlPrefix ? notePath.slice("__control__/".length) : notePath;
    try {
        return await fs.readFile(path.resolve(baseRoot, strippedPath), "utf8");
    } catch {
        return null;
    }
}

app.get("/api/notes/daily", async (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const notePath = path.join(config.controlRoot, "docs", "daily", `${today}.md`);
    const relPath = path.relative(config.controlRoot, notePath).replace(/\\/g, "/");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    let content;
    let created = false;
    try {
        content = await fs.readFile(notePath, "utf8");
    } catch {
        content = `# ${today}\n\n`;
        await fs.writeFile(notePath, content, "utf8");
        created = true;
    }
    return res.json({ path: relPath, content, date: today, created });
});

app.post("/api/notes/daily", async (req, res) => {
    const schema = z.object({ text: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid request" });
    const today = new Date().toISOString().slice(0, 10);
    const notePath = path.join(config.controlRoot, "docs", "daily", `${today}.md`);
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    let existing = "";
    try { existing = await fs.readFile(notePath, "utf8"); } catch { existing = `# ${today}\n\n`; }
    const updated = existing.trimEnd() + "\n\n" + parsed.data.text.trim() + "\n";
    await fs.writeFile(notePath, updated, "utf8");
    const relPath = path.relative(config.controlRoot, notePath).replace(/\\/g, "/");
    return res.json({ ok: true, path: relPath });
});

app.get("/api/notes/backlinks", async (req, res) => {
    const targetPath = String(req.query.path || "").trim();
    if (!targetPath) return res.status(400).json({ error: "path required" });
    const targetName = path.posix.basename(targetPath, path.posix.extname(targetPath)).toLowerCase();
    const targetNormalized = targetPath.toLowerCase();
    const projectItems = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
    const controlItems = config.controlRoot !== config.projectRoot
        ? prefixWorkspaceIndexItems(await buildWorkspaceIndex(config.controlRoot, shouldIncludeWorkspaceNote), "__control__")
        : [];
    const allNotes = [...projectItems, ...controlItems];
    const backlinks = [];
    for (const note of allNotes) {
        if (note.path === targetPath) continue;
        const usingControlPrefix = note.path.startsWith("__control__/");
        const content = await readNoteContent(note.path, usingControlPrefix);
        if (!content) continue;
        const links = extractWikilinks(content);
        const matches = links.some((link) => link.toLowerCase() === targetName || link.toLowerCase() === targetNormalized);
        if (matches) {
            const excerpt = content.split(/\r?\n/).find((line) => /\[\[/.test(line))?.trim() || "";
            backlinks.push({ path: note.path, name: note.name, excerpt });
        }
    }
    return res.json({ target: targetPath, backlinks });
});

app.get("/api/notes/resolve", async (req, res) => {
    const link = String(req.query.link || "").trim();
    if (!link) return res.status(400).json({ error: "link required" });
    const linkLower = link.toLowerCase();
    const projectItems = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
    const controlItems = config.controlRoot !== config.projectRoot
        ? prefixWorkspaceIndexItems(await buildWorkspaceIndex(config.controlRoot, shouldIncludeWorkspaceNote), "__control__")
        : [];
    const allNotes = [...projectItems, ...controlItems];
    const match = allNotes.find((note) => {
        const nameNoExt = path.posix.basename(note.path, path.posix.extname(note.path)).toLowerCase();
        return nameNoExt === linkLower || note.path.toLowerCase() === linkLower;
    });
    if (!match) return res.status(404).json({ error: "note not found", link });
    const usingControlPrefix = match.path.startsWith("__control__/");
    const content = await readNoteContent(match.path, usingControlPrefix);
    const frontmatter = content ? parseFrontmatter(content) : {};
    return res.json({ path: match.path, name: match.name, content: content ?? "", frontmatter });
});

app.get("/api/notes/frontmatter", async (req, res) => {
    const notePath = String(req.query.path || "").trim();
    if (!notePath) return res.status(400).json({ error: "path required" });
    const usingControlPrefix = notePath.startsWith("__control__/");
    const content = await readNoteContent(notePath, usingControlPrefix);
    if (content === null) return res.status(404).json({ error: "note not found" });
    return res.json({ path: notePath, frontmatter: parseFrontmatter(content) });
});

// --- end notes layer ---

await baseBrain.init();
await personaRegistry.init();
await teamRegistry.init();
await progressionStore.init();
await ensurePostDeploySpecialists();
await ensureLocalSpecialists();
await progressionStore.ensureAgents(teamRegistry.list());
await dashboardStore.init();
for (const task of dashboardStore.getState().tasks.filter((entry) => entry.status === "done" && entry.agentId)) {
    const existing = progressionStore.get(task.agentId);
    if (existing && existing.rewardTaskIds.includes(String(task.id))) {
        continue;
    }
    await awardAgentTaskCompletion(task.agentId, task.id, `${task.title}\n${task.detail || ""}`);
}
await migrateLegacyGroupArtifacts();
await ensureDefaultGroupChat();
await ensurePostDeployGroupChat();
await ensureLocalWorkbenchGroupChat();
const managerAgent = teamRegistry.list().find((agent) => agent.isManager);
const managerBrain = managerAgent ? await teamRegistry.getBrain(managerAgent.id) : baseBrain;
learningLoop = new KiraLearningLoop(() => ({ ...config, ...runtimeSettings }), managerBrain);
teamHeartbeat = new TeamHeartbeat();
app.listen(config.port, config.host, () => {
    console.log(`[agent] listening on http://${config.host}:${config.port}`);
    console.log(`[agent] provider=${runtimeSettings.provider} executive=${runtimeSettings.models.executive} coder=${runtimeSettings.models.coder} fast=${runtimeSettings.models.fast}`);
});
