// @ts-nocheck
import fs from "node:fs/promises";
import path from "node:path";

function clampStarCount(value) {
    return Math.min(3, Math.max(1, Number(value || 1)));
}

function xpRequiredForLevel(level) {
    const normalized = Math.max(1, Number(level || 1));
    return Math.round(90 + (24 * Math.pow(normalized, 1.32)) + (18 * Math.log(normalized + 1)));
}

function summarizeRank(level, stars) {
    if (stars >= 3 && level >= 28)
        return "Systems Director";
    if (stars >= 3)
        return "Senior Manager";
    if (stars >= 2 && level >= 14)
        return "Lead Specialist";
    if (stars >= 2)
        return "Senior Specialist";
    if (level >= 10)
        return "Core Operator";
    return "Junior Operator";
}

function computeLevelState(totalXp) {
    const xp = Math.max(0, Number(totalXp || 0));
    let level = 1;
    let remaining = xp;
    let requirement = xpRequiredForLevel(level);
    while (remaining >= requirement) {
        remaining -= requirement;
        level += 1;
        requirement = xpRequiredForLevel(level);
    }
    return {
        level,
        xpIntoLevel: remaining,
        xpForNextLevel: requirement,
        xpRemaining: Math.max(0, requirement - remaining)
    };
}

function eligibleStars(record) {
    const completed = Number(record?.completedTasks || 0);
    const level = Number(record?.level || 1);
    if (level >= 20 || completed >= 40)
        return 3;
    if (level >= 8 || completed >= 12)
        return 2;
    return 1;
}

function buildSpriteSeed(agentId, name) {
    return `${String(agentId || "agent")}:${String(name || "operator")}`;
}

function normalizeRecord(agent, current) {
    const base = current || {};
    const totalXp = Math.max(0, Number(base.totalXp || 0));
    const levelState = computeLevelState(totalXp);
    const stars = Math.min(clampStarCount(base.stars || 1), eligibleStars({
        ...base,
        ...levelState
    }));
    return {
        agentId: String(agent?.id || base.agentId || ""),
        name: String(agent?.name || base.name || "Operator"),
        role: String(agent?.role || base.role || "runner"),
        totalXp,
        completedTasks: Math.max(0, Number(base.completedTasks || 0)),
        stars,
        highestStars: Math.max(stars, Math.min(3, Number(base.highestStars || stars))),
        level: levelState.level,
        xpIntoLevel: levelState.xpIntoLevel,
        xpForNextLevel: levelState.xpForNextLevel,
        xpRemaining: levelState.xpRemaining,
        rankLabel: summarizeRank(levelState.level, stars),
        spriteSeed: String(base.spriteSeed || buildSpriteSeed(agent?.id, agent?.name)),
        lastTaskId: String(base.lastTaskId || ""),
        lastRewardAt: Number(base.lastRewardAt || 0),
        promotionEligibleStars: eligibleStars({
            ...base,
            level: levelState.level,
            completedTasks: Math.max(0, Number(base.completedTasks || 0))
        }),
        rewardTaskIds: Array.isArray(base.rewardTaskIds) ? base.rewardTaskIds.map((value) => String(value)).slice(-240) : []
    };
}

export class ProgressionStore {
    rootPath;
    statePath;
    state = {
        agents: {}
    };
    constructor(rootPath) {
        this.rootPath = rootPath;
        this.statePath = path.join(rootPath, "data", "agent-progression.json");
    }
    async init() {
        try {
            const raw = await fs.readFile(this.statePath, "utf8");
            const parsed = JSON.parse(raw);
            this.state = {
                agents: parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object" ? parsed.agents : {}
            };
        }
        catch {
            await this.save();
        }
    }
    async ensureAgents(agents) {
        let changed = false;
        for (const agent of agents || []) {
            const current = this.state.agents[String(agent.id || "")];
            const next = normalizeRecord(agent, current);
            const before = JSON.stringify(current || null);
            const after = JSON.stringify(next);
            if (before !== after) {
                this.state.agents[next.agentId] = next;
                changed = true;
            }
        }
        if (changed) {
            await this.save();
        }
    }
    get(agentId) {
        const record = this.state.agents[String(agentId || "")];
        return record ? JSON.parse(JSON.stringify(record)) : null;
    }
    listForAgents(agents) {
        const entries = {};
        for (const agent of agents || []) {
            entries[agent.id] = normalizeRecord(agent, this.state.agents[String(agent.id || "")]);
        }
        return entries;
    }
    async awardTaskCompletion(agent, taskId, detail = "") {
        if (!agent?.id || !taskId) {
            return { awarded: false, progression: null, xpAwarded: 0, promoted: false };
        }
        const current = normalizeRecord(agent, this.state.agents[String(agent.id)] || {});
        if (current.rewardTaskIds.includes(String(taskId))) {
            this.state.agents[current.agentId] = current;
            return { awarded: false, progression: current, xpAwarded: 0, promoted: false };
        }
        const detailLength = String(detail || "").trim().length;
        const baseXp = agent.isManager ? 130 : 100;
        const roleBonus = agent.role === "executive" ? 28 : agent.role === "coder" ? 22 : 16;
        const detailBonus = Math.min(80, Math.round(detailLength / 28));
        const streakBonus = Math.min(36, Math.floor(current.completedTasks / 5) * 4);
        const xpAwarded = baseXp + roleBonus + detailBonus + streakBonus;
        const totalXp = current.totalXp + xpAwarded;
        const updated = normalizeRecord(agent, {
            ...current,
            totalXp,
            completedTasks: current.completedTasks + 1,
            lastTaskId: String(taskId),
            lastRewardAt: Date.now(),
            rewardTaskIds: [...current.rewardTaskIds, String(taskId)].slice(-240)
        });
        const previousStars = current.stars;
        if (updated.promotionEligibleStars > updated.stars) {
            updated.stars = updated.promotionEligibleStars;
            updated.highestStars = Math.max(updated.highestStars, updated.stars);
            updated.rankLabel = summarizeRank(updated.level, updated.stars);
        }
        this.state.agents[updated.agentId] = updated;
        await this.save();
        return {
            awarded: true,
            progression: JSON.parse(JSON.stringify(updated)),
            xpAwarded,
            promoted: updated.stars > previousStars
        };
    }
    async setStars(agent, requestedStars) {
        if (!agent?.id) {
            throw new Error("agent not found");
        }
        const current = normalizeRecord(agent, this.state.agents[String(agent.id)] || {});
        const eligible = eligibleStars(current);
        const nextStars = Math.min(clampStarCount(requestedStars), eligible);
        const updated = normalizeRecord(agent, {
            ...current,
            stars: nextStars,
            highestStars: Math.max(current.highestStars || current.stars, nextStars)
        });
        this.state.agents[updated.agentId] = updated;
        await this.save();
        return JSON.parse(JSON.stringify(updated));
    }
    async remove(agentId) {
        if (!agentId || !this.state.agents[String(agentId)]) {
            return false;
        }
        delete this.state.agents[String(agentId)];
        await this.save();
        return true;
    }
    async save() {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
    }
}

export function getLevelFormulaText() {
    return "Each new level uses 90 + 24 * level^1.32 + 18 * ln(level + 1) XP, which keeps growth infinite, steady, and still human-scaled.";
}
