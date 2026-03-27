// @ts-nocheck
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { z } from "zod";
import { getConfig } from "./config.js";
import { DashboardStore } from "./dashboard-store.js";
import { KiraBrain } from "./kira/brain.js";
import { KiraLearningLoop } from "./kira/learning-loop.js";
import { runKiraChat } from "./kira/kira-runtime.js";
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
const teamRegistry = new TeamRegistry(config);
const dashboardStore = new DashboardStore(config.controlRoot);
let learningLoop;
let teamHeartbeat;
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
    return await new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
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
async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
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
        const lastMessageAt = chat.messages[chat.messages.length - 1]?.createdAt || 0;
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
function groupFolderPath(chat) {
    return path.join(config.controlRoot, "data", "groups", groupFolderName(chat));
}
function relativeFromWorkspace(absolutePath) {
    return path.relative(config.controlRoot, absolutePath) || ".";
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
                path: `__control__/${path.join(relativeFromWorkspace(groupFolderPath(chat)), relativePath).replace(/\\/g, "/")}`,
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
function fallbackTaskPlan(agent, chat) {
    return [
        {
            title: `${agent?.name || "Agent"} follow-up for ${chat.title}`,
            detail: "Review the latest group discussion, identify the most urgent next step for your role, and produce a concrete update.",
            searchTerms: [chat.title, agent?.role || "agent"]
        }
    ];
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
        id: message.id || `msg-${Date.now()}`,
        role: message.role || "assistant",
        author: message.author || "Agent",
        content: message.content || "",
        createdAt: Number(message.createdAt || Date.now())
    });
    await dashboardStore.setMessengerState(state.messenger);
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
async function generateAutonomyTasks(agent, chat, searchHits) {
    const prompt = [
        "Generate a task list for your next autonomy cycle.",
        "Return JSON only: an array of up to 10 objects with keys title, detail, searchTerms.",
        "The tasks must fit your role, the latest group chat context, and the documents found.",
        "Prefer concrete, sequential tasks that can be completed in one cycle.",
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
        const tasks = normalizeTaskPlans(parsed);
        return tasks.length ? tasks : fallbackTaskPlan(agent, chat);
    }
    catch {
        return fallbackTaskPlan(agent, chat);
    }
}
async function syncAutonomyBoardTasks(agentId, chat, tasks, cycleTag) {
    for (let index = 0; index < 10; index += 1) {
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
    const assignedTasks = dashboardState.tasks
        .filter((task) => task.agentId === agent.id && task.status !== "done")
        .map((task) => `- ${task.title} [${task.status}]${task.detail ? `: ${task.detail}` : ""}`);
    return [
        `Assigned agent: ${agent.name}`,
        `Role: ${agent.role}`,
        `Workspace folder: ${agent.workspacePath}`,
        `Attached tools: ${agent.tools.join(", ") || "none"}`,
        `Specialized skills: ${agent.skills.join(", ") || "none"}`,
        dashboardState.projectBrief ? `Shared project brief: ${dashboardState.projectBrief}` : "",
        assignedTasks.length ? `Assigned tasks:\n${assignedTasks.join("\n")}` : "",
        agent.repoBranch ? `Preferred git branch: ${agent.repoBranch}` : "",
        agent.notes ? `Agent directives: ${agent.notes}` : "",
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
    await teamRegistry.upsert({ id: agentId, presence });
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
    const titles = agentActivityTitles(agent.name, mode);
    await recordAgentActivity(agent, mode, "working", titles.start, prompt.slice(0, 320));
    const agentConfig = {
        ...teamRegistry.buildAgentConfig(agent.id),
        provider: agent.provider,
        models: {
            executive: agent.model || runtimeSettings.models.executive,
            coder: agent.model || runtimeSettings.models.coder,
            fast: agent.model || runtimeSettings.models.fast
        },
        ollamaBaseUrl: runtimeSettings.ollamaBaseUrl,
        openClawBaseUrl: runtimeSettings.openClawBaseUrl
    };
    const agentBrain = await teamRegistry.getBrain(agent.id);
    const result = await runKiraChat(agentConfig, agentBrain, [agentPromptContext(agent, mode), prompt].filter(Boolean).join("\n\n"));
    let updatedAgent = await teamRegistry.recordDispatch(agent.id, prompt, result.content || "");
    if (result.model && updatedAgent.model !== result.model) {
        updatedAgent = await teamRegistry.upsert({
            id: updatedAgent.id,
            model: result.model
        });
        updatedAgent = await teamRegistry.recordDispatch(agent.id, prompt, result.content || "");
    }
    await recordAgentActivity(updatedAgent, mode, "done", agentActivityTitles(updatedAgent.name, mode).done, (result.content || "").slice(0, 320));
    return {
        result,
        agent: updatedAgent
    };
}
async function ensureDefaultGroupChat() {
    const state = dashboardStore.getState();
    if (state.messenger.chats.some((chat) => chat.type === "group")) {
        return;
    }
    const agents = teamRegistry.list();
    if (agents.length < 2) {
        return;
    }
    state.messenger.chats.unshift({
        id: "group-core-team",
        type: "group",
        title: "Core Team",
        members: agents.map((agent) => agent.id),
        messages: [
            {
                id: "msg-core-team-seed",
                role: "system",
                author: "KiraDex",
                content: "Core Team is ready. Use this room to brief the default team and let the autonomy loop work from shared context.",
                createdAt: Date.now()
            }
        ],
        lastReadAt: 0,
        origin: "system"
    });
    state.messenger.activeChatId = state.messenger.activeChatId || "group-core-team";
    await dashboardStore.setMessengerState(state.messenger);
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
    if ((postReply.result.content || "").trim()) {
        await appendChatMessageById(chat.id, {
            role: "assistant",
            author: agent.name,
            content: postReply.result.content.trim()
        });
    }
    await setAgentPresence(agent.id, "active");
    return `${agent.name} read ${chat.title}, worked ${tasks.length} task${tasks.length === 1 ? "" : "s"}, and posted a final update in ${relativeFromWorkspace(summaryPath)}.`;
}
class TeamHeartbeat {
    status = {
        active: false,
        intervalMs: 60000,
        cooldownMs: 0,
        maxAgentsPerCycle: 10,
        cyclesCompleted: 0,
        lastRunAt: null,
        lastError: "",
        lastDetail: "Autonomy loop is off."
    };
    timer = null;
    running = false;
    getStatus() {
        return { ...this.status };
    }
    async start(intervalMs = 60000, maxAgentsPerCycle = 10) {
        this.status.active = true;
        this.status.intervalMs = Math.max(15000, Math.min(intervalMs, 3600000));
        this.status.maxAgentsPerCycle = Math.max(1, Math.min(maxAgentsPerCycle, 10));
        this.status.lastError = "";
        this.status.lastDetail = "Autonomy loop active.";
        await dashboardStore.addActivity({
            source: "autonomy",
            agentId: "",
            agentName: "Autonomy Loop",
            status: "working",
            title: "Autonomy loop started",
            detail: `Runs every ${this.status.intervalMs}ms across active group chats.`
        });
        await this.runCycle();
        return this.getStatus();
    }
    stop() {
        this.status.active = false;
        this.status.lastDetail = "Autonomy loop stopped.";
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        void dashboardStore.addActivity({
            source: "autonomy",
            agentId: "",
            agentName: "Autonomy Loop",
            status: "info",
            title: "Autonomy loop stopped",
            detail: this.status.cyclesCompleted ? `Completed ${this.status.cyclesCompleted} cycles.` : "No cycles completed."
        });
        return this.getStatus();
    }
    scheduleNextRun() {
        if (!this.status.active) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            void this.runCycle();
        }, this.status.intervalMs);
    }
    async runCycle() {
        if (!this.status.active || this.running) {
            return;
        }
        this.running = true;
        this.status.lastRunAt = Date.now();
        try {
            await ensureDefaultGroupChat();
            const board = dashboardStore.getState();
            const allAgents = teamRegistry.list().filter((agent) => agent.state !== "paused");
            const groupChats = board.messenger.chats.filter((chat) => chat.type === "group" && chat.members.length >= 2);
            const cycleNotes = [];
            if (!groupChats.length) {
                cycleNotes.push("No group chats are available for autonomy yet.");
            }
            for (const agent of allAgents) {
                const memberships = groupChats.filter((chat) => chat.members.includes(agent.id));
                if (!memberships.length) {
                    cycleNotes.push(`${agent.name} has no group chats to work from.`);
                    continue;
                }
                await teamRegistry.upsert({ id: agent.id, state: "active", presence: "active" });
                try {
                    for (let index = 0; index < memberships.length; index += 1) {
                        cycleNotes.push(await runAgentGroupCycle(agent, memberships[index], index));
                    }
                }
                catch (error) {
                    const message = describeError(error);
                    await dashboardStore.addFailure("team-heartbeat", `Autonomy cycle failed for ${agent.name}`, message);
                    await teamRegistry.upsert({ id: agent.id, state: "idle", presence: "idle" });
                    cycleNotes.push(`${agent.name} failed: ${message}`);
                    continue;
                }
                await teamRegistry.upsert({ id: agent.id, state: "idle", presence: "idle" });
            }
            const custodian = allAgents.find((agent) => /chat custodian/i.test(agent.name) || /chat custodian/i.test(agent.notes));
            const removableChats = board.messenger.chats.filter((chat) => chat.origin !== "user").length;
            if (custodian && removableChats >= 8) {
                const cleanupDetail = await cleanupDeletableChats();
                await recordAgentActivity(custodian, "autonomy", "done", "Chat cleanup heartbeat", cleanupDetail);
                cycleNotes.push(cleanupDetail);
            }
            if (!cycleNotes.length) {
                cycleNotes.push("Autonomy loop found no eligible agent work this cycle.");
            }
            this.status.cyclesCompleted += 1;
            this.status.lastError = "";
            this.status.lastDetail = cycleNotes.join(" | ");
            await dashboardStore.addActivity({
                source: "autonomy",
                agentId: "",
                agentName: "Autonomy Loop",
                status: "info",
                title: "Autonomy cycle",
                detail: this.status.lastDetail
            });
        }
        catch (error) {
            this.status.lastError = describeError(error);
            this.status.lastDetail = this.status.lastError;
            await dashboardStore.addFailure("team-heartbeat", "Autonomy cycle failed", this.status.lastError);
        }
        finally {
            this.running = false;
            this.scheduleNextRun();
        }
    }
}
app.use(express.json({ limit: "4mb" }));
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
app.post("/api/dashboard/brief", async (req, res) => {
    const schema = z.object({
        projectBrief: z.string()
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "invalid request" });
    }
    try {
        return res.json(await dashboardStore.setProjectBrief(parsed.data.projectBrief));
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
        return res.json(await dashboardStore.upsertTask(parsed.data));
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
        learningLoop.stop();
        teamHeartbeat.stop();
        await dashboardStore.resetAll();
        await teamRegistry.wipeSandbox();
        return res.json({
            ok: true,
            detail: "Sandbox wiped. Chats, dashboard state, and agent memory databases were cleared."
        });
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
app.get("/api/team/agents", (_req, res) => {
    res.json({ agents: teamRegistry.list() });
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
app.post("/api/team-heartbeat/start", async (req, res) => {
    const schema = z.object({
        intervalMs: z.number().int().min(15000).max(3600000).optional(),
        maxAgentsPerCycle: z.number().int().min(1).max(8).optional()
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
        const result = await runKiraChat({ ...config, ...runtimeSettings }, baseBrain, parsed.data.prompt);
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
            agentName: "KIRA",
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
        agentName: "KIRA",
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
        const items = await buildWorkspaceIndex(config.projectRoot, shouldIncludeWorkspaceNote);
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
    const deleted = [];
    for (const relativePath of parsed.data.paths) {
        const normalized = String(relativePath || "").replace(/\\/g, "/");
        if (!normalized) {
            continue;
        }
        const absolutePath = path.resolve(config.projectRoot, normalized);
        const relativeToRoot = path.relative(config.projectRoot, absolutePath);
        if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
            return res.status(400).json({ error: "path outside workspace" });
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
    const absolutePath = path.resolve(config.projectRoot, parsed.data.path);
    const relativeToRoot = path.relative(config.projectRoot, absolutePath);
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
await baseBrain.init();
await teamRegistry.init();
await dashboardStore.init();
await ensureDefaultGroupChat();
const managerAgent = teamRegistry.list().find((agent) => agent.isManager);
const managerBrain = managerAgent ? await teamRegistry.getBrain(managerAgent.id) : baseBrain;
learningLoop = new KiraLearningLoop(() => ({ ...config, ...runtimeSettings }), managerBrain);
teamHeartbeat = new TeamHeartbeat();
app.listen(config.port, config.host, () => {
    console.log(`[agent] listening on http://${config.host}:${config.port}`);
    console.log(`[agent] provider=${runtimeSettings.provider} executive=${runtimeSettings.models.executive} coder=${runtimeSettings.models.coder} fast=${runtimeSettings.models.fast}`);
});
