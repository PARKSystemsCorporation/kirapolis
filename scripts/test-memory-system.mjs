import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kirapolis-memory-"));
const { KiraBrain } = await import(pathToFileURL(path.resolve("services/agent/dist/kira/brain.js")).href);

async function main() {
  const brain = new KiraBrain({
    workspaceRoot: tempRoot,
    memoryPath: path.join(tempRoot, "memory.db"),
    provider: "ollama",
    embeddingModel: "",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openClawBaseUrl: "http://127.0.0.1:11434",
    models: { executive: "test", coder: "test", fast: "test" }
  });
  await brain.init();

  await brain.handleUserMessage("Please prefer Geist Sans for interface typography and keep launch copy concise.", {
    scopeType: "agent",
    scopeId: "agent-test",
    agentId: "agent-test",
    agentName: "Test Agent"
  });
  await brain.recordAssistantMessage("We decided to use Geist Sans in the UI and keep the marketing voice concise.", {
    scopeType: "agent",
    scopeId: "agent-test",
    mode: "dispatch",
    prompt: "Typography and copy direction"
  });
  await brain.storeMemoryItem({
    kind: "fact",
    subject: "Shared project brief",
    summary: "The project is open source under Apache-2.0.",
    detail: "Keep docs and release copy aligned with the Apache license.",
    scopeType: "project",
    scopeId: "global",
    sourceRole: "system",
    confidence: 0.95,
    salience: 0.95,
    pinned: true
  });
  await brain.storeMemoryItem({
    kind: "summary",
    subject: "Closed Loop room update",
    summary: "Frontend Builder reported the navigation polish pass is complete.",
    detail: "Room update for group-core-team.",
    scopeType: "room",
    scopeId: "group-core-team",
    sourceRole: "assistant",
    confidence: 0.8,
    salience: 0.84
  });
  await brain.recordEpisode({
    title: "Homepage polish loop",
    action: "Adjusted navigation spacing",
    outcome: "Resolved crowded header layout",
    nextStep: "Verify on mobile",
    scopeType: "agent",
    scopeId: "agent-test",
    source: "test",
    sourceRole: "system"
  });

  const recall = await brain.structuredMemoryContext("What font did we choose for the interface?");
  assert.match(recall, /geist sans/i, "semantic/structured recall should recover typography choice");

  await brain.storeMemoryItem({
    kind: "fact",
    subject: "Deployment target",
    summary: "Deploy the app to Vercel.",
    detail: "Initial deployment target.",
    scopeType: "project",
    scopeId: "global",
    sourceRole: "system"
  });
  await brain.storeMemoryItem({
    kind: "fact",
    subject: "Deployment target",
    summary: "Deploy the app to Railway.",
    detail: "Superseding deployment target.",
    scopeType: "project",
    scopeId: "global",
    sourceRole: "system"
  });

  const projectMemories = brain.listMemoryItems({ scopeType: "project", scopeId: "global", includeArchived: true, limit: 20 });
  assert.ok(projectMemories.some((item) => /Apache-2.0/i.test(String(item.summary || ""))), "project-scoped memories should be retrievable");
  assert.ok(projectMemories.some((item) => Array.isArray(item.links) && item.links.some((link) => /supersedes|contradicts/i.test(String(link.relation || "")))), "conflict links should be present");

  const consolidation = await brain.consolidateMemories("agent", "agent-test");
  assert.ok(consolidation, "consolidation should create a summary item");

  const stats = brain.getStats();
  assert.ok(Number(stats.structured || 0) >= 5, "structured memory stats should increase");
  assert.ok(Number(stats.episodes || 0) >= 1, "episode stats should increase");

  if (brain.saveTimer) {
    clearTimeout(brain.saveTimer);
  }
  brain.save();
  console.log("Memory system test passed.");
  return brain;
}

try {
  await main();
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
