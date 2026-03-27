function containsAny(text, needles) {
    return needles.some((needle) => text.includes(needle));
}
export function pickModel(config, prompt) {
    const normalized = prompt.toLowerCase();
    if (containsAny(normalized, [
        "write code",
        "patch",
        "refactor",
        "fix bug",
        "fix test",
        "debug",
        "typescript",
        "javascript",
        "python",
        "rust",
        "go ",
        "regex",
        "function",
        "class ",
        "stack trace",
        "compiler",
        "lint",
        "failing test"
    ])) {
        return {
            role: "coder",
            model: config.models.coder,
            reason: "coding-intelligence request"
        };
    }
    if (containsAny(normalized, [
        "json",
        "extract",
        "summarize briefly",
        "one line",
        "classify",
        "rename suggestions",
        "format this",
        "convert to"
    ])) {
        return {
            role: "fast",
            model: config.models.fast,
            reason: "short structured transformation"
        };
    }
    return {
        role: "executive",
        model: config.models.executive,
        reason: "general planning or orchestration"
    };
}
// @ts-nocheck
