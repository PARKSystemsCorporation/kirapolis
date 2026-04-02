export const STOPS = new Set([
  "a", "an", "the", "i", "me", "my", "we", "you", "he", "she", "it", "they", "is", "are", "was", "were", "be", "been",
  "have", "has", "had", "do", "does", "did", "will", "would", "can", "could", "and", "but", "or", "if", "of", "to", "in",
  "for", "on", "with", "at", "by", "from", "so", "as", "that", "this", "what", "which", "who", "how", "when", "where", "why",
  "all", "each", "some", "any", "no", "not", "just", "also", "very", "too", "really", "thing", "things", "way", "even",
  "like", "get", "got", "ok", "yeah", "yes", "hey", "hi", "hello"
]);

export const POS = {
  NN: "noun", NNS: "noun", NNP: "noun", NNPS: "noun",
  VB: "verb", VBD: "verb", VBG: "verb", VBN: "verb", VBP: "verb", VBZ: "verb",
  JJ: "adj", JJR: "adj", JJS: "adj",
  RB: "adv", RBR: "adv", RBS: "adv"
};

export const MEMORY_KIND_PRIORITY = ["decision", "task", "preference", "fact", "summary"];
export const ACTIVE_MEMORY_STATUSES = new Set(["active", "pinned", "candidate"]);

export function clip(text, max = 220) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3)).trim()}...`;
}

export function normalizeKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stablePk(kind, subject) {
  return `${kind}:${normalizeKey(subject)}`;
}

export function scopePk(scopeType, scopeId) {
  return `${String(scopeType || "agent")}:${normalizeKey(scopeId || "global")}`;
}

export function compactSentenceParts(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function score(posA, posB, dist) {
  const cat = (posA === "noun" && posB === "noun") ? 0.3 : (posA === "adj" || posB === "adj") ? 0.2 : 0.1;
  const prox = dist === 0 ? 0.4 : dist === 1 ? 0.3 : dist <= 3 ? 0.2 : 0.1;
  return Math.min(0.15 + cat + prox, 1.0);
}

export function tierFor(scoreValue) {
  return scoreValue >= 0.65 ? "long_term" : scoreValue >= 0.25 ? "medium" : "short";
}
