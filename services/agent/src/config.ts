// @ts-nocheck
import path from "node:path";
export function getConfig() {
    const controlRoot = path.resolve(process.env.KIRA_CONTROL_ROOT || "C:\\kiradex");
    const projectRoot = path.resolve(process.env.KIRA_PROJECT_ROOT || "C:\\parks\\web\\newpark");
    return {
        host: process.env.KIRA_HOST || "127.0.0.1",
        port: Number(process.env.KIRA_PORT || 4317),
        controlRoot,
        projectRoot,
        workspaceRoot: projectRoot,
        shell: process.env.ComSpec || "powershell.exe",
        provider: process.env.KIRA_PROVIDER || "ollama",
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
        openClawBaseUrl: process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:11434",
        models: {
            executive: process.env.KIRA_MODEL_EXECUTIVE || process.env.KIRA_MODEL || "deepseek-v2.5",
            coder: process.env.KIRA_MODEL_CODER || process.env.KIRA_MODEL || "deepseek-coder-v2",
            fast: process.env.KIRA_MODEL_FAST || process.env.KIRA_MODEL || "qwen2.5-coder:7b"
        }
    };
}
