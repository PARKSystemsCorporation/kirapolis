export async function chatWithOpenClaw(baseUrl, model, messages) {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model,
            messages,
            stream: false
        })
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`OpenClaw request failed with ${response.status}${detail ? `: ${detail.trim()}` : ""}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
}
