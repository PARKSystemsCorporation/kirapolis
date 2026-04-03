import { chatWithOllama } from "../providers/ollama.js";
import { chatWithOpenClaw } from "../providers/openclaw.js";
import { pickModel } from "./model-router.js";
const SYSTEM_PROMPT = [
    "You are Kirapolis, a fully local coding agent embedded inside the Kirapolis control plane.",
    "Operate as a pragmatic software engineer.",
    "Prefer direct action in the workspace when tool access is available.",
    "Assume full local permissions inside the configured workspace root.",
    "Keep responses concise and execution-focused.",
    "Unknowns are normal: map them, create hypotheses, prototype safely, record what you learn, and turn discoveries into concrete next steps.",
    "Build today's website so it can evolve into a larger immersive world platform later without wasteful rewrites."
].join(" ");
async function fetchVisibleModels(config) {
    const endpoint = config.provider === "openclaw"
        ? `${config.openClawBaseUrl.replace(/\/$/, "")}/v1/models`
        : `${config.ollamaBaseUrl.replace(/\/$/, "")}/api/tags`;
    const response = await fetch(endpoint);
    if (!response.ok) {
        return [];
    }
    const data = await response.json();
    if ("data" in data) {
        return (data.data || []).map((item) => item.id || "").filter(Boolean);
    }
    return ("models" in data ? (data.models || []) : []).map((item) => item.name || item.model || "").filter(Boolean);
}
async function resolveModel(config, requestedModel) {
    const availableModels = await fetchVisibleModels(config);
    if (!availableModels.length || availableModels.includes(requestedModel)) {
        return requestedModel;
    }
    return availableModels[0];
}
export async function runKiraChat(config, brain, userPrompt, interactionMetadata = {}) {
    const decision = pickModel(config, userPrompt);
    const selectedModel = await resolveModel(config, decision.model);
    let systemPrompt;
    try {
        systemPrompt = await brain.handleUserMessage(userPrompt, interactionMetadata);
    }
    catch (error) {
        console.warn("[kira] memory handling failed, using base prompt:", error instanceof Error ? error.message : String(error));
        systemPrompt = "";
    }
    const messages = [
        { role: "system", content: `${SYSTEM_PROMPT}${systemPrompt ? `\n\n${systemPrompt}` : ""}` },
        { role: "user", content: userPrompt }
    ];
    try {
        let content;
        if (config.provider === "openclaw") {
            content = await chatWithOpenClaw(config.openClawBaseUrl, selectedModel, messages);
        }
        else {
            content = await chatWithOllama(config.ollamaBaseUrl, selectedModel, messages);
        }
        await brain.recordAssistantMessage(content, interactionMetadata).catch((error) => {
            console.warn("[kira] failed to record assistant message:", error instanceof Error ? error.message : String(error));
        });
        return {
            content,
            model: selectedModel,
            role: decision.role,
            reason: selectedModel === decision.model ? decision.reason : `${decision.reason}; fell back to installed model ${selectedModel}`
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[kira] chat provider error:", message);
        return {
            content: `Model unavailable: ${message}`,
            model: selectedModel,
            role: decision.role,
            reason: `Provider error: ${message}`
        };
    }
}
// @ts-nocheck
