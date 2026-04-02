const EMBEDDING_DIM = 96;
function normalizeText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function tokenize(text) {
    return normalizeText(text)
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2);
}
function charTrigrams(text) {
    const value = ` ${normalizeText(text)} `;
    const grams = [];
    for (let i = 0; i < Math.max(0, value.length - 2); i++) {
        grams.push(value.slice(i, i + 3));
    }
    return grams;
}
function hashToken(token) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0);
}
function normalizeVector(vector) {
    const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
    if (!magnitude) {
        return vector;
    }
    return vector.map((value) => value / magnitude);
}
export function buildLocalEmbedding(text) {
    const vector = new Array(EMBEDDING_DIM).fill(0);
    const tokens = tokenize(text);
    const grams = charTrigrams(text);
    for (const token of tokens) {
        const index = hashToken(token) % EMBEDDING_DIM;
        vector[index] += 1.2;
    }
    for (const gram of grams) {
        const index = hashToken(gram) % EMBEDDING_DIM;
        vector[index] += 0.35;
    }
    return normalizeVector(vector);
}
export function serializeEmbedding(vector) {
    return JSON.stringify((Array.isArray(vector) ? vector : []).map((value) => Number(value || 0)));
}
export function parseEmbedding(raw) {
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(String(raw));
        return Array.isArray(parsed) ? parsed.map((value) => Number(value || 0)) : [];
    }
    catch {
        return [];
    }
}
export function cosineSimilarity(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length || left.length !== right.length) {
        return 0;
    }
    let sum = 0;
    for (let index = 0; index < left.length; index += 1) {
        sum += Number(left[index] || 0) * Number(right[index] || 0);
    }
    return sum;
}
export async function embedText(config, text) {
    const input = normalizeText(text);
    if (!input) {
        return buildLocalEmbedding("");
    }
    const fallback = buildLocalEmbedding(input);
    const model = String(config.embeddingModel || config.models?.fast || "").trim();
    if (!model) {
        return fallback;
    }
    try {
        if (config.provider === "openclaw") {
            const response = await fetch(`${String(config.openClawBaseUrl || "").replace(/\/$/, "")}/v1/embeddings`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model,
                    input
                })
            });
            if (!response.ok) {
                return fallback;
            }
            const data = await response.json();
            const embedding = data?.data?.[0]?.embedding;
            return Array.isArray(embedding) && embedding.length ? normalizeVector(embedding.map((value) => Number(value || 0))) : fallback;
        }
        const response = await fetch(`${String(config.ollamaBaseUrl || "").replace(/\/$/, "")}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model,
                input
            })
        });
        if (!response.ok) {
            return fallback;
        }
        const data = await response.json();
        const embedding = Array.isArray(data?.embeddings) ? data.embeddings[0] : data?.embedding;
        return Array.isArray(embedding) && embedding.length ? normalizeVector(embedding.map((value) => Number(value || 0))) : fallback;
    }
    catch {
        return fallback;
    }
}
