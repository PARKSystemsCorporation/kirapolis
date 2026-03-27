import fs from "node:fs";
import path from "node:path";
import initSqlJs from "sql.js";
import { v4 as uuidv4 } from "uuid";
import winkPOS from "wink-pos-tagger";
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
        this.run(`CREATE INDEX IF NOT EXISTS idx_short_pk ON short(pk)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_medium_pk ON medium(pk)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_long_pk ON long_term(pk)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_short_words ON short(w1, w2)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_medium_words ON medium(w1, w2)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_long_words ON long_term(w1, w2)`);
        this.save();
    }
    async handleUserMessage(text) {
        this.insertMessage("user", text, {});
        this.decay();
        this.processMessage(text);
        const systemPrompt = this.buildSystemPrompt(text);
        return systemPrompt;
    }
    recordAssistantMessage(text) {
        this.insertMessage("kira", text, {});
    }
    getStats() {
        return {
            short: Number(this.get(`SELECT COUNT(*) AS c FROM short`)?.c || 0),
            medium: Number(this.get(`SELECT COUNT(*) AS c FROM medium`)?.c || 0),
            long: Number(this.get(`SELECT COUNT(*) AS c FROM long_term`)?.c || 0),
            messages: Number(this.get(`SELECT val AS c FROM counter WHERE id = 1`)?.c || 0)
        };
    }
    buildSystemPrompt(userMessage) {
        const mem = this.memoryContext(userMessage);
        const history = this.query(`SELECT role, content FROM messages ORDER BY created_at DESC LIMIT 8`).reverse().map((row) => `${row.role}: ${row.content}`).join("\n");
        return [
            "You are KIRA, an autonomous AI with persistent SQLite memory and correlation-based learning.",
            "Operate like a pragmatic software engineer with ongoing memory reinforcement and decay.",
            "Never explain the internal memory mechanism unless explicitly asked.",
            mem ? mem : "",
            history ? `Recent conversation:\n${history}` : ""
        ].filter(Boolean).join("\n\n");
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
