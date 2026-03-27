import { chatWithOllama } from "../providers/ollama.js";
import { chatWithOpenClaw } from "../providers/openclaw.js";
import { pickModel } from "./model-router.js";
const SYSTEM_PROMPT = [
    "You are KIRA, a fully local coding agent embedded inside KiraDex.",
    "Operate as a pragmatic software engineer.",
    "Prefer direct action in the workspace when tool access is available.",
    "Assume full local permissions inside the configured workspace root.",
    "Keep responses concise and execution-focused."
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
export async function runKiraChat(config, brain, userPrompt) {
    const decision = pickModel(config, userPrompt);
    const selectedModel = await resolveModel(config, decision.model);
    const systemPrompt = await brain.handleUserMessage(userPrompt);
    const messages = [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n${systemPrompt}` },
        { role: "user", content: userPrompt }
    ];
    if (config.provider === "openclaw") {
        const content = await chatWithOpenClaw(config.openClawBaseUrl, selectedModel, messages);
        brain.recordAssistantMessage(content);
        return {
            content,
            model: selectedModel,
            role: decision.role,
            reason: selectedModel === decision.model ? decision.reason : `${decision.reason}; fell back to installed model ${selectedModel}`
        };
    }
    const content = await chatWithOllama(config.ollamaBaseUrl, selectedModel, messages);
    brain.recordAssistantMessage(content);
    return {
        content,
        model: selectedModel,
        role: decision.role,
        reason: selectedModel === decision.model ? decision.reason : `${decision.reason}; fell back to installed model ${selectedModel}`
    };
}
