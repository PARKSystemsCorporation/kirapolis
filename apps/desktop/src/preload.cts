// @ts-nocheck
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kiraDesktop", {
    getBootstrap: () => ipcRenderer.invoke("desktop:get-bootstrap"),
    getSystemStatus: () => ipcRenderer.invoke("desktop:get-system-status"),
    probeConnections: (input) => ipcRenderer.invoke("desktop:probe-connections", input),
    restartAgent: () => ipcRenderer.invoke("desktop:restart-agent"),
    browseVscodium: () => ipcRenderer.invoke("desktop:browse-vscodium"),
    browseFolder: () => ipcRenderer.invoke("desktop:browse-folder"),
    saveDesktopSettings: (input) => ipcRenderer.invoke("desktop:save-desktop-settings", input),
    http: (input) => ipcRenderer.invoke("desktop:http", input),
    openWorkspace: () => ipcRenderer.invoke("desktop:open-workspace"),
    openPath: (targetPath) => ipcRenderer.invoke("desktop:open-path", targetPath),
    openVscodium: () => ipcRenderer.invoke("desktop:open-vscodium"),
    openUrl: (url) => ipcRenderer.invoke("desktop:open-url", url),
    onAgentLog: (callback) => {
        ipcRenderer.on("agent-log", (_event, value) => callback(value));
    }
});
