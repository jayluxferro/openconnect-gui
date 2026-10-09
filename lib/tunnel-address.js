// Pure parser: pulls the tunnel's own address out of openconnect's output.
//
// openconnect prints it exactly once, the moment the session is up —
// current builds say "Configured as 192.168.98.179, with SSL connected and
// DTLS disabled", older ones said "Connected as 192.168.98.179". Split
// tunnel VPNs (only corporate subnets routed through) never change the
// public IP, so this line is the only place the "VPN address" exists.
// Surfacing it in the header is what makes a split tunnel legible instead
// of looking like the connection did nothing.

// IPv4 (dotted quad) or IPv6 (hex digits and colons). The capture stops at
// the comma/whitespace that always follows in openconnect's phrasing.
const TUNNEL_ADDRESS = /\b(?:configured|connected) as ((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]*:[0-9a-f:.]+)/i;

function parseTunnelAddress(line) {
  if (typeof line !== 'string') {
    return null;
  }
  // openconnect prefixes every Connect Banner line with "| " — and the
  // banner is server-controlled text. Without this guard a hostile VPN
  // server could spoof the header's VPN address ("| Configured as
  // 6.6.6.6"). Display-only impact, but free to close.
  if (/^\s*\|/.test(line)) {
    return null;
  }
  const match = line.match(TUNNEL_ADDRESS);
  return match ? match[1] : null;
}

module.exports = { parseTunnelAddress };
