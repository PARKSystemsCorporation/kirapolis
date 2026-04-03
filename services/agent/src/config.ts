// @ts-nocheck
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function getConfig() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const inferredRepoRoot = path.resolve(moduleDir, "..", "..", "..");
    const controlRoot = path.resolve(process.env.KIRA_CONTROL_ROOT || inferredRepoRoot);
    const projectRoot = path.resolve(process.env.KIRA_PROJECT_ROOT || controlRoot);
    const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_PUBLIC_URL || "").trim();
    const inferredPublicBaseUrl = railwayPublicDomain
        ? `https://${railwayPublicDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
        : "";
    const publicBaseUrl = String(process.env.KIRA_PUBLIC_BASE_URL || inferredPublicBaseUrl).replace(/\/+$/, "");
    const runtimeMode = String(process.env.KIRA_RUNTIME_MODE
        || process.env.RAILWAY_ENVIRONMENT
        || process.env.RAILWAY_PROJECT_ID
        || "local").trim().toLowerCase();
    const inferredExecutionTarget = runtimeMode === "production"
        || runtimeMode === "railway"
        || Boolean(process.env.RAILWAY_ENVIRONMENT)
        || Boolean(process.env.RAILWAY_PROJECT_ID)
        ? "railway"
        : "local";
    const inferredHost = inferredExecutionTarget === "railway" ? "0.0.0.0" : "127.0.0.1";
    const inferredPort = Number(process.env.PORT || process.env.KIRA_PORT || 4317);
    return {
        host: process.env.KIRA_HOST || inferredHost,
        port: Number.isFinite(inferredPort) ? inferredPort : 4317,
        controlRoot,
        projectRoot,
        workspaceRoot: projectRoot,
        publicBaseUrl,
        runtimeMode,
        modelLabExecutionTarget: String(process.env.KIRA_MODEL_LAB_EXECUTION_TARGET || inferredExecutionTarget).trim().toLowerCase() || inferredExecutionTarget,
        modelLabMachineLabel: String(process.env.KIRA_MODEL_LAB_MACHINE_LABEL
            || process.env.COMPUTERNAME
            || process.env.HOSTNAME
            || os.hostname()
            || "this computer").trim(),
        shell: process.env.ComSpec || process.env.SHELL || (process.platform === "win32" ? "powershell.exe" : "/bin/sh"),
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
