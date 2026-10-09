// Pure builder for the menu-bar (tray) menu. No Electron imports: it maps
// connection state to menu-item descriptors carrying an `action` string
// (and, for profile items, the profile name) instead of click handlers.
// main.js wires actions to real handlers; the unit tests assert the
// structure directly. This module is the single source of truth for the
// tray's wording and for which actions are available in each state.

// Human wording for the tray status line. Unknown states read as
// "Not connected" — fail toward the safe default rather than printing
// an internal status string at the user.
function statusLabel(state) {
  const { status = 'disconnected', activeProfile = null } = state;
  switch (status) {
    case 'connecting': return 'Connecting…';
    case 'connected': return activeProfile ? `Connected to ${activeProfile}` : 'Connected';
    case 'disconnecting': return 'Disconnecting…';
    default: return 'Not connected';
  }
}

const isBusy = (status) =>
  status === 'connecting' || status === 'connected' || status === 'disconnecting';

// Builds the descriptor list for the tray context menu.
// state: { status, activeProfile, profiles: [{ name, ... }] }
function buildTrayTemplate(state) {
  const { status = 'disconnected', activeProfile = null, profiles = [] } = state;

  const items = [
    { label: `OpenConnect VPN — ${statusLabel(state)}`, enabled: false },
    { type: 'separator' }
  ];

  if (isBusy(status)) {
    // One action slot: while a tunnel is up or coming up, the only
    // connection action is tearing it down. Enabled during 'connecting'
    // (aborting a half-open connection is legitimate) but not while already
    // 'disconnecting'.
    items.push({
      label: activeProfile ? `Disconnect ${activeProfile}` : 'Disconnect',
      action: 'disconnect',
      enabled: status !== 'disconnecting'
    });
  } else {
    items.push({
      label: 'Connect',
      enabled: profiles.length > 0,
      submenu: profiles.map((profile) => ({
        label: profile.name,
        action: 'connect-profile',
        profile: profile.name
      }))
    });
  }

  items.push(
    { type: 'separator' },
    { label: 'Show OpenConnect VPN', action: 'show' },
    { type: 'separator' },
    { label: 'Quit OpenConnect VPN', action: 'quit' }
  );

  return items;
}

module.exports = { buildTrayTemplate, statusLabel };
