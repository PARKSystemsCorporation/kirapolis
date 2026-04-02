// @ts-nocheck
import path from "node:path";
import { fileURLToPath } from "node:url";
export function getConfig() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const inferredRepoRoot = path.resolve(moduleDir, "..", "..", "..");
    const controlRoot = path.resolve(process.env.KIRA_CONTROL_ROOT || inferredRepoRoot);
    const projectRoot = path.resolve(process.env.KIRA_PROJECT_ROOT || controlRoot);
    const publicBaseUrl = String(process.env.KIRA_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    return {
        host: process.env.KIRA_HOST || "0.0.0.0",
        port: Number(process.env.KIRA_PORT || 4317),
        controlRoot,
        projectRoot,
        workspaceRoot: projectRoot,
        publicBaseUrl,
        shell: process.env.ComSpec || "powershell.exe",
        provider: process.env.KIRA_PROVIDER || "ollama",
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
        openClawBaseUrl: process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:11434",
        railwayWebhookSecret: process.env.KIRA_RAILWAY_WEBHOOK_SECRET || process.env.RAILWAY_WEBHOOK_SECRET || "",
        embeddingModel: process.env.KIRA_MODEL_EMBEDDING || process.env.KIRA_EMBED_MODEL || process.env.KIRA_MODEL_FAST || process.env.KIRA_MODEL || "",
        models: {
            executive: process.env.KIRA_MODEL_EXECUTIVE || process.env.KIRA_MODEL || "deepseek-v2.5",
            coder: process.env.KIRA_MODEL_CODER || process.env.KIRA_MODEL || "deepseek-coder-v2",
            fast: process.env.KIRA_MODEL_FAST || process.env.KIRA_MODEL || "qwen2.5-coder:7b"
        }
    };
}
