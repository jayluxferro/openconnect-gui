# OpenConnect VPN GUI

A macOS desktop app for connecting to VPNs with [OpenConnect](https://www.infradead.org/openconnect/). It wraps the `openconnect` command line client in a window with saved profiles, live logs, route diagnostics and a process list. Built with Electron, React and shadcn/ui.

## Screenshots

### Connection tab
![Connection Tab](screenshots/openconnect-vpn-1.png)
Connection settings on the left, recent activity on the right.

### Processes tab
![Process Monitor](screenshots/openconnect-vpn-2.png)
Running OpenConnect processes, with a Kill button that asks for your sudo password.

## What it does

- Connects with a username and password over seven protocols: AnyConnect (Cisco), Juniper Network Connect, GlobalProtect (Palo Alto), Pulse Connect Secure, F5 Big-IP, Fortinet and Array Networks.
- Saves connection profiles and fills the form from them.
- Shows your public IP before and after connecting (looked up from ipify.org), and once connected, the address the VPN assigned to this machine — labeled `VPN:` in the header.
- Streams OpenConnect output to a Logs tab, with the last 10 entries on the Connection tab.
- Flags network routes left over from a previous network, a common cause of failed connections after switching networks, and deletes them.
- Lists OpenConnect processes, including ones started from a terminal or another tool, and kills them.
- Checks for OpenConnect and `expect` at startup, and warns if your account is not an administrator.
- Puts an icon in the menu bar. Connect to any saved profile, disconnect, and see the live status — including which profile is active — without opening the window. The padlock icon closes when the tunnel is up.

## Install

1. Get the app — any one of:
   - double-click the `.pkg` from [Releases](https://github.com/jayluxferro/openconnect-gui/releases), or
   - drag "OpenConnect VPN" from the `.dmg` into Applications, or
   - one line in Terminal (installs Homebrew and openconnect too, if missing):

     ```bash
     curl -fsSL https://raw.githubusercontent.com/jayluxferro/openconnect-gui/develop/install.sh | bash
     ```

     If Homebrew is missing, a macOS password dialog appears once to authorize its installation — you never type a password into the terminal.

   The published build is for Apple Silicon; on an Intel Mac, build it yourself ([CONTRIBUTING.md](CONTRIBUTING.md#build-the-dmg)).
2. Install OpenConnect if you installed by hand and do not have it:

   ```bash
   brew install openconnect
   ```

`expect` ships with macOS. Your account needs to be an administrator, because OpenConnect runs under `sudo`.

Once installed, the app updates itself: it checks this repository's releases in the background and applies the update after asking you. You can also check on demand — **Check for Updates** in the window's footer or **Check for Updates…** in the menu-bar menu — and watch the download progress as it streams in (see [SECURITY.md](SECURITY.md) for how updates are verified).

### First launch

The published build is not code-signed, so macOS reports "OpenConnect VPN is damaged" and refuses to open it. Clear the quarantine flag once:

```bash
xattr -cr "/Applications/OpenConnect VPN.app"
```

Later launches work normally. The right-click Open workaround does not help with this message.

## Usage

The window has four tabs: Connection, Logs, Diagnostics and Processes.

### Connect

1. Fill in the Connection tab:
   - Server URL, for example `https://vpn.example.com:443`
   - Username and password
   - Protocol (defaults to AnyConnect)
   - Group or authgroup, if your server uses one
   - Server certificate, if you need to pin it, for example `pin-sha256:...`. It is passed to `openconnect --servercert`.
2. Click Connect. The app opens its own window asking for your macOS password, which it needs to run OpenConnect with `sudo`.
3. The status badge moves from Disconnected to Connecting to Connected, and the IP in the header updates.

### Profiles

Enter a profile name and click Save Profile. Pick a saved profile from the dropdown to fill the form, or click the trash icon next to it to delete it.

Profiles are stored in plaintext, password included. To keep the password out of the file, leave the password field empty before saving and type it in each time you connect.

### Menu bar

The menu-bar icon mirrors the app. Its top line shows the connection status and the active profile. Connect lists your saved profiles; picking one starts the tunnel without opening the window. If the profile has no stored password, the window opens with that profile already selected so you can type it. While a tunnel is up the menu offers Disconnect instead, and Quit warns before dropping a live connection.

### Diagnostics

Opening the Diagnostics tab lists network interfaces (`ifconfig`), reads the routing table (`netstat -rn`), and, if the Connection form has a server URL, tests whether that server is reachable (`nc -zv`).

A route is marked in red with a Delete button when its gateway is a private address (`10.x`, `172.16.x` to `172.31.x`, `192.168.x`) whose first three numbers match none of your interface addresses. That usually means it is left over from another network, for example a phone hotspot. The check assumes every network is a `/24`, so it can flag a valid route on a larger network, and it never flags public gateways ([#11](https://github.com/jadedm/openconnect-gui/issues/11)).

Delete asks for your sudo password and runs `sudo route delete <destination>`. It only accepts `default` or a full four-part address such as `172.20.10.0/28`; routes that `netstat` prints in short form, like `10/8`, fail with "Invalid destination format" and have to be removed from a terminal.

### Processes

Each time you open the Processes tab it lists running processes whose command line matches `sudo ... openconnect`, `/usr/...openconnect` or `/opt/...openconnect`. One connection from this app shows as several rows (sudo, openconnect and the connection script), and the badge on the tab counts all of them ([#13](https://github.com/jadedm/openconnect-gui/issues/13)). Kill asks for your sudo password and sends `SIGKILL`, which drops that VPN connection immediately.

In the installed app this tab currently shows your sudo password, VPN username and VPN password while you are connected. Do not open it while sharing your screen until [#4](https://github.com/jadedm/openconnect-gui/issues/4) is fixed.

### Logs

The Logs tab shows all OpenConnect output as it arrives. Lines from the connection script start with `[EXPECT]`, errors with `[ERROR]` and debug detail with `[DEBUG]`. It keeps the last 500 entries (an entry can span several lines). Copy puts them on the clipboard; Clear removes them and leaves a single "Logs cleared" line.

## Troubleshooting

**Startup check fails.** Install OpenConnect with `brew install openconnect`. `expect` should be at `/usr/bin/expect`. A missing OpenConnect or `expect` stops the remaining checks, so fix it and relaunch to see the rest. A missing admin membership is only a warning.

**"Connection failed. This may be due to incorrect sudo password or network issues."** The app shows this message whenever the connection exits with code 1, and "Connection closed with exit code N" for other codes, whatever the cause ([#9](https://github.com/jadedm/openconnect-gui/issues/9)). The Logs tab has the real cause on an `[EXPECT ERROR]` line:

- `OpenConnect process ended unexpectedly` straight after the sudo prompt: usually a wrong sudo password ([#9](https://github.com/jadedm/openconnect-gui/issues/9) makes this say so). Enter your macOS login password, not the VPN password.
- `VPN authentication failed`: check the VPN username and password, the server URL, and the certificate pin if you set one.
- `Network connection failed before authentication` or `Timeout waiting for ...`: the server did not answer. Check the URL and try Diagnostics.

**"Failed to connect" or "Can't assign requested address".** Usually a stale route. Open Diagnostics and delete the routes marked in red. A typical one is a route to `172.20.10.1` left over from a phone hotspot.

One variant of this error is harmless: during connect you may see `route: writing to routing socket: Can't assign requested address add net <tunnel's own IP>: gateway <same IP>`. That is the setup script trying to add a route for the tunnel's own address via itself — macOS declines, because the address already sits on the tunnel interface. Every route that matters installs right after it; if those lines are clean, the error can be ignored.

**Connected, but the public IP did not change.** Not a fault: your VPN is split-tunnel — it routes only the corporate subnets through the tunnel and leaves internet traffic on your normal network, so your public IP is supposed to stay the same. The header shows the address the VPN assigned to this machine as `VPN:`; that is the tunnel's own address.

**Connected but no internet.** The tunnel is up but route setup failed. Look for `vpnc-script` errors in the logs and check routes in Diagnostics. As a last resort you can add a default route by hand: `sudo route add -net 0.0.0.0/0 <gateway>`.

**Stray OpenConnect processes.** Kill them from the Processes tab, from Activity Monitor, or from a terminal:

```bash
pgrep -lf openconnect
sudo kill -9 <PID>
sudo pkill -9 openconnect   # all of them
```

**Connect fails at once in the installed app with an `expect` error about a missing file.** The connection script should be at `/Applications/OpenConnect VPN.app/Contents/Resources/vpn-connect.exp`. If it is missing, the package is broken; rebuild or download again.

## Security and your data

Saved profile passwords are encrypted at rest with the macOS Keychain (`safeStorage`); only when the Keychain is unavailable does a password fall back to plaintext in `profiles.json` (the app's folder under `~/Library/Application Support/`), and it warns in the Logs tab when that happens. VPN credentials are handed to the connection helper over a pipe, never on the command line, so they cannot appear in `ps` output or the Processes tab. Your macOS password is asked for each time, never written to disk, and only ever sent to a sudo prompt made recognizable by a per-connection random marker — a log line containing `sudo-prompt-<random>:` is that marker being echoed, not a secret. The app looks up your public IP address from api.ipify.org when it starts and whenever the connection status changes.

[SECURITY.md](SECURITY.md) explains how credentials are handled and how to report a new issue privately.

## Limitations

- macOS only. The connection flow depends on `expect` and `sudo`.
- The published build is unsigned, so the first launch needs the step above.
- Username and password only. No 2FA prompts yet ([#5](https://github.com/jadedm/openconnect-gui/issues/5)) and no [certificate login](https://github.com/jadedm/openconnect-gui/discussions/15).
- Reconnect is limited to what OpenConnect does itself: it retries a dropped connection for 60 seconds. After that you reconnect by hand ([idea](https://github.com/jadedm/openconnect-gui/discussions/17)).
- [One connection at a time](https://github.com/jadedm/openconnect-gui/discussions/26).
- Light theme only.

## Roadmap and ideas

Planned work is in [issues labelled `enhancement`](https://github.com/jadedm/openconnect-gui/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement). Ideas that are not planned yet live in [Discussions: Ideas](https://github.com/jadedm/openconnect-gui/discussions/categories/ideas); upvote the ones you want or start a new one.

## Contributing

Bug reports, fixes and ideas are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers where each goes, how to build the app from source, and how it is put together. Questions go in [Discussions: Q&A](https://github.com/jadedm/openconnect-gui/discussions/categories/q-a).

## License

[MIT](LICENSE)

---

**Built by [Manish Jadhav](https://manishj.com)**, engineer & technical consultant.

Need something like this designed or built? [Inoltro](https://inoltro.ai) is my studio.
