# Architecture

## Non-Negotiables

- Fully offline operation for coding flows
- KIRA must be native to the IDE, not a detached web app
- Shell and filesystem permissions must match a traditional local coding agent
- Model routing must support local DeepSeek deployments first
- OpenClaw integration should sit beside Ollama as a first-class provider path

## Proposed Stack

### 1. Editor Surface

Use VSCodium as the primary editing environment.

Why:

- already close to the VS Code extension model
- easy path to a native sidebar, terminal commands, webviews, status bar, and task wiring
- preserves a normal coding workflow instead of inventing a custom editor

### 2. Native Runtime

Use an Electron desktop shell only for orchestration:

- launch and supervise the local KIRA agent service
- manage model/provider settings
- expose terminal/session state
- optionally dock VSCodium or launch it alongside the shell

This keeps the IDE native while still giving you a place for system-level control.

### 3. Privileged Agent Service

Run a local Node service with:

- shell execution
- workspace read/write
- model chat routing
- tool execution loop
- KIRA policies and memory hooks

This is the trust boundary. If you want "full permissions like Codex CLI", this service owns them.

### 4. Providers

- `ollama`: native `/api/chat` or `/api/generate` path for local DeepSeek/Qwen/etc.
- `openclaw`: adapter path for a local OpenAI-compatible or OpenClaw-local endpoint

The current scaffold treats OpenClaw as a configurable local provider. If its exact local API differs in your install, the adapter is the single place to change it.

## `thisisit.js` Extraction Plan

`thisisit.js` appears to be a pasted aggregate of several files. Extraction should happen in passes:

1. Move provider logic into `services/agent/src/providers/`
2. Move memory/correlation logic into `services/agent/src/kira/memory/`
3. Move Express-style HTTP routes into `services/agent/src/server.ts`
4. Ignore old UI code until the VSCodium extension owns the operator interface

Do not continue building on the concatenated file directly. It is valuable as source material but weak as a runtime boundary.

