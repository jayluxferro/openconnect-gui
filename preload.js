const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // VPN connection methods
  connectVPN: (config) => ipcRenderer.invoke('connect-vpn', config),
  disconnectVPN: () => ipcRenderer.invoke('disconnect-vpn'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  checkOpenConnect: () => ipcRenderer.invoke('check-openconnect'),

  // Profile management methods
  saveProfiles: (profiles) => ipcRenderer.invoke('save-profiles', profiles),
  loadProfiles: () => ipcRenderer.invoke('load-profiles'),

  // Process management
  checkRunningProcesses: () => ipcRenderer.invoke('check-running-processes'),
  killProcess: (pid, sudoPassword) => ipcRenderer.invoke('kill-process', pid, sudoPassword),

  // Network diagnostics
  getRoutes: () => ipcRenderer.invoke('get-routes'),
  testConnectivity: (host, port) => ipcRenderer.invoke('test-connectivity', host, port),
  deleteRoute: (destination, sudoPassword) => ipcRenderer.invoke('delete-route', destination, sudoPassword),
  getNetworkInterfaces: () => ipcRenderer.invoke('get-network-interfaces'),

  // Event listeners
  onStatusChanged: (callback) => {
    ipcRenderer.on('status-changed', (event, status) => callback(status));
  },
  onLogMessage: (callback) => {
    ipcRenderer.on('log-message', (event, log) => callback(log));
  },
  onConnectionError: (callback) => {
    ipcRenderer.on('connection-error', (event, error) => callback(error));
  },
  // The tray asks the window to load a profile (a tray connect was started
  // on a profile that has no stored password).
  onSelectProfile: (callback) => {
    ipcRenderer.on('select-profile', (event, profileName) => callback(profileName));
  },

  // Updates: manual check, restart-and-install, and the live phase feed
  // the footer indicator subscribes to.
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateState: (callback) => {
    ipcRenderer.on('update-state', (event, state) => callback(state));
  },

  // The tunnel's own address once openconnect reports it (null on
  // disconnect). Split-tunnel VPNs never change the public IP, so this is
  // the address that proves the tunnel is up.
  onTunnelAddress: (callback) => {
    ipcRenderer.on('tunnel-address', (event, address) => callback(address));
  }
});

// #33: the app module only exists in the main process, so the version is
// fetched over IPC instead of a constant hard-coded in the renderer
contextBridge.exposeInMainWorld('ocApp', {
  version: () => ipcRenderer.invoke('app-version')
});
