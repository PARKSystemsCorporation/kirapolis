import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "kirapolis-memory-api-"));
const port = 4541;

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("memory API test server failed to become healthy");
}

async function api(pathname, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Request failed: ${response.status}`);
  }
  return data;
}

const child = spawn("node", ["services/agent/dist/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KIRA_CONTROL_ROOT: tempRoot,
    KIRA_PROJECT_ROOT: tempRoot,
    KIRA_PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

child.stdout.on("data", () => {});
child.stderr.on("data", () => {});

try {
  await waitForHealth();

  const team = await api("/api/team/agents");
  const agent = (team.agents || [])[0];
  assert.ok(agent?.id, "seed agent should exist");

  let memoryState = await api(`/api/team/agents/${encodeURIComponent(agent.id)}/memory?limit=10`);
  assert.ok(memoryState.stats, "memory stats should be returned");

  const episode = await api(`/api/team/agents/${encodeURIComponent(agent.id)}/memory/episodes`, "POST", {
    title: "API memory episode",
    action: "Checked the new endpoint",
    outcome: "Endpoint returned a successful response",
    nextStep: "Verify update and delete paths"
  });
  assert.ok(episode.episode?.id, "manual episode endpoint should create a record");

  memoryState = await api(`/api/team/agents/${encodeURIComponent(agent.id)}/memory?limit=20&includeArchived=true`);
  const created = (memoryState.memory || []).find((item) => item.id === episode.episode.id);
  assert.ok(created, "created episode should be listable");

  const patched = await api(`/api/team/agents/${encodeURIComponent(agent.id)}/memory/${encodeURIComponent(created.id)}`, "PATCH", {
    pinned: true,
    status: "candidate"
  });
  assert.equal(Number(patched.memory?.pinned || 0), 1, "patch endpoint should update pinned");

  const consolidation = await api(`/api/team/agents/${encodeURIComponent(agent.id)}/memory/consolidate`, "POST", {
    scopeType: "agent",
    scopeId: agent.id
  });
  assert.ok(consolidation.ok, "consolidation endpoint should succeed");

  const forgotten = await api(`/api/team/agents/${encodeURIComponent(agent.id)}/memory/${encodeURIComponent(created.id)}`, "DELETE");
  assert.ok(forgotten.ok, "delete endpoint should archive memory");

  console.log("Memory API test passed.");
} finally {
  child.kill("SIGTERM");
  await fs.rm(tempRoot, { recursive: true, force: true });
}
