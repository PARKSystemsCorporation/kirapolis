# Workspace Boundary

## Control Plane

- `C:\kiradex` is the KiraDex control plane.
- It owns the desktop shell, local agent service, runtime registry, dashboard state, and group-note storage.
- It does not own website source files.

## Project Workspace

- `C:\parks\web\newpark` is the website workspace.
- All agent reads, writes, tests, lint runs, builds, deploys, and git operations must stay inside `newpark`.

## Enforced Runtime Rules

- The backend advertises:
  - `controlRoot = C:\kiradex`
  - `projectRoot = C:\parks\web\newpark`
- Seeded agents are pinned to `projectRoot`.
- Agent memory databases stay under `C:\kiradex\data\agents`.
- Workspace file APIs resolve against `projectRoot`.
- Control-plane note reads use a dedicated `__control__/...` read prefix and are read-only.

## Safe Clean

- `npm run clean` must never remove source, runtime dist files, or control-plane state required to launch KiraDex.
- The current clean script only removes cache-style artifacts.
