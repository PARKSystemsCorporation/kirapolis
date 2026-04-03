// @ts-nocheck
const electron = require("electron");
const node_child_process_1 = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, shell } = electron;
const repoRoot = path.resolve(__dirname, "../../..");
if (process.env.KIRAPOLIS_USER_DATA_PATH) {
    app.setPath("userData", path.resolve(process.env.KIRAPOLIS_USER_DATA_PATH));
}
const agentEntry = path.join(repoRoot, "services", "agent", "dist", "server.js");
const preloadPath = path.join(__dirname, "preload.cjs");
const htmlPath = path.join(repoRoot, "apps", "desktop", "src", "index.html");
const controlRoot = path.resolve(process.env.KIRAPOLIS_CONTROL_ROOT || repoRoot);
const defaultProjectRoot = path.resolve(process.env.KIRAPOLIS_PROJECT_ROOT || controlRoot);
const agentUrl = "http://127.0.0.1:4317";
const sharedDesktopSettingsPath = () => path.join(controlRoot, "data", "desktop-settings.json");
let mainWindow = null;
let agentProcess = null;
let agentLog = "Starting Kirapolis agent...\n";
function getRemoteUrls() {
    const interfaces = os.networkInterfaces();
    const urls = [];
    for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
            if (!entry || entry.family !== "IPv4" || entry.internal) {
                continue;
            }
            urls.push(`http://${entry.address}:4317/app`);
        }
    }
    return [...new Set(urls)];
}
function getLaunchRoot(settings = loadDesktopSettings()) {
    const candidate = String(settings.websiteProjectPath || "").trim();
    return resolveProjectRoot(candidate || defaultProjectRoot);
}
function describeError(error) {
    if (error && typeof error === "object") {
        const maybeError = error;
        const cause = maybeError.cause && typeof maybeError.cause === "object"
            ? maybeError.cause
            : null;
        const code = String(cause?.code || cause?.errno || maybeError.code || maybeError.errno || "").trim();
        const message = String(cause?.message || maybeError.message || "unknown error").trim();
        return code ? `${code}: ${message}` : message;
    }
    return String(error || "unknown error");
}
async function probeJson(url) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) {
            return { ok: false, detail: `${response.status} ${response.statusText}` };
        }
        return { ok: true, detail: "reachable" };
    }
    catch (error) {
        return { ok: false, detail: describeError(error) };
    }
}
function loadDesktopSettings() {
    try {
        if (fs.existsSync(sharedDesktopSettingsPath())) {
            return JSON.parse(fs.readFileSync(sharedDesktopSettingsPath(), "utf8"));
        }
        return {};
    }
    catch {
        return {};
    }
}
function hasProjectEntrypoint(targetPath) {
    if (!targetPath) {
        return false;
    }
    try {
        const resolved = path.resolve(String(targetPath));
        return ["index.html", "app.js", "styles.css"].some((name) => fs.existsSync(path.join(resolved, name)));
    }
    catch {
        return false;
    }
}
function resolveProjectRoot(candidate) {
    const trimmed = String(candidate || "").trim();
    const attempts = trimmed
        ? [path.resolve(trimmed), path.resolve(trimmed, ".."), path.resolve(trimmed, "..", "..")]
        : [];
    for (const attempt of [...attempts, defaultProjectRoot]) {
        if (hasProjectEntrypoint(attempt)) {
            return attempt;
        }
    }
    return trimmed ? path.resolve(trimmed) : defaultProjectRoot;
}
function saveDesktopSettings(settings) {
    fs.mkdirSync(path.dirname(sharedDesktopSettingsPath()), { recursive: true });
    fs.writeFileSync(sharedDesktopSettingsPath(), JSON.stringify(settings, null, 2), "utf8");
}
function getVscodiumCandidates() {
    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "";
    const userProfile = process.env.USERPROFILE || "";
    const chocolateyInstall = process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey";
    return [
        path.join(localAppData, "Programs", "VSCodium", "VSCodium.exe"),
        path.join(localAppData, "Programs", "VSCodium", "bin", "codium.cmd"),
        path.join(localAppData, "Programs", "VSCodium", "bin", "codium"),
        path.join(localAppData, "Microsoft", "WindowsApps", "VSCodium.exe"),
        path.join(localAppData, "Microsoft", "WindowsApps", "codium.exe"),
        path.join(programFiles, "VSCodium", "VSCodium.exe"),
        path.join(programFiles, "VSCodium", "bin", "codium.cmd"),
        path.join(programFilesX86, "VSCodium", "VSCodium.exe"),
        path.join(programFilesX86, "VSCodium", "bin", "codium.cmd"),
        path.join(userProfile, "scoop", "apps", "vscodium", "current", "VSCodium.exe"),
        path.join(userProfile, "scoop", "shims", "codium.cmd"),
        path.join(chocolateyInstall, "bin", "codium.exe"),
        path.join(chocolateyInstall, "bin", "codium.cmd")
    ].filter(Boolean);
}
function getPathCommandCandidates(command) {
    if (process.platform !== "win32") {
        return [];
    }
    try {
        const output = (0, node_child_process_1.execFileSync)("where.exe", [command], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        });
        return output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
function readRegistryDefault(key) {
    if (process.platform !== "win32") {
        return null;
    }
    try {
        const output = (0, node_child_process_1.execFileSync)("reg.exe", ["query", key, "/ve"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
        });
        const match = output.match(/REG_\w+\s+(.+)$/m);
        return match ? match[1].trim() : null;
    }
    catch {
        return null;
    }
}
function getRegistryCandidates() {
    const keys = [
        "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\VSCodium.exe",
        "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\VSCodium.exe",
        "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\VSCodium.exe"
    ];
    return keys
        .map((key) => readRegistryDefault(key))
        .filter((value) => Boolean(value));
}
function getVscodiumLaunchTargets() {
    const seen = new Set();
    const targets = [];
    const push = (candidate, source) => {
        const normalized = String(candidate || "").trim();
        if (!normalized || seen.has(normalized.toLowerCase())) {
            return;
        }
        seen.add(normalized.toLowerCase());
        targets.push({ path: normalized, source });
    };
    for (const candidate of getVscodiumCandidates()) {
        push(candidate, "standard");
    }
    for (const candidate of getRegistryCandidates()) {
        push(candidate, "registry");
    }
    for (const command of ["codium", "codium.cmd", "codium.exe", "VSCodium.exe"]) {
        for (const candidate of getPathCommandCandidates(command)) {
            push(candidate, "path");
        }
    }
    return targets;
}
function launchDetached(command, args) {
    return new Promise((resolve) => {
        try {
            const child = (0, node_child_process_1.spawn)(command, args, {
                cwd: controlRoot,
                detached: true,
                stdio: "ignore",
                shell: false
            });
            child.on("error", () => resolve(false));
            child.unref();
            resolve(true);
        }
        catch {
            resolve(false);
        }
    });
}
async function openVscodium() {
    const desktopSettings = loadDesktopSettings();
    const launchRoot = getLaunchRoot(desktopSettings);
    if (desktopSettings.vscodiumPath && fs.existsSync(desktopSettings.vscodiumPath)) {
        if (await launchDetached(desktopSettings.vscodiumPath, [launchRoot])) {
            return true;
        }
    }
    for (const target of getVscodiumLaunchTargets()) {
        if ((target.source === "path" || fs.existsSync(target.path)) && await launchDetached(target.path, [launchRoot])) {
            return true;
        }
    }
    if (process.platform === "win32") {
        return await launchDetached("cmd.exe", ["/c", "start", "", "codium", launchRoot]);
    }
    return false;
}
function broadcastAgentLog(chunk) {
    agentLog += chunk;
    mainWindow?.webContents.send("agent-log", agentLog);
}
function startAgent() {
    if (agentProcess) {
        return;
    }
    agentProcess = (0, node_child_process_1.spawn)(process.execPath, [agentEntry], {
        cwd: path.dirname(agentEntry),
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            KIRAPOLIS_CONTROL_ROOT: controlRoot,
            KIRAPOLIS_PROJECT_ROOT: getLaunchRoot()
        }
    });
    agentProcess.stdout?.on("data", (chunk) => {
        broadcastAgentLog(String(chunk));
    });
    agentProcess.stderr?.on("data", (chunk) => {
        broadcastAgentLog(String(chunk));
    });
    agentProcess.on("exit", (code) => {
        broadcastAgentLog(`[desktop] agent exited with code ${code ?? 0}\n`);
        agentProcess = null;
        agentLog = "";
    });
}
function stopAgent() {
    if (!agentProcess) {
        return;
    }
    agentProcess.kill();
    agentProcess = null;
}
function restartAgent() {
    stopAgent();
    startAgent();
}
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1480,
        height: 980,
        minWidth: 1120,
        minHeight: 760,
        backgroundColor: "#0b0f14",
        autoHideMenuBar: true,
        titleBarOverlay: {
            color: "#0b0f14",
            symbolColor: "#f4e8d8",
            height: 34
        },
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    void mainWindow.loadFile(htmlPath);
    mainWindow.webContents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "F12") {
            event.preventDefault();
            if (mainWindow?.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools();
            }
            else {
                mainWindow?.webContents.openDevTools({ mode: "right" });
            }
        }
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}
ipcMain.handle("desktop:get-bootstrap", async () => {
    const desktopSettings = loadDesktopSettings();
    const launchRoot = getLaunchRoot(desktopSettings);
    return {
        workspaceRoot: controlRoot,
        controlRoot,
        websiteProjectPath: launchRoot,
        deployProfile: {
            projectPath: resolveProjectRoot(desktopSettings.deployProjectPath || desktopSettings.websiteProjectPath || launchRoot),
            buildCommand: desktopSettings.deployBuildCommand || "",
            deployCommand: desktopSettings.deployCommand || ""
        },
        agentUrl,
        remoteUrls: getRemoteUrls(),
        agentLog
    };
});
ipcMain.handle("desktop:http", async (_event, input) => {
    try {
        const response = await fetch(`${agentUrl}${input.path}`, {
            method: input.method || "GET",
            headers: {
                "content-type": "application/json"
            },
            body: input.body ? JSON.stringify(input.body) : undefined
        });
        const text = await response.text();
        let data = text;
        try {
            data = JSON.parse(text);
        }
        catch { }
        return {
            ok: response.ok,
            status: response.status,
            data
        };
    }
    catch (error) {
        return {
            ok: false,
            status: 0,
            data: { error: describeError(error) }
        };
    }
});
ipcMain.handle("desktop:open-workspace", async () => {
    const desktopSettings = loadDesktopSettings();
    await shell.openPath(getLaunchRoot(desktopSettings));
    return true;
});
ipcMain.handle("desktop:open-path", async (_event, targetPath) => {
    const resolved = path.resolve(String(targetPath || "").trim() || controlRoot);
    await shell.openPath(resolved);
    return true;
});
ipcMain.handle("desktop:open-url", async (_event, url) => {
    const parsed = String(url || "").trim();
    if (!/^https?:\/\//i.test(parsed)) {
        return false;
    }
    await shell.openExternal(parsed);
    return true;
});
ipcMain.handle("desktop:open-vscodium", async () => {
    return await openVscodium();
});
ipcMain.handle("desktop:get-system-status", async () => {
    const desktopSettings = loadDesktopSettings();
    const launchRoot = getLaunchRoot(desktopSettings);
    const targets = getVscodiumLaunchTargets();
    const autoDetected = targets.find((target) => target.source === "path" || fs.existsSync(target.path)) || null;
    const installedPath = (desktopSettings.vscodiumPath && fs.existsSync(desktopSettings.vscodiumPath)
        ? desktopSettings.vscodiumPath
        : autoDetected?.path) || null;
    const agentProbe = await probeJson(`${agentUrl}/health`);
    const ollamaProbe = await probeJson("http://127.0.0.1:11434/api/version");
    const openClawProbe = await probeJson("http://127.0.0.1:11434/v1/models");
    return {
        agentProcessRunning: Boolean(agentProcess),
        workspaceRoot: controlRoot,
        controlRoot,
        websiteProjectPath: launchRoot,
        agentUrl,
        remoteUrls: getRemoteUrls(),
        probes: {
            backend: {
                ok: agentProbe.ok,
                url: `${agentUrl}/health`,
                detail: agentProbe.detail
            },
            ollama: {
                ok: ollamaProbe.ok,
                url: "http://127.0.0.1:11434/api/version",
                detail: ollamaProbe.detail
            },
            openclaw: {
                ok: openClawProbe.ok,
                url: "http://127.0.0.1:11434/v1/models",
                detail: openClawProbe.detail
            }
        },
        vscodium: {
            installed: Boolean(installedPath),
            configuredPath: desktopSettings.vscodiumPath || null,
            path: installedPath,
            source: desktopSettings.vscodiumPath && fs.existsSync(desktopSettings.vscodiumPath)
                ? "configured"
                : (autoDetected?.source || null),
            commandHint: "codium"
        }
    };
});
ipcMain.handle("desktop:probe-connections", async (_event, input) => {
    const ollamaBaseUrl = input?.ollamaBaseUrl || "http://127.0.0.1:11434";
    const openClawBaseUrl = input?.openClawBaseUrl || "http://127.0.0.1:11434";
    return {
        backend: await probeJson(`${agentUrl}/health`),
        ollama: {
            ...(await probeJson(`${ollamaBaseUrl.replace(/\/$/, "")}/api/version`)),
            url: `${ollamaBaseUrl.replace(/\/$/, "")}/api/version`
        },
        openclaw: {
            ...(await probeJson(`${openClawBaseUrl.replace(/\/$/, "")}/v1/models`)),
            url: `${openClawBaseUrl.replace(/\/$/, "")}/v1/models`
        }
    };
});
ipcMain.handle("desktop:restart-agent", async () => {
    restartAgent();
    return true;
});
ipcMain.handle("desktop:browse-vscodium", async () => {
    const dialogOptions = {
        title: "Choose VSCodium executable",
        properties: ["openFile"],
        filters: [
            { name: "Executable", extensions: ["exe"] },
            { name: "All Files", extensions: ["*"] }
        ]
    };
    const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || !result.filePaths[0]) {
        return null;
    }
    return result.filePaths[0];
});
ipcMain.handle("desktop:browse-folder", async () => {
    const dialogOptions = {
        title: "Choose project folder",
        properties: ["openDirectory"]
    };
    const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || !result.filePaths[0]) {
        return null;
    }
    return result.filePaths[0];
});
ipcMain.handle("desktop:save-desktop-settings", async (_event, input) => {
    const current = loadDesktopSettings();
    const next = {
        ...current,
        vscodiumPath: input.vscodiumPath?.trim() || undefined,
        websiteProjectPath: input.websiteProjectPath?.trim() ? resolveProjectRoot(input.websiteProjectPath.trim()) : undefined,
        deployProjectPath: input.deployProjectPath?.trim() ? resolveProjectRoot(input.deployProjectPath.trim()) : undefined,
        deployBuildCommand: input.deployBuildCommand?.trim() || undefined,
        deployCommand: input.deployCommand?.trim() || undefined
    };
    saveDesktopSettings(next);
    return next;
});
app.whenReady().then(() => {
    startAgent();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
app.on("before-quit", () => {
    stopAgent();
});
