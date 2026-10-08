# Security

## Reporting a vulnerability

Report it privately through [GitHub's advisory form](https://github.com/jadedm/openconnect-gui/security/advisories/new). Do not open a public issue or Discussion for something that is not already listed below.

Include the release you downloaded, your macOS version, and the steps to reproduce.

## Supported versions

Only the latest release gets fixes. There are no backports.

## What the app does with your credentials and data

The app runs `openconnect` under `sudo`, so it handles two secrets: your macOS password (for `sudo`) and your VPN password.

- **macOS password.** Asked for on every connect (in a separate window) and every process kill and route delete (in a dialog inside the main window). It is never written to disk, never placed on a command line or in the environment: it reaches the connection helper over a pipe and is sent only to sudo's own password prompt, which carries a per-connection random marker so a VPN server's password prompt can never be mistaken for it. After some failed kills or route deletes the dialog keeps it in memory and shows it filled in the next time it opens.
- **VPN password.** Typed into the Connection form. A saved profile stores the password encrypted with the macOS Keychain (`safeStorage`); if the Keychain is unavailable the app warns in the Logs tab and falls back to plaintext in `profiles.json` in the app's folder under `~/Library/Application Support/`. Profile files are written to a temp file and renamed into place, so a crash mid-write cannot leave a truncated file.
- **Public IP lookup.** The app sends a request to api.ipify.org when it starts and whenever the connection status changes, to show your public IP.

## Protections in place

- Every window (main, splash, installer helper, sudo password prompt) runs with context isolation and Node.js access disabled, and reaches the main process only through the narrow function set its own preload exposes. No window may navigate away from its bundled page or open popups.
- Connection fields and credentials are never interpreted as code or options on the way to openconnect: each field arrives as one argument, changed only by trimming surrounding spaces and adding `https://` to a bare server name. `npm run test:expect` checks this against hostile values.
- Credentials reach the connection script over its stdin pipe, percent-encoded — never as command-line arguments or environment variables — so `ps` and the Processes tab cannot show them. A one-time random nonce baked into sudo's password prompt (`sudo -p`) means the macOS password is only ever sent to sudo itself; a VPN server that asks for the password first is answered with the VPN password. `npm run test:expect` covers a password-first server and a forged prompt marker.
- The Logs tab masks session cookies (cookie and authorization headers, the session cookie names of the seven supported protocols, and passwords inside URLs) in every line that comes from openconnect or the connection script, and openconnect runs without `--verbose`, so HTTP headers are not printed at all. `npm run test:unit` checks the masking.
- Process IDs must be numeric, and route destinations must be `default` or four dot-separated numbers with an optional prefix length, before they reach `sudo`.
- Most system commands run through `spawn()` with argument arrays. Four use `exec()` with a shell string: the process list, the routing table, the interface list and the OpenConnect installer launcher. The installer string includes the app's install path; none of them include anything you type.

## Known weaknesses

Each is a public issue labelled [`security`](https://github.com/jadedm/openconnect-gui/issues?q=is%3Aissue+label%3Asecurity).

The weaknesses this fork set out to fix are fixed here: [#4](https://github.com/jadedm/openconnect-gui/issues/4) (credentials on the connection script's command line), [#6](https://github.com/jadedm/openconnect-gui/issues/6) (plaintext saved passwords), [#12](https://github.com/jadedm/openconnect-gui/issues/12) (secondary windows running with Node.js access) and [#36](https://github.com/jadedm/openconnect-gui/issues/36) (the macOS password answered into a password-first VPN server prompt). Anything still labelled `security` upstream that is not in that list remains open.
