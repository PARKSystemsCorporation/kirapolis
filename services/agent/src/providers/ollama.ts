export async function chatWithOllama(baseUrl, model, messages) {
    const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model,
            stream: false,
            messages
        })
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Ollama request failed with ${response.status}${detail ? `: ${detail.trim()}` : ""}`);
    }
    const data = await response.json();
    return data.message?.content?.trim() || "";
}
// @ts-nocheck
