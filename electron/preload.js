const { contextBridge, ipcRenderer } = require("electron");

// Existing kiosk API (used by display window)
contextBridge.exposeInMainWorld("kiosk", {
  close: () => ipcRenderer.send("kiosk-close"),
  moveMode: () => ipcRenderer.send("kiosk-move-mode"),
  enterFullscreen: () => ipcRenderer.send("kiosk-enter-fullscreen"),
  toggleFullscreen: () => ipcRenderer.send("kiosk-toggle-fullscreen"),
  lockScreen2: () => ipcRenderer.send("kiosk-lock-screen2"),
});

// NEW launcher API (used by launcher.html)
contextBridge.exposeInMainWorld("qsys", {
  openStaff: () => ipcRenderer.send("launcher-open", "staff"),
  openAdmin: () => ipcRenderer.send("launcher-open", "admin"),
  openGuest: () => ipcRenderer.send("launcher-open", "guest"),
  openDisplay: () => ipcRenderer.send("launcher-open", "display"),
});
