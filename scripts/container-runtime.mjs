import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";

const repoRoot = process.cwd();
const imageName = process.env.KIRAPOLIS_CONTAINER_IMAGE || "kirapolis-local-verify";
const localPodmanPath = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Programs", "Podman", "podman.exe")
  : "";
const podmanCandidates = [
  process.env.PODMAN_PATH,
  localPodmanPath,
  "podman",
].filter(Boolean);

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "pipe",
    encoding: "utf8",
    ...options,
  });
}

function resolvePodman() {
  for (const candidate of podmanCandidates) {
    const probe = run(candidate, ["--version"]);
    if (probe.status === 0) {
      return candidate;
    }
  }
  return "";
}

function printBlock(text) {
  process.stdout.write(`${text.trim()}\n`);
}

function fail(message, details = "") {
  process.stderr.write(`${message}\n`);
  if (details.trim()) {
    process.stderr.write(`${details.trim()}\n`);
  }
  process.exitCode = 1;
}

function checkWsl() {
  const probe = run("wsl.exe", ["--status"]);
  const output = `${probe.stdout || ""}${probe.stderr || ""}`.trim();
  return {
    ok: probe.status === 0,
    output,
  };
}

function doctor() {
  const podman = resolvePodman();
  if (!podman) {
    return fail("Podman is not installed or not on PATH.");
  }
  const wsl = checkWsl();
  const machine = run(podman, ["machine", "list"]);
  printBlock(`
Container Runtime
- podman: ${podman}
- wsl: ${wsl.ok ? "installed" : "missing"}
- machine-list-exit: ${machine.status ?? 1}
`);
  if (!wsl.ok) {
    return fail(
      "WSL is required before Podman can run containers on Windows.",
      "Run an elevated PowerShell once: wsl --install"
    );
  }
  if (machine.status !== 0) {
    return fail(
      "Podman is installed but the machine is not ready yet.",
      "Run: npm run container:init"
    );
  }
  process.stdout.write(`${(machine.stdout || "").trim()}\n`);
}

function init() {
  const podman = resolvePodman();
  if (!podman) {
    return fail("Podman is not installed or not on PATH.");
  }
  const wsl = checkWsl();
  if (!wsl.ok) {
    return fail(
      "WSL is required before Podman can initialize its machine.",
      "Run an elevated PowerShell once: wsl --install"
    );
  }
  const initResult = run(podman, ["machine", "init"]);
  if (initResult.status !== 0) {
    const initText = `${initResult.stdout || ""}\n${initResult.stderr || ""}`;
    if (!/exists/i.test(initText)) {
      return fail("Podman machine init failed.", initText);
    }
  }
  const startResult = run(podman, ["machine", "start"]);
  if (startResult.status !== 0) {
    return fail(
      "Podman machine start failed.",
      `${startResult.stdout || ""}\n${startResult.stderr || ""}`
    );
  }
  const info = run(podman, ["info"]);
  if (info.status !== 0) {
    return fail("Podman started but info failed.", `${info.stdout || ""}\n${info.stderr || ""}`);
  }
  process.stdout.write(info.stdout || "");
}

function build() {
  const podman = resolvePodman();
  if (!podman) {
    return fail("Podman is not installed or not on PATH.");
  }
  const info = run(podman, ["info"]);
  if (info.status !== 0) {
    return fail(
      "Podman is not ready for builds.",
      "Run `npm run container:init` after WSL is installed."
    );
  }
  const result = spawnSync(podman, ["build", "-t", imageName, "."], {
    cwd: repoRoot,
    stdio: "inherit",
    encoding: "utf8",
  });
  process.exitCode = result.status ?? 1;
}

const command = process.argv[2] || "doctor";

if (command === "doctor") {
  doctor();
} else if (command === "init") {
  init();
} else if (command === "build") {
  build();
} else {
  fail(`Unknown container command: ${command}`);
}
