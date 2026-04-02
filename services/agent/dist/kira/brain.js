import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { v4 as uuidv4 } from "uuid";
import winkPOS from "wink-pos-tagger";
import { cosineSimilarity, embedText, parseEmbedding, serializeEmbedding } from "./embeddings.js";
const STOPS = new Set([
    "a", "an", "the", "i", "me", "my", "we", "you", "he", "she", "it", "they", "is", "are", "was", "were", "be", "been",
    "have", "has", "had", "do", "does", "did", "will", "would", "can", "could", "and", "but", "or", "if", "of", "to", "in",
    "for", "on", "with", "at", "by", "from", "so", "as", "that", "this", "what", "which", "who", "how", "when", "where", "why",
    "all", "each", "some", "any", "no", "not", "just", "also", "very", "too", "really", "thing", "things", "way", "even",
    "like", "get", "got", "ok", "yeah", "yes", "hey", "hi", "hello"
]);
const POS = {
    NN: "noun", NNS: "noun", NNP: "noun", NNPS: "noun",
    VB: "verb", VBD: "verb", VBG: "verb", VBN: "verb", VBP: "verb", VBZ: "verb",
    JJ: "adj", JJR: "adj", JJS: "adj",
    RB: "adv", RBR: "adv", RBS: "adv"
};
const MEMORY_KIND_PRIORITY = ["decision", "task", "preference", "fact", "summary"];
function clip(text, max = 220) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value)
        return "";
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3)).trim()}...`;
}
function normalizeKey(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function stablePk(kind, subject) {
    return `${kind}:${normalizeKey(subject)}`;
}
function compactSentenceParts(text) {
    return String(text || "")
        .split(/(?<=[.!?])\s+|\n+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 4);
}
function score(posA, posB, dist) {
    const cat = (posA === "noun" && posB === "noun") ? 0.3 : (posA === "adj" || posB === "adj") ? 0.2 : 0.1;
    const prox = dist === 0 ? 0.4 : dist === 1 ? 0.3 : dist <= 3 ? 0.2 : 0.1;
    return Math.min(0.15 + cat + prox, 1.0);
}
function tierFor(scoreValue) {
    return scoreValue >= 0.65 ? "long_term" : scoreValue >= 0.25 ? "medium" : "short";
}
export class KiraBrain {
    config;
    sql;
    db;
    saveTimer;
    tagger = winkPOS();
    dbPath;
    constructor(config) {
        this.config = config;
        this.dbPath = config.memoryPath || path.join(config.workspaceRoot, "data", "kira.db");
    }
    async init() {
        this.sql = await initSqlJs({});
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        if (fs.existsSync(this.dbPath)) {
            this.db = new this.sql.Database(fs.readFileSync(this.dbPath));
        }
        else {
            this.db = new this.sql.Database();
        }
        this.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT, content TEXT, created_at INTEGER, metadata TEXT)`);
        this.run(`CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, val INTEGER)`);
        this.run(`INSERT OR IGNORE INTO counter (id, val) VALUES (1, 0)`);
        this.run(`CREATE TABLE IF NOT EXISTS short (id TEXT PRIMARY KEY, pk TEXT UNIQUE, w1 TEXT, w2 TEXT, pos1 TEXT, pos2 TEXT, rel TEXT, snippet TEXT, score REAL, reinf INTEGER, decay_at INTEGER, last_seen INTEGER, created INTEGER, updated INTEGER)`);
        this.run(`CREATE TABLE IF NOT EXISTS medium (id TEXT PRIMARY KEY, pk TEXT UNIQUE, w1 TEXT, w2 TEXT, pos1 TEXT, pos2 TEXT, rel TEXT, snippet TEXT, score REAL, reinf INTEGER, decay_at INTEGER, last_seen INTEGER, created INTEGER, updated INTEGER)`);
        this.run(`CREATE TABLE IF NOT EXISTS long_term (id TEXT PRIMARY KEY, pk TEXT UNIQUE, w1 TEXT, w2 TEXT, pos1 TEXT, pos2 TEXT, rel TEXT, snippet TEXT, score REAL, reinf INTEGER, decay_at INTEGER, last_seen INTEGER, created INTEGER, updated INTEGER)`);
        this.run(`CREATE TABLE IF NOT EXISTS memory_items (id TEXT PRIMARY KEY, pk TEXT UNIQUE, kind TEXT, subject TEXT, summary TEXT, detail TEXT, tags TEXT, embedding TEXT, source_role TEXT, confidence REAL, salience REAL, accesses INTEGER, created_at INTEGER, updated_at INTEGER, last_used_at INTEGER)`);
        try {
            this.run(`ALTER TABLE memory_items ADD COLUMN embedding TEXT`);
        }
        catch {
        }
        this.run(`CREATE INDEX IF NOT EXISTS idx_short_pk ON short(pk)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_medium_pk ON medium(pk)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_long_pk ON long_term(pk)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_short_words ON short(w1, w2)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_medium_words ON medium(w1, w2)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_long_words ON long_term(w1, w2)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_memory_items_kind ON memory_items(kind)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_memory_items_updated ON memory_items(updated_at)`);
        this.save();
    }
    async handleUserMessage(text, metadata = {}) {
        this.insertMessage("user", text, metadata);
        this.decay();
        this.processMessage(text);
        await this.extractStructuredMemories("user", text, metadata);
        const systemPrompt = await this.buildSystemPrompt(text);
        return systemPrompt;
    }
    async recordAssistantMessage(text, metadata = {}) {
        this.insertMessage("kira", text, metadata);
        await this.extractStructuredMemories("kira", text, metadata);
    }
    getStats() {
        return {
            short: Number(this.get(`SELECT COUNT(*) AS c FROM short`)?.c || 0),
            medium: Number(this.get(`SELECT COUNT(*) AS c FROM medium`)?.c || 0),
            long: Number(this.get(`SELECT COUNT(*) AS c FROM long_term`)?.c || 0),
            messages: Number(this.get(`SELECT val AS c FROM counter WHERE id = 1`)?.c || 0)
        };
    }
    async buildSystemPrompt(userMessage) {
        const mem = this.memoryContext(userMessage);
        const structured = await this.structuredMemoryContext(userMessage);
        const history = this.query(`SELECT role, content FROM messages ORDER BY created_at DESC LIMIT 8`).reverse().map((row) => `${row.role}: ${row.content}`).join("\n");
        return [
            "You are Kirapolis, an autonomous AI with persistent SQLite memory and correlation-based learning.",
            "Operate like a pragmatic software engineer with ongoing memory reinforcement and decay.",
            "Never explain the internal memory mechanism unless explicitly asked.",
            structured ? structured : "",
            mem ? mem : "",
            history ? `Recent conversation:\n${history}` : ""
        ].filter(Boolean).join("\n\n");
    }
    async structuredMemoryContext(text) {
        const rows = (await this.rankStructuredMemories(text)).slice(0, 8);
        if (!rows.length)
            return "";
        const groups = new Map();
        for (const row of rows) {
            const kind = String(row.kind || "summary");
            if (!groups.has(kind))
                groups.set(kind, []);
            groups.get(kind).push(this.formatStructuredMemory(row));
        }
        const sections = MEMORY_KIND_PRIORITY
            .filter((kind) => groups.has(kind))
            .map((kind) => `${kind[0].toUpperCase()}${kind.slice(1)} memory:\n- ${groups.get(kind).join("\n- ")}`);
        if (!sections.length)
            return "";
        return sections.join("\n\n");
    }
    memoryContext(text) {
        const words = text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPS.has(w));
        if (!words.length)
            return "";
        const seen = new Map();
        for (const word of words.slice(0, 6)) {
            for (const tier of ["long_term", "medium", "short"]) {
                for (const row of this.query(`SELECT * FROM ${tier} WHERE w1 = ? OR w2 = ? ORDER BY score DESC LIMIT 6`, [word, word])) {
                    seen.set(String(row.id), { ...row, tier });
                }
            }
        }
        const correlations = [...seen.values()].slice(0, 10);
        if (!correlations.length)
            return "";
        const lines = correlations.map((row) => `${row.w1} and ${row.w2} are connected (${row.tier}, reinforcement ${row.reinf}, score ${Number(row.score).toFixed(2)})`);
        return `Relevant memory:\n- ${lines.join("\n- ")}`;
    }
    async rankStructuredMemories(text) {
        const tokens = new Set(this.tokenize(text).map((token) => token.word));
        const queryEmbedding = await embedText(this.config, text);
        const rows = this.query(`SELECT * FROM memory_items ORDER BY updated_at DESC LIMIT 120`);
        const ranked = rows.map((row) => {
            const haystack = normalizeKey([row.subject, row.summary, row.detail, row.tags].filter(Boolean).join(" "));
            const overlap = Number([...tokens].reduce((count, token) => Number(count) + (haystack.includes(String(token)) ? 1 : 0), 0));
            const semantic = Math.max(0, cosineSimilarity(queryEmbedding, parseEmbedding(row.embedding)));
            const confidence = Number(row.confidence || 0.5);
            const salience = Number(row.salience || 0.5);
            const accesses = Math.min(0.25, Number(row.accesses || 0) * 0.02);
            const ageMs = Math.max(0, Date.now() - Number(row.updated_at || row.created_at || Date.now()));
            const recency = Math.max(0, 1 - (ageMs / (1000 * 60 * 60 * 24 * 45)));
            const scoreValue = overlap * 0.35 + semantic * 0.35 + confidence * 0.12 + salience * 0.12 + recency * 0.1 + accesses;
            return { ...row, _score: scoreValue, _overlap: overlap, _semantic: semantic };
        })
            .filter((row) => row._overlap > 0 || Number(row._semantic || 0) >= 0.2 || Number(row.salience || 0) >= 0.8)
            .sort((left, right) => Number(right._score || 0) - Number(left._score || 0));
        for (const row of ranked.slice(0, 8)) {
            this.run(`UPDATE memory_items SET accesses = COALESCE(accesses, 0) + 1, last_used_at = ? WHERE id = ?`, [Date.now(), row.id]);
        }
        return ranked;
    }
    formatStructuredMemory(row) {
        const summary = clip(row.summary || row.subject || "");
        const detail = clip(row.detail || "", 160);
        const confidence = Number(row.confidence || 0.5).toFixed(2);
        const semantic = Number(row._semantic || 0).toFixed(2);
        if (!detail || detail === summary) {
            return `${summary} [confidence ${confidence}, semantic ${semantic}]`;
        }
        return `${summary} (${detail}) [confidence ${confidence}, semantic ${semantic}]`;
    }
    processMessage(text) {
        const idx = this.nextIdx();
        const tokens = this.tokenize(text);
        if (tokens.length < 2)
            return;
        const now = Date.now();
        for (let i = 0; i < tokens.length; i++) {
            for (let j = i + 1; j < Math.min(i + 5, tokens.length); j++) {
                const a = tokens[i];
                const b = tokens[j];
                const pk = [a.word, b.word].sort().join("_");
                const sc = score(a.spos, b.spos, j - i - 1);
                const found = this.findExisting(pk);
                if (found) {
                    const newScore = Math.min(1, Number(found.row.score) + sc);
                    const newTier = tierFor(newScore);
                    this.run(`DELETE FROM ${found.tier} WHERE pk = ?`, [pk]);
                    this.run(`INSERT OR REPLACE INTO ${newTier} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                        found.row.id, pk, a.word, b.word, a.pos, b.pos, `${a.spos}+${b.spos}`,
                        text.slice(0, 200), newScore, Number(found.row.reinf) + 1, idx + (newTier === "long_term" ? 300 : newTier === "medium" ? 200 : 100),
                        idx, found.row.created, now
                    ]);
                }
                else {
                    const newTier = tierFor(sc);
                    this.run(`INSERT OR REPLACE INTO ${newTier} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                        uuidv4(), pk, a.word, b.word, a.pos, b.pos, `${a.spos}+${b.spos}`,
                        text.slice(0, 200), sc, 1, idx + (newTier === "long_term" ? 300 : newTier === "medium" ? 200 : 100),
                        idx, now, now
                    ]);
                }
            }
        }
    }
    decay() {
        const idx = Number(this.get(`SELECT val AS v FROM counter WHERE id = 1`)?.v || 0);
        const configs = [
            { tier: "short", rate: 0.1 },
            { tier: "medium", rate: 0.05 },
            { tier: "long_term", rate: 0.01 }
        ];
        for (const item of configs) {
            const rows = this.query(`SELECT * FROM ${item.tier} WHERE decay_at <= ?`, [idx]);
            for (const row of rows) {
                const newScore = Number(row.score) * (1 - item.rate);
                if (newScore < 0.05) {
                    this.run(`DELETE FROM ${item.tier} WHERE id = ?`, [row.id]);
                    continue;
                }
                const nextTier = tierFor(newScore);
                this.run(`DELETE FROM ${item.tier} WHERE id = ?`, [row.id]);
                this.run(`INSERT OR REPLACE INTO ${nextTier} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                    row.id, row.pk, row.w1, row.w2, row.pos1, row.pos2, row.rel, row.snippet,
                    newScore, row.reinf, idx + (nextTier === "long_term" ? 300 : nextTier === "medium" ? 200 : 100),
                    row.last_seen, row.created, Date.now()
                ]);
            }
        }
    }
    tokenize(text) {
        const clean = text.toLowerCase().replace(/[^\w\s'-]/g, " ").trim();
        if (!clean)
            return [];
        return this.tagger.tagSentence(clean)
            .filter((t) => !STOPS.has(t.value) && t.value.length >= 3)
            .map((t) => ({ word: t.value, pos: t.tag, spos: POS[t.tag] || "noun" }));
    }
    findExisting(pk) {
        for (const tier of ["long_term", "medium", "short"]) {
            const row = this.get(`SELECT * FROM ${tier} WHERE pk = ?`, [pk]);
            if (row)
                return { tier, row };
        }
        return null;
    }
    async extractStructuredMemories(role, text, metadata = {}) {
        const now = Date.now();
        const memories = [];
        const meta = (metadata || {});
        const mode = String(meta.mode || "");
        const agentName = String(meta.agentName || "");
        const taskTitles = Array.isArray(meta.taskTitles) ? meta.taskTitles.map((task) => clip(task, 140)).filter(Boolean) : [];
        const promptSummary = clip(meta.prompt || meta.userPrompt || "", 180);
        const responseSummary = clip(text, 200);
        if (taskTitles.length) {
            for (const title of taskTitles.slice(0, 6)) {
                memories.push({
                    kind: "task",
                    subject: title,
                    summary: `Assigned work: ${title}`,
                    detail: clip(`Mode ${mode || "dispatch"}${agentName ? ` for ${agentName}` : ""}${promptSummary ? `. Brief: ${promptSummary}` : ""}`, 200),
                    tags: ["task", mode, agentName].filter(Boolean),
                    confidence: 0.78,
                    salience: 0.92
                });
            }
        }
        if (role === "kira" && promptSummary && responseSummary) {
            memories.push({
                kind: "summary",
                subject: `${mode || "conversation"} ${promptSummary}`.trim(),
                summary: `Latest response summary: ${responseSummary}`,
                detail: clip(`Input brief: ${promptSummary}`, 200),
                tags: ["summary", mode, agentName].filter(Boolean),
                confidence: 0.62,
                salience: 0.56
            });
        }
        for (const sentence of compactSentenceParts(text)) {
            const normalized = normalizeKey(sentence);
            if (normalized.length < 18)
                continue;
            if (/(^|\s)(prefer|avoid|always|never|do not|don't|should|shouldn't|must|must not)\b/.test(normalized)) {
                memories.push({
                    kind: "preference",
                    subject: sentence,
                    summary: clip(sentence, 180),
                    detail: role === "user" ? "User-stated preference or constraint." : "Assistant-stated operating preference or constraint.",
                    tags: ["preference", role, mode].filter(Boolean),
                    confidence: role === "user" ? 0.94 : 0.7,
                    salience: role === "user" ? 0.95 : 0.66
                });
            }
            if (/(^|\s)(decide|decided|decision|chosen|choose|selected|use |using |ship|plan)\b/.test(normalized)) {
                memories.push({
                    kind: "decision",
                    subject: sentence,
                    summary: clip(sentence, 180),
                    detail: mode ? `Captured during ${mode}.` : "Captured from conversation.",
                    tags: ["decision", role, mode].filter(Boolean),
                    confidence: 0.74,
                    salience: 0.88
                });
            }
            if (/(^|\s)(todo|task|next|follow up|implement|fix|build|review|verify|test)\b/.test(normalized)) {
                memories.push({
                    kind: "task",
                    subject: sentence,
                    summary: clip(sentence, 180),
                    detail: mode ? `Possible actionable work from ${mode}.` : "Possible actionable work from conversation.",
                    tags: ["task", role, mode].filter(Boolean),
                    confidence: 0.68,
                    salience: 0.8
                });
            }
            if (/(^|\s)(is|are|uses|runs|lives|stored|located|path|workspace|branch)\b/.test(normalized)) {
                memories.push({
                    kind: "fact",
                    subject: sentence,
                    summary: clip(sentence, 180),
                    detail: "Potential project or environment fact.",
                    tags: ["fact", role, mode].filter(Boolean),
                    confidence: 0.6,
                    salience: 0.58
                });
            }
        }
        for (const memory of memories.slice(0, 14)) {
            const pk = stablePk(memory.kind, memory.subject);
            const embedding = serializeEmbedding(await embedText(this.config, [memory.subject, memory.summary, memory.detail].filter(Boolean).join(" ")));
            const existing = this.get(`SELECT * FROM memory_items WHERE pk = ?`, [pk]);
            if (existing) {
                this.run(`UPDATE memory_items SET summary = ?, detail = ?, tags = ?, embedding = ?, source_role = ?, confidence = ?, salience = ?, updated_at = ?, last_used_at = ? WHERE pk = ?`, [
                    memory.summary,
                    memory.detail,
                    JSON.stringify(memory.tags || []),
                    embedding,
                    role,
                    Math.max(Number(existing.confidence || 0), Number(memory.confidence || 0.5)),
                    Math.max(Number(existing.salience || 0), Number(memory.salience || 0.5)),
                    now,
                    Number(existing.last_used_at || 0),
                    pk
                ]);
                continue;
            }
            this.run(`INSERT OR REPLACE INTO memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
                uuidv4(),
                pk,
                memory.kind,
                clip(memory.subject, 180),
                clip(memory.summary, 220),
                clip(memory.detail, 220),
                JSON.stringify(memory.tags || []),
                embedding,
                role,
                Number(memory.confidence || 0.5),
                Number(memory.salience || 0.5),
                0,
                now,
                now,
                0
            ]);
        }
    }
    insertMessage(role, content, metadata) {
        this.run(`INSERT INTO messages VALUES(?,?,?,?,?)`, [uuidv4(), role, content, Date.now(), JSON.stringify(metadata)]);
    }
    nextIdx() {
        this.run(`UPDATE counter SET val = val + 1 WHERE id = 1`);
        return Number(this.get(`SELECT val FROM counter WHERE id = 1`)?.val || 1);
    }
    query(sql, params = []) {
        try {
            const stmt = this.db.prepare(sql);
            if (params.length)
                stmt.bind(params);
            const rows = [];
            while (stmt.step())
                rows.push(stmt.getAsObject());
            stmt.free();
            return rows;
        }
        catch {
            return [];
        }
    }
    get(sql, params = []) {
        return this.query(sql, params)[0] || null;
    }
    run(sql, params = []) {
        this.db.run(sql, params);
        this.scheduleSave();
    }
    scheduleSave() {
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.save(), 100);
    }
    save() {
        fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    }
}
// @ts-nocheck
