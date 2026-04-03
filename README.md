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

## Railway Quick Deploy

For a public GitHub deploy, the intended path is:

1. Create a new Railway project from this repo.
2. Add the required service variables.
3. Click deploy.

The app now auto-detects Railway's `PORT`, binds to `0.0.0.0`, and can infer its public base URL from Railway when available.

Minimum Railway variables:

- `KIRA_ACCESS_PASSWORD`: required if you want the hosted dashboard protected
- `OLLAMA_BASE_URL`: your reachable model endpoint
- `OPENCLAW_BASE_URL`: your reachable OpenAI-compatible endpoint if used

Recommended Railway variables:

- `KIRA_PUBLIC_BASE_URL`: optional override for webhook/manual URLs
- `KIRA_RAILWAY_WEBHOOK_SECRET`: protects the Railway webhook endpoint
- `KIRA_PROVIDER`: usually `ollama`
- `KIRA_MODEL`
- `KIRA_MODEL_EXECUTIVE`
- `KIRA_MODEL_CODER`
- `KIRA_MODEL_FAST`
- `KIRA_MODEL_EMBEDDING`
- `KIRA_RUNTIME_MODE=railway`
- `KIRA_MODEL_LAB_EXECUTION_TARGET=railway`

If you want the hosted app to stay fully operator-controlled, do not commit real values for any of those to the repo. Keep them only in Railway variables.

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

### Containers Without Docker Desktop

This repo now uses Podman as the free local container runtime path on Windows instead of Docker Desktop.

Use:

```bash
npm run container:doctor
npm run container:init
npm run container:build
```

Notes:

- `winget` is not part of the normal workflow anymore.
- Podman on Windows needs WSL2 once. If `container:doctor` says WSL is missing, run an elevated PowerShell command:

```powershell
wsl --install
```

- After the required reboot, `npm run container:init` will create and start the Podman machine.

### Environment

Start from [`.env.example`](./.env.example) and set the values you actually want to use locally.

Do not commit real credentials, passwords, webhook secrets, or private endpoint URLs into this repository. For hosted deployments, keep those values only in Railway service variables. The committed example file should stay placeholder-only.

Important keys:

- `KIRA_CONTROL_ROOT`: control-plane root directory
- `KIRA_PROJECT_ROOT`: workspace root the app should operate against
- `KIRA_PROVIDER`: default model provider
- `OLLAMA_BASE_URL`: local Ollama endpoint
- `OPENCLAW_BASE_URL`: local OpenClaw-compatible endpoint
- `KIRA_MODEL_EMBEDDING`: optional embedding-capable model for semantic memory recall
- `KIRA_PUBLIC_BASE_URL`: optional public base URL for webhook and manual verification flows
- `KIRA_RUNTIME_MODE`: label the runtime as `local` or `railway`
- `KIRA_MODEL_LAB_EXECUTION_TARGET`: tells the model lab whether jobs are being run on your local computer or on Railway
- `KIRA_MODEL_LAB_MACHINE_LABEL`: optional machine name shown in the model-lab UI for local runs

### Railway Variables

For the public repo, keep secrets and deployment-only values in Railway variables rather than tracked files. Typical values to set there:

- `KIRA_ACCESS_PASSWORD`
- `KIRA_RAILWAY_WEBHOOK_SECRET`
- `KIRA_PUBLIC_BASE_URL`
- `OLLAMA_BASE_URL`
- `OPENCLAW_BASE_URL`
- `KIRA_MODEL`
- `KIRA_MODEL_EXECUTIVE`
- `KIRA_MODEL_CODER`
- `KIRA_MODEL_FAST`
- `KIRA_MODEL_EMBEDDING`
- `KIRA_RUNTIME_MODE=railway`
- `KIRA_MODEL_LAB_EXECUTION_TARGET=railway`

Railway-specific behavior handled automatically:

- Uses Railway's injected `PORT`
- Binds to `0.0.0.0`
- Infers `KIRA_PUBLIC_BASE_URL` from Railway's public domain when possible

### Local Abliteration / Model Lab

If you want the abliteration and weight-unlearning flows to register as running on your workstation instead of Railway, set these in your local `.env`:

```bash
KIRA_RUNTIME_MODE=local
KIRA_MODEL_LAB_EXECUTION_TARGET=local
KIRA_MODEL_LAB_MACHINE_LABEL=Local Machine
```

Once those are set, the Model Lab panel will label neutralization and weight-unlearning runs as executing on your local computer.

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
