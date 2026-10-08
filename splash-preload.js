const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the splash window (#12). The splash runs contextIsolated now,
// so the system checks it used to run itself arrive as one result set from
// main instead.
contextBridge.exposeInMainWorld('ocSplash', {
  // results = [{ check: string, ok: bool, detail: string }]
  onChecks: (callback) => {
    ipcRenderer.on('splash:checks', (event, results) => callback(results));
  },
  loaded: () => ipcRenderer.send('splash-loaded'),
  ready: () => ipcRenderer.send('splash-ready'),
  openInstaller: () => ipcRenderer.send('open-installer'),
  // #33: same 'app-version' handler the main window's ocApp uses, so the
  // splash's version badge stops being a hard-coded constant
  version: () => ipcRenderer.invoke('app-version')
});
