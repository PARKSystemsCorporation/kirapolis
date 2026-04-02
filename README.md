# Kirapolis

Kirapolis is a local-first operations and orchestration surface for multi-agent website production. It combines a desktop control room, an agent service layer, workspace-aware tooling, and an interactive office view for managing execution, review, and handoff loops from one place.

This repository is maintained by PARKSystems Corporation.

CEO & Founder: Ian Carroll

GitHub: https://github.com/PARKSystemsCorporation/kirapolis.git

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

### Run

```bash
npm install
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

## Notes

- Runtime-generated state is intentionally kept lightweight in Git. Local operational data, backups, caches, and memory databases should stay out of version control.
- The desktop app and agent service are designed to run against a configurable local workspace root.
- Model training and unlearning scripts are included for local experimentation and should be treated as operator tooling, not hosted production services.

## Ownership

Kirapolis is a PARKSystems Corporation project.
