const { app, BrowserWindow, ipcMain, Tray, Menu, shell, safeStorage, nativeImage, dialog } = require('electron');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { redactLog } = require('./lib/redact');
const { TRAY_ICON_IDLE, TRAY_ICON_CONNECTED } = require('./lib/tray-icon');
const { buildTrayTemplate, statusLabel } = require('./lib/tray-menu');
const { parseTunnelAddress } = require('./lib/tunnel-address');
const { autoUpdater } = require('electron-updater');
const { createLineLogger } = require('./lib/line-logger');

let mainWindow;
let splashWindow;
let installerWindow;
let tray;
let openconnectProcess = null;
let connectionStatus = 'disconnected';
// Name of the profile behind the current/last connection attempt, so the
// tray can say "Connected to <name>" — display only, never a credential.
let activeProfileName = null;
// The tunnel's own address (openconnect's "Configured as <ip>"), shown in
// the header. On split-tunnel VPNs the public IP never changes, so this is
// the only visible proof the tunnel took an address. Cleared on disconnect.
let tunnelAddress = null;
// Set while the user (or app quit) is intentionally tearing the tunnel down,
// so the child's 130/143 exit code is not surfaced as an error (#38).
let userDisconnectRequested = false;
// Sent once per session if profiles must stay plaintext because the OS
// keychain is unavailable (#6).
let plaintextPasswordWarningSent = false;
// Mirror of the updater's phase for the window footer and the tray:
// 'idle' | 'checking' | 'not-available' | 'downloading' | 'ready' | 'error'
let updateState = { phase: 'idle' };
// True while an update check (automatic or user-requested) is running, so a
// second request returns the in-flight state instead of racing the first.
let updateCheckInFlight = false;
const PROFILES_FILE = path.join(app.getPath('userData'), 'profiles.json');
let systemChecksComplete = false;

// Create splash window
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 600,
    height: 700,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'splash-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });
  denyNavigation(splashWindow);

  // Load the splash screen - in dev mode, load from vite server; in production, load from dist
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    splashWindow.loadURL('http://localhost:5173/pages/splash.html');
  } else {
    splashWindow.loadFile(path.join(__dirname, 'dist', 'pages', 'splash.html'));
  }

  splashWindow.center();

  // Handle splash window events
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

// Perform system checks
// The splash window is contextIsolated now, so it no longer runs or watches
// these checks itself - main runs them and ships the whole result set on one
// channel, and the splash just renders whatever arrives on 'splash:checks'.
async function performSystemChecks() {
  const results = [];

  try {
    // Check 1: Electron runtime
    results.push({
      check: 'Application Runtime',
      ok: true,
      detail: `Electron v${process.versions.electron}`
    });

    // Check 2: File system access
    try {
      const userDataPath = app.getPath('userData');
      if (!fs.existsSync(userDataPath)) {
        fs.mkdirSync(userDataPath, { recursive: true });
      }
      results.push({ check: 'File System Access', ok: true, detail: 'OK' });
    } catch (error) {
      results.push({ check: 'File System Access', ok: false, detail: error.message });
    }

    // Check 3: OpenConnect installation
    const openconnectCheck = await checkOpenConnect();
    results.push({
      check: 'OpenConnect Binary',
      ok: openconnectCheck.installed,
      detail: openconnectCheck.installed
        ? (openconnectCheck.path || 'Found')
        : 'Not installed. Install with: brew install openconnect'
    });

    // Check 4: Expect binary
    const expectCheck = await checkExpect();
    results.push({
      check: 'Expect Binary',
      ok: expectCheck.installed,
      detail: expectCheck.installed
        ? (expectCheck.path || 'Found')
        : 'Not installed. It should be pre-installed on macOS. Try: brew install expect'
    });

    // Check 5: Network capabilities
    results.push({ check: 'Network Capabilities', ok: true, detail: 'Available' });

    // Check 6: Sudo privileges - missing sudo is not fatal, connecting will
    // just prompt for the password later
    const sudoCheck = await checkSudoAccess();
    results.push({
      check: 'Sudo Privileges',
      ok: true,
      detail: sudoCheck.available ? 'User has sudo access' : 'Sudo required - will prompt when connecting'
    });

    // OpenConnect and expect are the two checks the app cannot run without
    systemChecksComplete = openconnectCheck.installed && expectCheck.installed;

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('splash:checks', results);
    }
    return systemChecksComplete;

  } catch (error) {
    console.error('System check error:', error);
    // A partial batch with no failed rows would animate to 100% in the splash
    // and read as success — always mark the batch failed when checks aborted.
    results.push({
      check: 'System Checks',
      ok: false,
      detail: `Checks aborted: ${error.message}`
    });
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.webContents.send('splash:checks', results);
    }
    return false;
  }
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false, // Don't show immediately
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 10 }
  });
  denyNavigation(mainWindow);

  // Load the app - in dev mode, load from vite server; in production, load from dist
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    // Development mode - load from Vite dev server
    mainWindow.loadURL('http://localhost:5173/pages/index.html');
    // Open DevTools in development
    // mainWindow.webContents.openDevTools();
  } else {
    // Production mode - load from built files
    mainWindow.loadFile(path.join(__dirname, 'dist', 'pages', 'index.html'));
  }

  // Prevent window close, minimize to tray instead
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// Create installer helper window
function createInstallerWindow() {
  if (installerWindow) {
    installerWindow.focus();
    return;
  }

  installerWindow = new BrowserWindow({
    width: 700,
    height: 650,
    webPreferences: {
      preload: path.join(__dirname, 'installer-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 10, y: 10 },
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true
  });
  denyNavigation(installerWindow);

  // Load the installer helper - in dev mode, load from vite server; in production, load from dist
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

  if (isDev) {
    installerWindow.loadURL('http://localhost:5173/pages/installer-helper.html');
  } else {
    installerWindow.loadFile(path.join(__dirname, 'dist', 'pages', 'installer-helper.html'));
  }

  installerWindow.on('closed', () => {
    installerWindow = null;
  });
}

// This function is no longer needed - checks are done in splash screen

// Helper function to check OpenConnect
function checkOpenConnect() {
  return new Promise((resolve) => {
    // Check for OpenConnect in multiple locations
    const locations = [
      '/usr/local/bin/openconnect',           // Homebrew (Intel Mac)
      '/opt/homebrew/bin/openconnect',        // Homebrew (Apple Silicon)
      path.join(process.env.HOME, '.local/openconnect/bin/openconnect'), // Standalone install
      path.join(__dirname, 'bin', 'openconnect'), // Bundled with app (dev)
      path.join(process.resourcesPath, 'bin', 'openconnect'), // Bundled with app (production)
    ];

    // Check each location
    for (const location of locations) {
      if (fs.existsSync(location)) {
        resolve({ installed: true, path: location });
        return;
      }
    }

    // Fallback to 'which' command
    const checkProcess = spawn('which', ['openconnect']);
    checkProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ installed: true, path: 'openconnect' });
      } else {
        resolve({ installed: false });
      }
    });
  });
}

// Check if expect is installed
function checkExpect() {
  return new Promise((resolve) => {
    // Check for expect in common locations
    const locations = [
      '/usr/bin/expect',           // Standard macOS location
      '/opt/homebrew/bin/expect',  // Homebrew (Apple Silicon)
      '/usr/local/bin/expect',     // Homebrew (Intel Mac)
    ];

    // Check each location
    for (const location of locations) {
      if (fs.existsSync(location)) {
        resolve({ installed: true, path: location });
        return;
      }
    }

    // Fallback to 'which' command
    const checkProcess = spawn('which', ['expect']);
    checkProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ installed: true, path: 'expect' });
      } else {
        resolve({ installed: false });
      }
    });
  });
}

// Check if user has sudo access
function checkSudoAccess() {
  return new Promise((resolve) => {
    // Check if user is in admin/sudo group
    // Note: This doesn't guarantee they know the password, just that they have potential access
    const checkProcess = spawn('groups');
    let output = '';

    checkProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    checkProcess.on('close', () => {
      // Check if user is in admin or wheel group (common sudo groups on macOS)
      const hasAdminAccess = output.includes('admin') || output.includes('wheel');
      resolve({ available: hasAdminAccess });
    });
  });
}

// Get the OpenConnect binary path
function getOpenConnectPath() {
  return new Promise((resolve) => {
    checkOpenConnect().then(result => {
      resolve(result.path || 'openconnect');
    });
  });
}

// Get the vpnc-script path
function getVpncScriptPath() {
  const locations = [
    '/opt/homebrew/etc/vpnc/vpnc-script',           // Homebrew (Apple Silicon)
    '/usr/local/etc/vpnc/vpnc-script',              // Homebrew (Intel)
    '/opt/homebrew/opt/vpnc-scripts/etc/vpnc/vpnc-script', // Homebrew alternate
    '/usr/local/opt/vpnc-scripts/etc/vpnc/vpnc-script',    // Homebrew alternate
    path.join(process.env.HOME, '.local/openconnect/etc/vpnc/vpnc-script'), // Standalone
  ];

  // Check each location
  for (const location of locations) {
    if (fs.existsSync(location)) {
      return location;
    }
  }

  // Fallback to just 'vpnc-script' and hope it's in PATH
  return 'vpnc-script';
}

// Create system tray
function trayImage(spec) {
  // Template image: monochrome + alpha, so macOS restyles it for light and
  // dark menu bars. x1/x2 are the same padlock at 16 px and 32 px (@2x).
  const image = nativeImage.createFromBuffer(Buffer.from(spec.x1, 'base64'));
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(spec.x2, 'base64'), width: 32, height: 32 });
  image.setTemplateImage(true);
  return image;
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  }
}

function quitFromTray() {
  if (connectionStatus === 'connected') {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Quit and disconnect the VPN?',
      detail: activeProfileName
        ? `The connection to ${activeProfileName} will be closed.`
        : 'The active VPN session will be closed.'
    });
    if (choice !== 0) {
      return;
    }
  }
  app.isQuitting = true;
  app.quit();
}

// Tray-initiated connect: profiles are re-read from disk (the menu snapshot
// can be stale), then go through the same connectVpn path the window uses.
// A profile without a stored password cannot be launched headless — bring
// the window up with that profile selected and let a human type it.
async function connectFromTray(profileName) {
  if (openconnectProcess) {
    sendLog('[TRAY] Already connected or connecting', 'warn');
    return;
  }
  let profiles;
  try {
    profiles = readProfiles();
  } catch (error) {
    sendLog(`[TRAY] Could not read saved profiles: ${error.message}`, 'error');
    return;
  }
  const profile = profiles.find(p => p.name === profileName);
  if (!profile) {
    sendLog(`[TRAY] Profile "${profileName}" no longer exists`, 'warn');
    updateTrayMenu();
    return;
  }
  if (!profile.username || !profile.password) {
    sendLog(`[TRAY] Profile "${profile.name}" has no stored password — finish connecting in the app window`, 'warn');
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('select-profile', profile.name);
    }
    return;
  }
  sendLog(`[TRAY] Connecting to ${profile.name}…`, 'info');
  await connectVpn({ ...profile, profileName: profile.name });
}

function createTray() {
  // A broken icon must not take the app down; the images are embedded
  // buffers, so there is no asset file to lose between clone and package
  try {
    tray = new Tray(trayImage(TRAY_ICON_IDLE));
  } catch (error) {
    tray = null;
    sendLog(`[WARN] Tray icon unavailable: ${error.message}`, 'warn');
    return;
  }

  updateTrayMenu();

  tray.on('click', () => {
    showMainWindow();
  });
}

function updateTrayMenu() {
  // Only update tray if it exists
  if (!tray) {
    return;
  }

  let profiles = [];
  try {
    profiles = readProfiles();
  } catch {
    // Unreadable profile file: the menu offers no profiles; the window
    // still reports the real error when it loads them.
  }

  const state = { status: connectionStatus, activeProfile: activeProfileName, profiles };
  const handlers = {
    'connect-profile': ({ profile }) => connectFromTray(profile),
    disconnect: () => disconnectVPN(),
    show: () => showMainWindow(),
    'check-update': () => checkForUpdatesFromTray(),
    quit: () => quitFromTray()
  };
  // lib/tray-menu builds pure descriptors (action ids); attach the real
  // handlers here and drop the descriptor keys Electron does not know.
  const wire = (items) => items.map(({ action, profile, ...item }) => {
    if (item.submenu) {
      item.submenu = wire(item.submenu);
    }
    if (action) {
      const run = handlers[action];
      item.click = () => run({ action, profile });
    }
    return item;
  });

  tray.setContextMenu(Menu.buildFromTemplate(wire(buildTrayTemplate(state))));
  tray.setToolTip(`OpenConnect VPN — ${statusLabel(state)}`);
  try {
    tray.setImage(trayImage(connectionStatus === 'connected' ? TRAY_ICON_CONNECTED : TRAY_ICON_IDLE));
  } catch (error) {
    sendLog(`[WARN] Tray icon update failed: ${error.message}`, 'warn');
  }
}

// Handle VPN connection
ipcMain.handle('connect-vpn', async (event, config) => connectVpn(config));

// Shared by the window's Connect button and the tray menu. config carries
// server/username/password (+ optional authgroup/protocol/serverCert) and a
// profileName that is display-only ("Connected to <name>" in the tray).
async function connectVpn(config) {
  if (openconnectProcess) {
    return { success: false, error: 'Already connected or connecting' };
  }

  try {
    activeProfileName = config.profileName || null;
    updateStatus('connecting');
    userDisconnectRequested = false;

    // Get OpenConnect binary path
    const openconnectPath = await getOpenConnectPath();

    // Get vpnc-script path (optional)
    const vpncScriptPath = getVpncScriptPath();

    // Build openconnect command arguments
    const args = [];

    // Only add vpnc-script if found (to match working manual command)
    if (vpncScriptPath && vpncScriptPath !== 'vpnc-script') {
      args.push('-s', vpncScriptPath);
    }

    // Don't add --user flag - let server prompt for it interactively
    // (Server ignores --user and prompts anyway)

    // Add protocol (default is anyconnect)
    const protocol = config.protocol || 'anyconnect';
    args.push(`--protocol=${protocol}`);

    // Add server (keep https:// if present, add it if not)
    let serverUrl = config.server;
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      serverUrl = `https://${serverUrl}`;
    }
    args.push(`--server=${serverUrl}`);

    // Add server certificate pinning if specified
    if (config.serverCert) {
      args.push('--servercert', config.serverCert);
    }

    if (config.authgroup) {
      args.push(`--authgroup=${config.authgroup}`);
    }

    // Add stability and reconnection options
    args.push('--reconnect-timeout', '60'); // Try to reconnect for 60 seconds
    args.push('--dtls-ciphers', 'DEFAULT'); // Use default DTLS ciphers
    // No --verbose: it prints HTTP headers, including session cookies (#37).

    // Log the command being executed (without password)
    sendLog(`Executing: sudo openconnect ${args.join(' ')}`, 'info');

    // Request sudo password from user
    sendLog('[DEBUG] Prompting for sudo password...', 'info');
    const sudoPassword = await promptForSudoPassword();
    if (!sudoPassword) {
      sendLog('[ERROR] No sudo password provided by user', 'error');
      updateStatus('disconnected');
      return { success: false, error: 'Sudo password required' };
    }
    sendLog('[DEBUG] Sudo password received', 'info');

    // Use expect script for proper PTY handling
    // In production, it's in extraResources; in dev, it's in project root
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    const expectScriptPath = isDev
      ? path.join(__dirname, 'vpn-connect.exp')
      : path.join(process.resourcesPath, 'vpn-connect.exp');

    // #4: argv carries only the script, the binary and openconnect flags -
    // never credentials. Anything on argv is readable by any local user via
    // `ps`; the credentials go to the script's stdin instead, one
    // percent-encoded line each (see below).
    const expectArgs = [
      expectScriptPath,
      openconnectPath,
      ...args
    ];

    sendLog('[DEBUG] Using expect script for interactive authentication', 'info');
    sendLog(`[DEBUG] Expect script path: ${expectScriptPath}`, 'info');

    // Validate and encode everything the stdin handshake will need BEFORE
    // spawning: a value that throws mid-handshake (lone surrogates make
    // encodeURIComponent throw) would strand the already-spawned child
    // blocked in `gets`, with openconnectProcess still set and every later
    // connect refused until restart.
    if (typeof config.username !== 'string' || typeof config.password !== 'string') {
      updateStatus('disconnected');
      return { success: false, error: 'Username and password are required' };
    }
    const encodedCredentials = [
      sudoPassword,
      config.username.trim(),
      config.password.trim()
    ].map((value) => encodeURIComponent(value));
    const sudoPromptNonce = crypto.randomBytes(16).toString('hex');

    const sudoProcess = spawn('expect', expectArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    openconnectProcess = sudoProcess;

    // EPIPE here (child died before consuming the handshake) needs no
    // handling: the close handler below owns failure reporting. Registered
    // so the stream can never emit an unhandled 'error'.
    sudoProcess.stdin.on('error', () => {});

    // Track connection status
    let connected = false;
    let authError = false;

    // Log whole lines only, so redaction never sees a secret cut in half
    // (#37) and the tunnel-address parser never sees half a line. Status
    // checks below still read each raw chunk.
    const onConnectionLine = (text) => {
      // Raw line first, then any derived note, so the Logs tab reads in
      // the order things happened instead of the note preceding its cause.
      sendLog(text);
      const address = parseTunnelAddress(text);
      if (address && address !== tunnelAddress) {
        tunnelAddress = address;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tunnel-address', address);
        }
        sendLog(`Tunnel address: ${address}`, 'info');
      }
    };
    const stdoutLog = createLineLogger(onConnectionLine);
    const stderrLog = createLineLogger(onConnectionLine);

    // Handle stdout
    sudoProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdoutLog.write(output);

      if ((output.includes('CONNECTED') || output.includes('Established') || output.includes('Configured as')) && !connected) {
        connected = true;
        updateStatus('connected');
        sendLog('Connection established successfully!', 'info');
      }
    });

    // Handle stderr - this is where OpenConnect output appears
    sudoProcess.stderr.on('data', (data) => {
      const output = data.toString();
      stderrLog.write(output);

      // Check for sudo password errors
      if (output.includes('[EXPECT ERROR] Incorrect sudo password')) {
        authError = true;
        sendLog('[ERROR] Sudo password authentication failed!', 'error');
      }

      // Check for VPN authentication errors
      if (output.includes('[EXPECT ERROR] VPN authentication failed')) {
        authError = true;
        sendLog('[ERROR] VPN credentials are incorrect!', 'error');
      }

      // Check for timeout errors
      if (output.includes('[EXPECT ERROR] Timeout')) {
        authError = true;
        sendLog('[ERROR] Connection timeout occurred', 'error');
      }

      // #9: the expect script reports every failure on stderr under this
      // marker. Catch anything beyond the known messages above so it still
      // reaches the same error path instead of scrolling by as ordinary log.
      if (output.includes('[EXPECT ERROR]')) {
        authError = true;
      }

      if ((output.includes('CONNECTED') || output.includes('Established') || output.includes('Configured as')) && !connected) {
        connected = true;
        updateStatus('connected');
        sendLog('Connection established successfully!', 'info');
      }

      // Ignore vpnc-script errors (connection still works)
      if (output.includes('is not a recognized network service') || output.includes('Error: The parameters were not valid')) {
        sendLog('Note: Route configuration had errors but VPN tunnel is established', 'info');
      }
    });

    // Handle process exit
    sudoProcess.on('close', (code) => {
      stdoutLog.flush();
      stderrLog.flush();
      const exitTime = new Date().toLocaleTimeString();
      sendLog(`[DEBUG] OpenConnect process exited with code ${code} at ${exitTime}`);

      openconnectProcess = null;

      // #38: when the user asked for the disconnect, expect reports the
      // interrupted child as 130 (SIGINT) or 143 (SIGTERM). That is the
      // disconnect working, not a failure - report it as a plain one.
      if (userDisconnectRequested) {
        userDisconnectRequested = false;
        sendLog('Disconnected', 'info');
        updateStatus('disconnected');
        return;
      }

      updateStatus('disconnected');

      if (code !== 0 && code !== null) {
        let errorMessage = `Connection closed with exit code ${code}`;

        // Provide specific error messages based on context
        if (authError) {
          if (code === 1) {
            errorMessage = 'Authentication failed. Please check your credentials.';
          }
        } else if (code === 1) {
          errorMessage = 'Connection failed. This may be due to incorrect sudo password or network issues.';
        }

        sendLog(`[ERROR] ${errorMessage}`, 'error');

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('connection-error', errorMessage);
        }
      } else if (code === 0 && connected) {
        // Clean exit while connected - this is unexpected
        sendLog(`[WARNING] VPN disconnected cleanly. This may be due to:`, 'error');
        sendLog(`  - Network interruption or timeout`, 'error');
        sendLog(`  - Server-side disconnect (idle timeout, policy, etc.)`, 'error');
        sendLog(`  - MTU/DTLS issues`, 'error');

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(
            'connection-error',
            'VPN disconnected — network interruption, idle timeout, or server policy ended the session. Details are in the Logs tab.'
          );
        }
      }
    });

    sudoProcess.on('error', (error) => {
      sendLog(`Error: ${error.message}`, 'error');
      openconnectProcess = null;
      updateStatus('disconnected');
      // #9: raw spawn errors ("spawn expect ENOENT") read like internals. The
      // spawned binary is `expect`, a macOS system tool at /usr/bin/expect —
      // its absence is a system problem, not a broken app bundle, so name it
      // and its fix instead of sending the user to reinstall the app.
      const friendly =
        error.code === 'ENOENT'
          ? 'Could not start the connection helper (expect) — a macOS system tool normally at /usr/bin/expect. If it is missing, install it with: brew install expect'
          : redactLog(error.message);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('connection-error', friendly);
      }
    });

    // #4: hand the credentials to the expect script on stdin, one line each,
    // in this exact order (the script reads them with `gets` before spawning
    // sudo). Encoding happened before the spawn, so a value can never contain
    // a newline: one write is always exactly one protocol line. Line 4 is
    // not a credential: the one-time nonce baked into sudo's -p prompt, so
    // only sudo's own prompt is ever answered with the macOS password (#36).
    // A hostile VPN server cannot see the nonce, so its Password: prompts
    // can only ever be answered with the VPN password. The pipe can break
    // mid-handshake if the child died instantly; a write would then throw
    // with the child still registered as the live connection - clean up
    // instead of wedging the app.
    try {
      for (const line of [...encodedCredentials, sudoPromptNonce]) {
        sudoProcess.stdin.write(line + '\n');
      }
      sudoProcess.stdin.end();
    } catch (error) {
      sudoProcess.kill();
      openconnectProcess = null;
      updateStatus('disconnected');
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    // Never leave a half-started child registered: it would wedge every
    // later connect attempt ("Already connected or connecting") and orphan
    // the expect process until the app quits.
    if (openconnectProcess) {
      try { openconnectProcess.kill(); } catch { /* already gone */ }
      openconnectProcess = null;
    }
    updateStatus('disconnected');
    return { success: false, error: error.message };
  }
}

// Handle VPN disconnection
ipcMain.handle('disconnect-vpn', async () => {
  return disconnectVPN();
});

function disconnectVPN() {
  if (openconnectProcess) {
    sendLog('Disconnecting...');
    userDisconnectRequested = true;

    // Stdin is already closed since the credential handshake (#4), so the
    // signals below are what actually stops the tunnel
    try {
      openconnectProcess.stdin.end();
    } catch (e) {
      // Ignore errors if stdin already closed
    }

    // Send SIGINT for graceful shutdown
    openconnectProcess.kill('SIGINT');

    // Give it 5 seconds to shut down gracefully, then force kill
    setTimeout(() => {
      if (openconnectProcess) {
        sendLog('Force killing OpenConnect process...');
        openconnectProcess.kill('SIGKILL');
        openconnectProcess = null;
        updateStatus('disconnected');
      }
    }, 5000);

    return { success: true };
  }
  return { success: false, error: 'Not connected' };
}

// Get connection status
ipcMain.handle('get-status', async () => {
  return connectionStatus;
});

// The tunnel address is pushed on change only, so a renderer that reloads
// mid-session (e.g. after an in-app openconnect install) would never see
// the current one — pull it on mount, exactly like the status.
ipcMain.handle('get-tunnel-address', async () => {
  return tunnelAddress;
});

// #33: app is main-process-only in Electron, so the renderer asks for the
// version over IPC instead of reading it from a hard-coded constant
ipcMain.handle('app-version', async () => {
  return app.getVersion();
});

// #6: profiles holding a VPN password must never hit disk as plaintext when
// the OS keychain is available. Encrypt on save, decrypt back only in memory.

// Reported to the renderer so the UI states how passwords are actually stored
// instead of a hard-coded (and, since #6, false) "stored in plaintext" claim.
function passwordStorageMode() {
  return safeStorage.isEncryptionAvailable() ? 'encrypted' : 'unavailable';
}

function encryptProfileForStorage(profile) {
  const stored = { ...profile };
  if (stored.password) {
    if (safeStorage.isEncryptionAvailable()) {
      stored.passwordEnc = safeStorage.encryptString(stored.password).toString('base64');
      delete stored.password;
    } else if (!plaintextPasswordWarningSent) {
      plaintextPasswordWarningSent = true;
      sendLog('[WARNING] Passwords stored unencrypted — Keychain unavailable', 'error');
    }
  }
  return stored;
}

function decryptLoadedProfile(profile) {
  const loaded = { ...profile };
  if (loaded.passwordEnc) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        loaded.password = safeStorage.decryptString(Buffer.from(loaded.passwordEnc, 'base64'));
      } catch (error) {
        // Wrong keychain entry or corrupt ciphertext - drop it rather than
        // hand the renderer something useless; the user re-enters the password
        sendLog(`[WARNING] Could not decrypt stored profile password: ${error.message}`, 'error');
      }
    } else if (!plaintextPasswordWarningSent) {
      // The stored password exists but cannot be unlocked right now; say so
      // instead of silently showing an empty password field.
      plaintextPasswordWarningSent = true;
      sendLog('[WARNING] Stored profile password unavailable — Keychain locked or unavailable; re-enter it when connecting', 'error');
    }
    delete loaded.passwordEnc;
  }
  return loaded;
}

// #6: write through a temp file + rename so a crash mid-write can never
// leave a truncated profiles file behind (or, during the plaintext->
// ciphertext migration, a half-migrated one).
function writeProfilesFile(profiles) {
  const tmpFile = `${PROFILES_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(profiles, null, 2));
  fs.renameSync(tmpFile, PROFILES_FILE);
}

// Save profiles
ipcMain.handle('save-profiles', async (event, profiles) => {
  try {
    const storedProfiles = profiles.map(encryptProfileForStorage);
    writeProfilesFile(storedProfiles);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Load profiles
// Reads (and decrypts) the saved profiles. Also used by the tray menu,
// which needs the profile list outside any renderer call. Throws on a
// corrupt file; callers decide how to report that.
function readProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) {
    return [];
  }
  const data = fs.readFileSync(PROFILES_FILE, 'utf8');
  const stored = JSON.parse(data);

  // One-time migration: a file written before #6 still holds plaintext
  // passwords. Detect them on the STORED form. Testing the decrypted
  // profiles instead made this true on every read — each one re-encrypted,
  // rewrote the file, and logged the migration again (twice at startup once
  // the tray began reading profiles, and on every status change).
  // Success stays silent: the UI already states the storage mode on every
  // load (passwordStorageMode -> ConnectionForm), so announcing the
  // migration would re-tell the user something the app tells them
  // continuously. Only failure is worth a line — plaintext persisted.
  if (stored.some(profile => profile.password) && safeStorage.isEncryptionAvailable()) {
    try {
      writeProfilesFile(stored.map(encryptProfileForStorage));
    } catch (error) {
      sendLog(`[WARNING] Could not migrate profiles to encrypted storage: ${error.message}`, 'error');
    }
  }
  return stored.map(decryptLoadedProfile);
}

ipcMain.handle('load-profiles', async () => {
  try {
    return { success: true, profiles: readProfiles(), passwordStorage: passwordStorageMode() };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Check if openconnect is installed
ipcMain.handle('check-openconnect', async () => {
  return checkOpenConnect();
});

// Check for running openconnect processes
ipcMain.handle('check-running-processes', async () => {
  return new Promise((resolve) => {
    // Look for actual openconnect VPN processes, not the GUI app
    exec('ps aux | grep -E "sudo.*openconnect|/usr.*openconnect|/opt.*openconnect" | grep -v grep | grep -v "openconnect-gui"', (error, stdout, stderr) => {
      if (error && error.code !== 1) {
        // Code 1 means no processes found, which is not an error
        resolve({ success: false, error: stderr || error.message, processes: [] });
        return;
      }

      const processes = stdout.trim().split('\n').filter(line => line.length > 0);
      resolve({
        success: true,
        processes: processes,
        count: processes.length
      });
    });
  });
});

// Kill a process by PID
ipcMain.handle('kill-process', async (event, pid, sudoPassword) => {
  return new Promise((resolve) => {
    if (!pid) {
      resolve({ success: false, error: 'PID is required' });
      return;
    }

    // Validate PID is a positive integer (prevent command injection)
    const pidNumber = parseInt(pid, 10);
    if (!Number.isInteger(pidNumber) || pidNumber <= 0 || pidNumber.toString() !== pid.toString()) {
      resolve({ success: false, error: 'Invalid PID format' });
      return;
    }

    if (!sudoPassword) {
      resolve({
        success: false,
        error: 'Sudo password required to kill processes',
        needsSudo: true
      });
      return;
    }

    // Use spawn with sudo -S to pass password via stdin
    // PID is validated as integer, safe to use in command
    const sudoProcess = spawn('sudo', ['-S', 'kill', '-9', pidNumber.toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    sudoProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    sudoProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    sudoProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: `Process ${pid} killed successfully` });
      } else {
        // Check for common error messages
        if (stderr.includes('Sorry, try again') || stderr.includes('incorrect password')) {
          resolve({
            success: false,
            error: 'Incorrect sudo password',
            incorrectPassword: true
          });
        } else if (stderr.includes('No such process')) {
          resolve({
            success: false,
            error: `Process ${pid} not found or already terminated`
          });
        } else {
          resolve({
            success: false,
            error: stderr || `Failed to kill process with exit code ${code}`
          });
        }
      }
    });

    sudoProcess.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });

    // Send password to sudo
    sudoProcess.stdin.write(sudoPassword + '\n');
    sudoProcess.stdin.end();
  });
});

// Locate the brew binary, checking the usual install roots before falling
// back to PATH (a GUI app's PATH often misses /opt/homebrew/bin entirely)
function findBrew() {
  return new Promise((resolve) => {
    const locations = [
      '/opt/homebrew/bin/brew',   // Homebrew (Apple Silicon)
      '/usr/local/bin/brew',      // Homebrew (Intel Mac)
    ];

    for (const location of locations) {
      if (fs.existsSync(location)) {
        resolve(location);
        return;
      }
    }

    const checkProcess = spawn('which', ['brew']);
    checkProcess.on('close', (code) => {
      resolve(code === 0 ? 'brew' : null);
    });
  });
}

// Install OpenConnect. With Homebrew present this runs `brew install` in-app
// and streams its output to the Logs tab; without it, fall back to opening
// Terminal so brew's own installer can prompt for the sudo password it needs.
ipcMain.handle('install-openconnect', async () => {
  const brewPath = await findBrew();

  if (brewPath) {
    return new Promise((resolve) => {
      sendLog('Installing OpenConnect via Homebrew...', 'info');

      const brewProcess = spawn(brewPath, ['install', 'openconnect'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // brew writes progress to both streams; log whole lines only, so the
      // redaction never sees a secret cut in half
      const stdoutLog = createLineLogger((text) => sendLog(text));
      const stderrLog = createLineLogger((text) => sendLog(text));

      brewProcess.stdout.on('data', (data) => {
        stdoutLog.write(data.toString());
      });

      brewProcess.stderr.on('data', (data) => {
        stderrLog.write(data.toString());
      });

      brewProcess.on('error', (error) => {
        stdoutLog.flush();
        stderrLog.flush();
        resolve({ success: false, error: error.message });
      });

      brewProcess.on('close', (code) => {
        stdoutLog.flush();
        stderrLog.flush();
        if (code === 0) {
          sendLog('OpenConnect installed successfully!', 'info');
          resolve({ success: true });
        } else {
          sendLog(`[ERROR] brew install openconnect failed with exit code ${code}`, 'error');
          resolve({ success: false, error: `brew install openconnect exited with code ${code}` });
        }
      });
    });
  }

  // #30: in a packaged app __dirname is inside the asar archive, which bash
  // cannot execute from - always resolve bundled scripts against resourcesPath
  const baseDir = app.isPackaged ? process.resourcesPath : __dirname;
  const scriptPath = path.join(baseDir, 'scripts', 'install-brew.sh');

  if (!fs.existsSync(scriptPath)) {
    return { success: false, error: 'Installation script not found' };
  }

  // Open Terminal and run the script
  const command = `osascript -e 'tell application "Terminal" to do script "bash \\"${scriptPath}\\"; exit"'`;

  return new Promise((resolve) => {
    exec(command, (error) => {
      if (error) {
        resolve({ success: false, error: error.message });
      } else {
        resolve({ success: true });
      }
    });
  });
});

// Open Terminal
ipcMain.on('open-terminal', () => {
  shell.openPath('/System/Applications/Utilities/Terminal.app');
});

// Network diagnostics: Get routing table
ipcMain.handle('get-routes', async () => {
  return new Promise((resolve) => {
    exec('netstat -rn', (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
        return;
      }

      // Parse routing table
      const lines = stdout.split('\n');
      const routes = [];
      let inInternetSection = false;

      for (const line of lines) {
        if (line.includes('Internet:')) {
          inInternetSection = true;
          continue;
        }
        if (line.includes('Internet6:')) {
          inInternetSection = false;
          break;
        }
        if (inInternetSection && line.trim() && !line.includes('Destination')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4) {
            routes.push({
              destination: parts[0],
              gateway: parts[1],
              flags: parts[2],
              interface: parts[3]
            });
          }
        }
      }

      resolve({ success: true, routes });
    });
  });
});

// Network diagnostics: Test connectivity to a host
ipcMain.handle('test-connectivity', async (event, host, port) => {
  return new Promise((resolve) => {
    if (!host || !port) {
      resolve({ success: false, error: 'Host and port are required' });
      return;
    }

    // Validate port is a number between 1-65535
    const portNumber = parseInt(port, 10);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      resolve({ success: false, error: 'Invalid port number' });
      return;
    }

    // Validate host format (basic hostname/IP validation). Must not start
    // with '-': the host is passed as its own argv element, and a leading
    // dash would let a crafted host pose as an nc option. ':' may still lead
    // for IPv6 literals (::1).
    const validHostPattern = /^[a-zA-Z0-9:][a-zA-Z0-9.\-:]*$/;
    if (!validHostPattern.test(host)) {
      resolve({ success: false, error: 'Invalid host format' });
      return;
    }

    const timeout = 5000;
    // Use spawn instead of exec to prevent command injection
    const ncProcess = spawn('nc', ['-zv', '-G', '5', host, portNumber.toString()], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    ncProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ncProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ncProcess.on('close', (code) => {
      const output = stdout + stderr;
      const success = code === 0 && (output.includes('succeeded') || output.includes('open'));

      resolve({
        success,
        host,
        port: portNumber,
        message: output.trim(),
        reachable: success
      });
    });

    ncProcess.on('error', (error) => {
      resolve({
        success: false,
        host,
        port: portNumber,
        message: error.message,
        reachable: false
      });
    });

    // Set timeout
    setTimeout(() => {
      if (!ncProcess.killed) {
        ncProcess.kill();
        resolve({
          success: false,
          host,
          port: portNumber,
          message: 'Connection timed out',
          reachable: false
        });
      }
    }, timeout);
  });
});

// Network diagnostics: Delete a route
ipcMain.handle('delete-route', async (event, destination, sudoPassword) => {
  return new Promise((resolve) => {
    if (!destination) {
      resolve({ success: false, error: 'Destination is required' });
      return;
    }

    // Validate destination format to prevent command injection
    // Allow: IP addresses, CIDR notation, or "default"
    const validDestinationPattern = /^(default|(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?)$/;
    if (!validDestinationPattern.test(destination)) {
      resolve({ success: false, error: 'Invalid destination format' });
      return;
    }

    if (!sudoPassword) {
      resolve({
        success: false,
        error: 'Sudo password required',
        needsSudo: true
      });
      return;
    }

    // Use spawn with sudo -S to pass password via stdin
    // Destination is validated, safe to use in command
    const sudoProcess = spawn('sudo', ['-S', 'route', 'delete', destination], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    sudoProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    sudoProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    sudoProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, message: `Route to ${destination} deleted` });
      } else {
        // Check for common error messages
        if (stderr.includes('Sorry, try again') || stderr.includes('incorrect password')) {
          resolve({
            success: false,
            error: 'Incorrect sudo password',
            incorrectPassword: true
          });
        } else {
          resolve({
            success: false,
            error: stderr || `Failed with exit code ${code}`
          });
        }
      }
    });

    sudoProcess.on('error', (error) => {
      resolve({ success: false, error: error.message });
    });

    // Send password to sudo
    sudoProcess.stdin.write(sudoPassword + '\n');
    sudoProcess.stdin.end();
  });
});

// Network diagnostics: Get network interfaces
ipcMain.handle('get-network-interfaces', async () => {
  return new Promise((resolve) => {
    exec('ifconfig', (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, error: stderr || error.message });
        return;
      }

      // Parse interfaces - simplified version
      const interfaces = [];
      const sections = stdout.split(/\n(?=[a-z])/);

      for (const section of sections) {
        const lines = section.split('\n');
        const firstLine = lines[0];
        if (!firstLine) continue;

        const nameMatch = firstLine.match(/^([a-z0-9]+):/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        const statusMatch = section.match(/status: (\w+)/);
        const inetMatch = section.match(/inet (\d+\.\d+\.\d+\.\d+)/);

        if (inetMatch || statusMatch) {
          interfaces.push({
            name,
            status: statusMatch ? statusMatch[1] : 'unknown',
            ip: inetMatch ? inetMatch[1] : null
          });
        }
      }

      resolve({ success: true, interfaces });
    });
  });
});

// Handle successful OpenConnect installation
ipcMain.on('openconnect-installed', () => {
  if (installerWindow) {
    installerWindow.close();
  }
  // Refresh the main window to re-check OpenConnect
  if (mainWindow) {
    mainWindow.reload();
  }
});

// Splash screen IPC handlers
ipcMain.on('splash-loaded', async () => {
  // Wait a bit for splash to render, then start system checks
  setTimeout(async () => {
    const checksPass = await performSystemChecks();

    if (!checksPass) {
      // System checks failed, keep splash open
      return;
    }
  }, 500);
});

ipcMain.on('splash-ready', () => {
  // System checks passed, create and show main window
  createWindow();

  // Close splash after a short delay
  setTimeout(() => {
    if (splashWindow) {
      splashWindow.close();
    }
  }, 300);

  // Show main window when ready
  if (mainWindow) {
    mainWindow.once('ready-to-show', () => {
      mainWindow.show();

      // Create tray after main window is shown
      try {
        if (!tray) {
          createTray();
        }
      } catch (error) {
        console.log('Tray icon not found, skipping tray creation');
      }
    });
  }
});

ipcMain.on('open-installer', () => {
  createInstallerWindow();
});

// Helper functions
function updateStatus(status) {
  connectionStatus = status;
  if (status === 'disconnected') {
    activeProfileName = null;
    // Retire the tunnel address with the tunnel — a stale address from the
    // previous session must not survive into the next one's header.
    if (tunnelAddress !== null) {
      tunnelAddress = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tunnel-address', null);
      }
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-changed', status);
  }
  updateTrayMenu();
}

function sendLog(message, type = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-message', { message: redactLog(message), type, timestamp: new Date().toISOString() });
  }
}

// #12, defense in depth: every window loads bundled content only. Nothing
// legitimate ever navigates away or opens popups, and a renderer that did
// would re-run its preload (and its full IPC surface) against
// attacker-controlled origin content.
function denyNavigation(window) {
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

async function promptForSudoPassword() {
  return new Promise((resolve) => {
    // Create a simple dialog to get sudo password
    sendLog('[DEBUG] Creating sudo password prompt window...', 'info');

    const promptWindow = new BrowserWindow({
      width: 520,
      height: 400,
      parent: mainWindow,
      modal: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'password-preload.js'),
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    denyNavigation(promptWindow);

    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

    if (isDev) {
      promptWindow.loadURL('http://localhost:5173/pages/password-prompt.html');
    } else {
      promptWindow.loadFile(path.join(__dirname, 'dist', 'pages', 'password-prompt.html'));
    }

    // Answer only events from this prompt's own renderer, and unregister the
    // handlers when the window goes away, so no handler can outlive its
    // prompt regardless of how it ended (OK, cancel, or window close).
    const onPasswordEntered = (event, password) => {
      if (!promptWindow || promptWindow.isDestroyed() || event.sender !== promptWindow.webContents) {
        return;
      }
      sendLog('[DEBUG] Sudo password entered by user', 'info');
      promptWindow.close();
      resolve(password);
    };

    const onPasswordCancelled = (event) => {
      if (!promptWindow || promptWindow.isDestroyed() || event.sender !== promptWindow.webContents) {
        return;
      }
      sendLog('[DEBUG] Sudo password prompt cancelled by user', 'info');
      promptWindow.close();
      // Cancel means "no password", exactly like closing the window
      resolve(null);
    };

    ipcMain.once('sudo-password-entered', onPasswordEntered);
    ipcMain.once('sudo-password-cancelled', onPasswordCancelled);

    promptWindow.on('closed', () => {
      sendLog('[DEBUG] Sudo password prompt window closed', 'info');
      ipcMain.removeListener('sudo-password-entered', onPasswordEntered);
      ipcMain.removeListener('sudo-password-cancelled', onPasswordCancelled);
      // If window was closed without entering password, resolve with null
      resolve(null);
    });

    promptWindow.once('ready-to-show', () => {
      sendLog('[DEBUG] Sudo password prompt ready to show', 'info');
      promptWindow.show();
    });

    // Fallback: show after a short delay if ready-to-show doesn't fire
    setTimeout(() => {
      if (promptWindow && !promptWindow.isDestroyed() && !promptWindow.isVisible()) {
        sendLog('[DEBUG] Showing sudo password prompt (fallback)', 'info');
        promptWindow.show();
      }
    }, 100);
  });
}

// Auto-update (fork feature, deliberately not part of the upstream PR): the
// app checks this fork's GitHub releases over HTTPS, downloads silently, and
// offers a restart when the update is ready. electron-updater refuses an
// update whose Developer ID signature does not match the running app
// (verifyUpdateCodeSignature stays at its secure default), so a compromised
// release channel still cannot push different-signed code.
function setupAutoUpdate() {
  if (!app.isPackaged) {
    return; // dev builds have no update feed; stay quiet about it
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Mirror to stdout as well as the Logs tab: sendLog only delivers while the
  // main window is alive, but update problems are exactly what you want in a
  // terminal capture when debugging a packaged build.
  autoUpdater.logger = {
    info: (message) => { console.log(`[update] ${message}`); sendLog(String(message), 'info'); },
    warn: (message) => { console.warn(`[update] ${message}`); sendLog(String(message), 'warn'); },
    error: (message) => { console.error(`[update] ${message}`); sendLog(String(message), 'error'); },
  };

  // Every phase transition is mirrored to the window footer (and remembered
  // for the tray path) so a manual check can show live progress instead of
  // a single answer. Without a window the states still converge on the
  // restart dialog below.
  autoUpdater.on('checking-for-update', () => {
    sendUpdateState({ phase: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    // autoDownload is on, so availability immediately means downloading.
    sendUpdateState({ phase: 'downloading', version: info.version, progress: null });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateState({ phase: 'not-available', version: app.getVersion() });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateState({ phase: 'downloading', progress: Math.round(progress.percent) });
  });
  autoUpdater.on('error', (error) => {
    sendUpdateState({ phase: 'error', message: error.message });
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateState({ phase: 'ready', version: info.version });
    sendLog(`Update ${info.version} downloaded — install on restart`, 'info');
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `Version ${info.version} is downloaded and ready to install.`,
        detail:
          connectionStatus === 'connected'
            ? 'Restarting will disconnect the active VPN session. It also installs automatically when you quit.'
            : 'Restart now to switch to it, or it installs automatically when you quit.',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      })
      .catch(() => {}); // window teardown races must not surface as errors
  });

  // Delayed so the check never competes with splash/window load
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Offline, rate-limited, or feed missing: logged via the logger above;
      // never fatal — the app is fully usable without updates.
    });
  }, 10000);
}

// Publishes a new updater phase to the window footer and remembers it for
// later readers (the tray path, or a window opened after the transition).
function sendUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-state', updateState);
  }
}

// Runs an update check on demand. Works in dev builds too — it answers
// 'unavailable' instead of pretending to check, since dev builds have no
// update feed (setupAutoUpdate skips them entirely).
async function checkForUpdatesFromUI() {
  if (!app.isPackaged) {
    return { phase: 'unavailable', message: 'Updates are checked in the installed app, not dev builds.' };
  }
  if (updateCheckInFlight) {
    return updateState;
  }
  updateCheckInFlight = true;
  try {
    // Progress and outcome arrive as events while this resolves; the state
    // they produce outlives the await, so it is also a fine return value.
    await autoUpdater.checkForUpdates();
  } catch (error) {
    // Offline, rate-limited, or feed missing — the footer should say so,
    // not stay stuck on "Checking…".
    sendUpdateState({ phase: 'error', message: error.message });
  } finally {
    updateCheckInFlight = false;
  }
  return updateState;
}

// The tray variant answers terminal outcomes with a dialog: the user picked
// the menu item, so silence reads as "the click did nothing". A download in
// progress announces itself through the footer and, when it completes, the
// restart dialog — no extra popup needed.
async function checkForUpdatesFromTray() {
  const result = await checkForUpdatesFromUI();
  if (result.phase === 'not-available') {
    dialog.showMessageBox({
      type: 'info',
      title: 'OpenConnect VPN',
      message: 'You are up to date.',
      detail: `Version ${result.version ?? app.getVersion()} is the latest release.`,
      buttons: ['OK']
    }).catch(() => {});
  } else if (result.phase === 'unavailable') {
    dialog.showMessageBox({
      type: 'info',
      title: 'OpenConnect VPN',
      message: 'Updates are checked in the installed app, not dev builds.',
      buttons: ['OK']
    }).catch(() => {});
  } else if (result.phase === 'error') {
    dialog.showMessageBox({
      type: 'warning',
      title: 'OpenConnect VPN',
      message: 'Update check failed.',
      detail: String(result.message ?? ''),
      buttons: ['OK']
    }).catch(() => {});
  }
}

ipcMain.handle('check-for-updates', async () => checkForUpdatesFromUI());

// Restart-and-install from the footer button. Guarded on the phase so a
// stale renderer cannot trigger quitAndInstall before anything downloaded
// (quitAndInstall would just quit the app in that case).
ipcMain.handle('install-update', async () => {
  if (updateState.phase === 'ready') {
    app.isQuitting = true;
    autoUpdater.quitAndInstall();
    return { ok: true };
  }
  return { ok: false };
});

// App lifecycle
app.whenReady().then(() => {
  // Show splash screen first
  createSplashWindow();

  // Don't create main window yet - wait for splash to complete

  setupAutoUpdate();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createSplashWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (openconnectProcess) {
    // Quitting counts as a user-initiated disconnect, so the SIGTERM exit
    // does not get reported as an error (#38)
    userDisconnectRequested = true;
    openconnectProcess.kill('SIGTERM');
  }
});
