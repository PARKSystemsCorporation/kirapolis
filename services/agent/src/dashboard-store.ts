// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";
const MAX_FAILURES = 50;
const MAX_ACTIVITY = 250;
function defaultProjectBrief() {
    return "Website structure rule: every page should live in a folder whose name matches the intended URL slug, and the visible page file inside that folder should be named index.html unless there is a deliberate framework-specific reason not to.";
}
function normalizeActivityStatus(input) {
    return input === "working" || input === "done" || input === "issue" ? input : "info";
}
export class DashboardStore {
    workspaceRoot;
    statePath;
    state = {
        projectBrief: defaultProjectBrief(),
        tasks: [],
        assets: [],
        failures: [],
        activity: [],
        messenger: {
            chats: [],
            activeChatId: null,
            groupBuilderOpen: false,
            dismissedChatIds: []
        }
    };
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.statePath = path.join(workspaceRoot, "data", "dashboard-state.json");
    }
    async init() {
        try {
            const raw = await fs.readFile(this.statePath, "utf8");
            const parsed = JSON.parse(raw);
            this.state = {
                projectBrief: String(parsed.projectBrief || defaultProjectBrief()),
                tasks: Array.isArray(parsed.tasks) ? parsed.tasks.map((task) => ({
                    id: String(task.id || `task-${Date.now()}`),
                    title: String(task.title || "Untitled Task"),
                    detail: String(task.detail || ""),
                    status: task.status === "doing" || task.status === "done" || task.status === "blocked" ? task.status : "todo",
                    agentId: String(task.agentId || ""),
                    createdAt: Number(task.createdAt || Date.now()),
                    updatedAt: Number(task.updatedAt || Date.now())
                })) : [],
                assets: Array.isArray(parsed.assets) ? parsed.assets.map((asset) => ({
                    id: String(asset.id || `asset-${Date.now()}`),
                    title: String(asset.title || "Untitled Asset"),
                    kind: String(asset.kind || "reference"),
                    url: String(asset.url || ""),
                    notes: String(asset.notes || ""),
                    createdAt: Number(asset.createdAt || Date.now())
                })) : [],
                failures: Array.isArray(parsed.failures) ? parsed.failures.map((failure) => ({
                    id: String(failure.id || `failure-${Date.now()}`),
                    source: String(failure.source || "system"),
                    message: String(failure.message || "Unknown failure"),
                    detail: String(failure.detail || ""),
                    createdAt: Number(failure.createdAt || Date.now())
                })).slice(0, MAX_FAILURES) : [],
                activity: Array.isArray(parsed.activity) ? parsed.activity.map((entry) => ({
                    id: String(entry.id || `activity-${Date.now()}`),
                    source: String(entry.source || "system"),
                    agentId: String(entry.agentId || ""),
                    agentName: String(entry.agentName || ""),
                    status: normalizeActivityStatus(entry.status),
                    title: String(entry.title || "Activity"),
                    detail: String(entry.detail || ""),
                    createdAt: Number(entry.createdAt || Date.now())
                })).slice(0, MAX_ACTIVITY) : [],
                messenger: {
                    chats: Array.isArray(parsed.messenger?.chats) ? parsed.messenger.chats.map((chat) => ({
                        id: String(chat.id || `chat-${Date.now()}`),
                        type: chat.type === "group" ? "group" : "direct",
                        title: String(chat.title || "Chat"),
                        members: Array.isArray(chat.members) ? chat.members.map((memberId) => String(memberId)) : [],
                        messages: Array.isArray(chat.messages) ? chat.messages.map((message) => ({
                            id: String(message.id || `msg-${Date.now()}`),
                            role: String(message.role || "assistant"),
                            author: String(message.author || "Agent"),
                            content: String(message.content || ""),
                            createdAt: Number(message.createdAt || Date.now())
                        })) : [],
                        lastReadAt: Number(chat.lastReadAt || 0),
                        origin: chat.origin === "user" || chat.origin === "agent" ? chat.origin : "system"
                    })) : [],
                    activeChatId: parsed.messenger?.activeChatId ? String(parsed.messenger.activeChatId) : null,
                    groupBuilderOpen: Boolean(parsed.messenger?.groupBuilderOpen),
                    dismissedChatIds: Array.isArray(parsed.messenger?.dismissedChatIds) ? parsed.messenger.dismissedChatIds.map((value) => String(value)) : []
                }
            };
        }
        catch {
            await this.save();
        }
    }
    getState() {
        return {
            projectBrief: this.state.projectBrief,
            tasks: this.state.tasks.map((task) => ({ ...task })),
            assets: this.state.assets.map((asset) => ({ ...asset })),
            failures: this.state.failures.map((failure) => ({ ...failure })),
            activity: this.state.activity.map((entry) => ({ ...entry })),
            messenger: {
                chats: this.state.messenger.chats.map((chat) => ({
                    ...chat,
                    members: [...chat.members],
                    messages: chat.messages.map((message) => ({ ...message })),
                    lastReadAt: Number(chat.lastReadAt || 0),
                    origin: chat.origin === "user" || chat.origin === "agent" ? chat.origin : "system"
                })),
                activeChatId: this.state.messenger.activeChatId,
                groupBuilderOpen: this.state.messenger.groupBuilderOpen,
                dismissedChatIds: [...this.state.messenger.dismissedChatIds]
            }
        };
    }
    async setProjectBrief(projectBrief) {
        this.state.projectBrief = projectBrief.trim();
        await this.save();
        return this.getState();
    }
    async upsertTask(input) {
        const now = Date.now();
        const task = {
            id: String(input.id || `task-${now}`),
            title: input.title.trim() || "Untitled Task",
            detail: String(input.detail || ""),
            status: input.status === "doing" || input.status === "done" || input.status === "blocked" ? input.status : "todo",
            agentId: String(input.agentId || ""),
            createdAt: Number(input.createdAt || now),
            updatedAt: now
        };
        const index = this.state.tasks.findIndex((entry) => entry.id === task.id);
        if (index >= 0) {
            this.state.tasks[index] = task;
        }
        else {
            this.state.tasks.unshift(task);
        }
        await this.save();
        return this.getState();
    }
    async removeTask(id) {
        this.state.tasks = this.state.tasks.filter((task) => task.id !== id);
        await this.save();
        return this.getState();
    }
    async addAsset(input) {
        this.state.assets.unshift({
            id: `asset-${Date.now()}`,
            title: input.title.trim() || "Untitled Asset",
            kind: input.kind.trim() || "reference",
            url: input.url.trim(),
            notes: input.notes.trim(),
            createdAt: Date.now()
        });
        await this.save();
        return this.getState();
    }
    async removeAsset(id) {
        this.state.assets = this.state.assets.filter((asset) => asset.id !== id);
        await this.save();
        return this.getState();
    }
    async addFailure(source, message, detail = "") {
        this.state.failures.unshift({
            id: `failure-${Date.now()}`,
            source: source.trim() || "system",
            message: message.trim() || "Unknown failure",
            detail: detail.trim(),
            createdAt: Date.now()
        });
        this.state.failures = this.state.failures.slice(0, MAX_FAILURES);
        await this.save();
    }
    async clearFailures() {
        this.state.failures = [];
        await this.save();
        return this.getState();
    }
    async addActivity(input) {
        this.state.activity.unshift({
            id: `activity-${Date.now()}`,
            source: String(input.source || "system").trim() || "system",
            agentId: String(input.agentId || ""),
            agentName: String(input.agentName || "").trim(),
            status: normalizeActivityStatus(input.status),
            title: String(input.title || "Activity").trim() || "Activity",
            detail: String(input.detail || "").trim(),
            createdAt: Date.now()
        });
        this.state.activity = this.state.activity.slice(0, MAX_ACTIVITY);
        await this.save();
    }
    async clearActivity() {
        this.state.activity = [];
        await this.save();
        return this.getState();
    }
    async setMessengerState(input) {
        this.state.messenger = {
            chats: Array.isArray(input.chats) ? input.chats.map((chat) => ({
                id: String(chat.id || `chat-${Date.now()}`),
                type: chat.type === "group" ? "group" : "direct",
                title: String(chat.title || "Chat"),
                members: Array.isArray(chat.members) ? chat.members.map((memberId) => String(memberId)) : [],
                messages: Array.isArray(chat.messages) ? chat.messages.map((message) => ({
                    id: String(message.id || `msg-${Date.now()}`),
                    role: String(message.role || "assistant"),
                    author: String(message.author || "Agent"),
                    content: String(message.content || ""),
                    createdAt: Number(message.createdAt || Date.now())
                })) : [],
                lastReadAt: Number(chat.lastReadAt || 0),
                origin: chat.origin === "user" || chat.origin === "agent" ? chat.origin : "system"
            })) : [],
            activeChatId: input.activeChatId ? String(input.activeChatId) : null,
            groupBuilderOpen: Boolean(input.groupBuilderOpen),
            dismissedChatIds: Array.isArray(input.dismissedChatIds) ? input.dismissedChatIds.map((value) => String(value)) : []
        };
        await this.save();
        return this.getState();
    }
    async resetAll() {
        this.state = {
            projectBrief: defaultProjectBrief(),
            tasks: [],
            assets: [],
            failures: [],
            activity: [],
            messenger: {
                chats: [],
                activeChatId: null,
                groupBuilderOpen: false,
                dismissedChatIds: []
            }
        };
        await this.save();
        return this.getState();
    }
    async save() {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
}
