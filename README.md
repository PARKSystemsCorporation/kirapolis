# Kirapolis

Kirapolis is a local-first operations and orchestration surface for multi-agent website production. It combines a desktop control room, an agent service layer, workspace-aware tooling, and an interactive office view for managing execution, review, and handoff loops from one place.

This repository is maintained by PARKSystems Corporation.

CEO & Founder: Ian Carroll

GitHub: https://github.com/PARKSystemsCorporation/kirapolis.git

## Quick Start

```bash
npm install
copy .env.example .env
npm run build
npm start
```

The desktop app launches the main control surface, and the agent service runs on `http://127.0.0.1:4317` by default.

## What It Includes

- Electron desktop app for the main control surface
- Node-based agent service for orchestration, state, and workspace operations
- Multi-agent team registry, messenger flows, and operational dashboards
- Local office view for room management, previews, files, notes, and task visibility
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
- Windows is the current primary development environment

### Run

```bash
npm install
npm run typecheck
npm run build
npm start
```

### Service Only

```bash
npm run start:agent
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
- `KIRA_PUBLIC_BASE_URL`: optional public base URL for webhook and manual verification flows

## Notes

- Runtime-generated state is intentionally kept lightweight in Git. Local operational data, backups, caches, and memory databases should stay out of version control.
- The desktop app and agent service are designed to run against a configurable local workspace root.
- Model training and unlearning scripts are included for local experimentation and should be treated as operator tooling, not hosted production services.
- Compiled `dist` output is checked in for convenience, but marked as generated in `.gitattributes`.

## Release Hygiene

- Use [`.env.example`](./.env.example) as the starting point for local configuration.
- Review [`.gitignore`](./.gitignore) before pushing new runtime-generated paths.
- Use [`docs/release-checklist.md`](./docs/release-checklist.md) before public updates.

## License

No open-source license has been added in this pass. That keeps rights reserved by default until PARKSystems Corporation decides otherwise.

## Ownership

Kirapolis is a PARKSystems Corporation project.
