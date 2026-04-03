# Kirapolis

Kirapolis is a local-first operations and orchestration surface for multi-agent website production. It combines a desktop control room, an agent service layer, workspace-aware tooling, and an interactive office view for managing execution, review, and handoff loops from one place.

This repository is open source under the Apache License 2.0.

## Quick Start

```bash
npm install
cp .env.example .env
npm start
```

The agent service runs on `http://0.0.0.0:4317` by default. Open `http://localhost:4317/experience/office/` for the office view, or `http://localhost:4317/app` for the full dashboard. Access from other devices on your network at `http://<your-ip>:4317/`.

## What It Includes

- Electron desktop app for the main control surface
- Node-based agent service for orchestration, state, and workspace operations
- Multi-agent team registry, messenger flows, and operational dashboards
- Local office view for room management, previews, files, notes, and task visibility
- Persistent per-agent memory with structured recall, reinforcement/decay, and semantic retrieval
- Weight unlearning and persona tooling for local model experimentation

## Repository Structure

- `apps/desktop`: Electron application and office interface
- `services/agent`: Agent runtime, APIs, registries, and orchestration logic
- `scripts`: Utility scripts for setup, experimentation, maintenance, and evaluation
- `data`: Starter data, templates, and local runtime state
- `docs`: Supporting project documentation

## Local Development

### Requirements

- Node.js and npm
- Python for the training and evaluation scripts
- A local model runtime if you want to use the model tooling paths
- Works on Windows, macOS, and Linux

### Run

```bash
npm install
npm start
```

### Desktop App (Electron)

```bash
npm run start:desktop
```

### Typecheck

```bash
npm run typecheck
```

### Environment

Start from [`.env.example`](./.env.example) and set the values you actually want to use locally.

Important keys:

- `KIRA_CONTROL_ROOT`: control-plane root directory
- `KIRA_PROJECT_ROOT`: workspace root the app should operate against
- `KIRA_PROVIDER`: default model provider
- `OLLAMA_BASE_URL`: local Ollama endpoint
- `OPENCLAW_BASE_URL`: local OpenClaw-compatible endpoint
- `KIRA_MODEL_EMBEDDING`: optional embedding-capable model for semantic memory recall
- `KIRA_PUBLIC_BASE_URL`: optional public base URL for webhook and manual verification flows

### Memory System

Kirapolis includes a layered local memory system for agents:

- Message history and correlation memory stored in SQLite per agent
- Structured memory items for decisions, tasks, preferences, facts, summaries, and explicit episodes
- Reinforcement and decay to keep short-, medium-, and long-term traces moving over time
- Semantic retrieval using provider embeddings when available, with a deterministic local fallback
- Scope-aware recall across agent-private, project-wide, and room-scoped memories
- Conflict tracking so superseded facts and decisions can be inspected instead of silently piling up
- Consolidation tools and a desktop inspector for pinning, archiving, and reviewing memory items

Each agent keeps its own memory database under `data/agents/<agent-id>/memory.db`.

### Memory Test

```bash
npm run test:memory
```

## Notes

- Runtime-generated state is intentionally kept lightweight in Git. Local operational data, backups, caches, and memory databases should stay out of version control.
- The desktop app and agent service are designed to run against a configurable local workspace root.
- Model training and unlearning scripts are included for local experimentation and should be treated as operator tooling, not hosted production services.
- TypeScript is compiled to `dist/` on build. These are gitignored and rebuilt from source via `npm run build`.

## Release Hygiene

- Use [`.env.example`](./.env.example) as the starting point for local configuration.
- Review [`.gitignore`](./.gitignore) before pushing new runtime-generated paths.
- Use [`docs/release-checklist.md`](./docs/release-checklist.md) before public updates.

## License

This project is licensed under the Apache License 2.0.

See [`LICENSE`](./LICENSE).
