// Single source of truth for the 16x16 menu-bar icon.
//
// Kept as an embedded buffer instead of a generated PNG file: the tray used
// to load assets/tray-icon.png, which only existed if a postinstall hook had
// run — fresh clones and packaged builds silently shipped without it (#40
// follow-up). Buffer -> nativeImage needs no filesystem at all.
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAA' +
  'aElEQVR4nGNgoBAwUqifgYGB4T8DXPwfC0YXZCBFMxNIw38s4D8DA8N/LBgbpghiNEMwTAxFMw5N' +
  'OG0YAEYzEwMDA8N/BmyAqA0MUAMMDAwM/3FgZGBgYGBgwKMZWSMyvRgYpxkAuKAXEfqlF9sAAAAA' +
  'SUVORK5CYII=';

module.exports = { TRAY_ICON_BASE64 };
