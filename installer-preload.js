const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the installer helper window (#12). The installer runs
// contextIsolated now, so it reaches the existing ipcMain handlers through
// here instead of ipcRenderer.
contextBridge.exposeInMainWorld('ocInstaller', {
  // -> { success, error? }; brew install streamed to the Logs tab
  install: () => ipcRenderer.invoke('install-openconnect'),
  // -> { installed, path? }; re-check after an external install
  check: () => ipcRenderer.invoke('check-openconnect'),
  openTerminal: () => ipcRenderer.send('open-terminal'),
  // Tell main the install succeeded; it closes this window and reloads main
  installed: () => ipcRenderer.send('openconnect-installed')
});
