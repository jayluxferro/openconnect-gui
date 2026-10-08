const { contextBridge, ipcRenderer } = require('electron');

// Bridge for the sudo password prompt (#12). The prompt window runs
// contextIsolated now, so it submits through here instead of ipcRenderer.
contextBridge.exposeInMainWorld('ocPassword', {
  submit: (pw) => ipcRenderer.send('sudo-password-entered', pw),
  cancel: () => ipcRenderer.send('sudo-password-cancelled')
});
