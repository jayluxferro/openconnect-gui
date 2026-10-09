#!/usr/bin/env bash
#
# One-click installer for OpenConnect VPN (macOS).
#
#   1. Installs Homebrew if missing (official installer, non-interactive;
#      authorized with a one-time macOS password dialog — never typed in
#      the terminal)
#   2. Installs openconnect via Homebrew (skips if already present)
#   3. Downloads the app DMG (latest GitHub release, or --dmg override)
#   4. Copies the app to /Applications (replacing any older copy)
#   5. Launches it
#
# Usage:
#   ./install.sh                          # everything, DMG from latest release
#   ./install.sh --dmg ./dist/OpenConnect VPN-1.0.0-arm64.dmg
#   ./install.sh --dmg https://example.com/OpenConnect.dmg
#   ./install.sh --skip-openconnect       # app only
#
# Safe to re-run: every step checks whether it is already done.
#
# Pipe-safe: every external command runs with stdin redirected from
# /dev/null. Under `curl … | bash` the script itself IS stdin, and any
# child that reads stdin (brew's auto-update did, on a fresh Mac) swallows
# the rest of the script — the run then ends silently mid-way. No step
# needs interactive input; the guards make that impossible. The one thing
# that DOES need input — the sudo password for a Homebrew install — is
# collected through a GUI dialog (or /dev/tty, never the script's stdin)
# and fed to sudo -S on a private pipe.
#
set -euo pipefail

REPO="jayluxferro/openconnect-gui"
APP_NAME="OpenConnect VPN"
# Overridable for the test harness; /Applications for every real install
APP_DIR="${APP_DIR:-/Applications}"
DMG_SOURCE=""
SKIP_OPENCONNECT=0

# --- pretty output -----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi
step()  { printf '%s\n' "${BOLD}==> $*${RESET}"; }
ok()    { printf '    %s %s\n' "${GREEN}✓${RESET}" "$*"; }
warn()  { printf '    %s %s\n' "${YELLOW}!${RESET}" "$*"; }
die()   { printf '    %s %s\n' "${RED}✗${RESET}" "$*" >&2; exit 1; }

# --- parse args ---------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --dmg)             DMG_SOURCE="${2:?--dmg needs a path or URL}"; shift 2 ;;
    --repo)            REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --skip-openconnect) SKIP_OPENCONNECT=1; shift ;;
    -h|--help)         sed -n '2,28p' "$0"; exit 0 ;;
    *)                 die "unknown option: $1 (try --help)" ;;
  esac
done

# --- sudo authorization (only used to install Homebrew) ------------------------
# Homebrew's installer needs sudo to create /opt/homebrew. NONINTERACTIVE mode
# plus a piped script means nothing can prompt on stdin, so we collect the
# password ourselves, seed `sudo`'s cached timestamp, and keep it fresh until
# this script exits. The password is never printed, logged, or written to disk.
MOUNT_POINT=""                                    # set once a DMG is mounted
SUDO_SEEDED=0
SUDO_KEEPALIVE_PID=""
SUDO_KEEPALIVE_SECS="${SUDO_KEEPALIVE_SECS:-45}"  # overridable for the test harness
TTY_DEV="${TTY_DEV:-/dev/tty}"                    # ditto

cleanup() {
  if [ -n "$SUDO_KEEPALIVE_PID" ]; then
    kill "$SUDO_KEEPALIVE_PID" 2>/dev/null
    SUDO_KEEPALIVE_PID=""
  fi
  if [ "$SUDO_SEEDED" -eq 1 ]; then
    sudo -k </dev/null >/dev/null 2>&1 || true    # drop the timestamp we raised
  fi
  if [ -n "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# GUI dialog. Prints the password on stdout; exit 130 = user canceled,
# exit 1 = no dialog possible (caller falls back to the terminal).
prompt_password_dialog() {
  local message="$1" err_file err pw rc
  err_file="$(mktemp)"
  pw="$(osascript -e 'on run argv
  return text returned of (display dialog (item 1 of argv) default answer "" with hidden answer with title "OpenConnect VPN installer" with icon caution buttons {"Authorize", "Cancel"} default button "Authorize")
end run' "$message" </dev/null 2>"$err_file")"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    rm -f "$err_file" </dev/null
    printf '%s\n' "$pw"
    return 0
  fi
  err="$(cat "$err_file" </dev/null)"
  rm -f "$err_file" </dev/null
  case "$err" in
    *"User canceled"*|*"User Cancelled"*) return 130 ;;
  esac
  return 1
}

# Terminal fallback for machines with no GUI session (e.g. SSH): reads from
# /dev/tty, never the script's piped stdin.
prompt_password_tty() {
  local message="$1" pw
  printf '%s\n%s' "$message" "password: " >&2
  IFS= read -rs pw < "$TTY_DEV" || return 1
  printf '\n' >&2
  printf '%s\n' "$pw"
}

prompt_password() {
  local message="$1" rc
  if command -v osascript >/dev/null 2>&1; then
    prompt_password_dialog "$message"
    rc=$?
    # 0 = got it, 130 = canceled (die, don't pester); 1 = try the terminal.
    if [ "$rc" -ne 1 ]; then return "$rc"; fi
  fi
  prompt_password_tty "$message"
}

# Seeds sudo's cached timestamp (up to 3 password attempts) and keeps it
# fresh in the background for the rest of the run. Homebrew's installer
# then sails through its `sudo -n` checks and privileged steps unprompted.
authorize_sudo() {
  if sudo -n true </dev/null >/dev/null 2>&1; then
    ok "sudo already authorized in this terminal"
    return 0
  fi
  local attempt pw rc
  for attempt in 1 2 3; do
    # The `if` also suspends set -e inside the substitution: a canceled or
    # failed prompt must reach our rc handling, not abort the script.
    if pw="$(prompt_password "Homebrew needs your macOS password once, to install into /opt/homebrew (attempt ${attempt} of 3).")"; then
      rc=0
    else
      rc=$?
    fi
    if [ "$rc" -eq 130 ]; then
      die "Password dialog canceled. Homebrew needs authorization once — re-run the installer, or install Homebrew from https://brew.sh and re-run."
    fi
    if [ -n "$pw" ] && printf '%s\n' "$pw" | sudo -S -v -p '' >/dev/null 2>&1; then
      pw=""
      SUDO_SEEDED=1
      (
        while kill -0 "$$" 2>/dev/null; do
          sudo -n true </dev/null >/dev/null 2>&1 || break
          sleep "$SUDO_KEEPALIVE_SECS"
        done
      ) &
      SUDO_KEEPALIVE_PID=$!
      disown 2>/dev/null || true    # no "Terminated" job notice on cleanup
      ok "authorized — sudo session kept alive for the rest of the install"
      return 0
    fi
    warn "incorrect password, trying again"
  done
  die "Three incorrect passwords. Install Homebrew from https://brew.sh manually, then re-run."
}

# --- preflight ----------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS only."
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  warn "Published builds are for Apple Silicon; this Mac is ${ARCH}."
  warn "Pass --dmg with an x64 build, or build one yourself (CONTRIBUTING.md)."
fi
[ "$(id -u)" -ne 0 ] || die "Run as a normal user, not root — Homebrew refuses root."
if ! dscl . -read /Groups/admin GroupMembership 2>/dev/null | grep -qw "$USER"; then
  die "Your account (${USER}) is not an administrator. The app runs openconnect under sudo, which needs admin."
fi

# --- 1. Homebrew ---------------------------------------------------------------
# BREW_PATHS: where to look for an existing brew outside PATH (overridable
# for the test harness; the defaults are the two real install locations).
step "Checking for Homebrew"
if command -v brew >/dev/null 2>&1; then
  ok "found at $(command -v brew)"
else
  for candidate in ${BREW_PATHS:-/opt/homebrew/bin/brew /usr/local/bin/brew}; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv </dev/null)"
      ok "found at $candidate (added to PATH for this run)"
      break
    fi
  done
fi

if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew not found — installing it now."
  warn "A macOS password dialog will appear once to authorize the installation."
  authorize_sudo
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh </dev/null)" \
    </dev/null || die "Homebrew installation failed. Install it manually from https://brew.sh and re-run."
  for candidate in ${BREW_PATHS:-/opt/homebrew/bin/brew /usr/local/bin/brew}; do
    if [ -x "$candidate" ]; then eval "$("$candidate" shellenv </dev/null)"; break; fi
  done
  command -v brew >/dev/null 2>&1 || die "Homebrew installed but not on PATH. Open a new terminal and re-run."
  ok "Homebrew installed"
fi

# --- 2. openconnect ------------------------------------------------------------
if [ "$SKIP_OPENCONNECT" -eq 1 ]; then
  step "Skipping openconnect (--skip-openconnect)"
elif command -v openconnect >/dev/null 2>&1; then
  step "Checking for openconnect"
  ok "already installed: $(command -v openconnect) ($(openconnect --version </dev/null 2>&1 | head -1 | sed 's/^ *[Oo]pen[Cc]onnect //;s/ *$//'))"
else
  step "Installing openconnect via Homebrew"
  brew install openconnect </dev/null || die "brew install openconnect failed."
  ok "installed: $(command -v openconnect)"
fi
if command -v expect >/dev/null 2>&1; then
  ok "expect present (ships with macOS)"
else
  warn "expect missing — it should be at /usr/bin/expect; install macOS Command Line Tools (xcode-select --install)."
fi

# --- 3. DMG --------------------------------------------------------------------
step "Locating the app DMG"
DMG_FILE=""

if [ -n "$DMG_SOURCE" ]; then
  case "$DMG_SOURCE" in
    http://*|https://*)
      DMG_FILE="$(mktemp -t ocgui).dmg"
      curl -fL --progress-bar "$DMG_SOURCE" -o "$DMG_FILE" || die "download failed: $DMG_SOURCE"
      ok "downloaded from $DMG_SOURCE" ;;
    *)
      DMG_FILE="$DMG_SOURCE"
      [ -f "$DMG_FILE" ] || die "no such file: $DMG_FILE"
      ok "using $DMG_FILE" ;;
  esac
else
  # Shell-only asset lookup. No interpreters: on a fresh Mac /usr/bin/python3
  # is a Command Line Tools stub that pops an installer dialog instead of
  # running. URLs contain no commas or quotes, so tr+sed is sound here.
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
  DMG_URL="$(curl -fsSL "$API_URL" </dev/null \
    | tr ',' '\n' \
    | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\.dmg\)".*/\1/p' \
    | head -1)"
  if [ -z "$DMG_URL" ]; then
    # Fallback with no API dependency (and no rate limits): releases/latest
    # redirects to releases/tag/<tag>, and GitHub names the asset
    # <product with spaces as dots>-<version>-arm64.dmg.
    LATEST_TAG="$(curl -fsSI -o /dev/null -w '%{url_effective}' "https://github.com/${REPO}/releases/latest" </dev/null \
      | sed -n 's|.*/tag/||p')"
    if [ -n "$LATEST_TAG" ]; then
      DMG_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/OpenConnect.VPN-${LATEST_TAG#v}-arm64.dmg"
    fi
  fi
  [ -n "$DMG_URL" ] || die "could not find a release DMG on github.com/${REPO}. Publish a release or pass --dmg."
  DMG_FILE="$(mktemp -t ocgui).dmg"
  curl -fL --progress-bar "$DMG_URL" -o "$DMG_FILE" </dev/null || die "download failed: $DMG_URL"
  ok "downloaded latest release from github.com/${REPO}"
fi

# --- 4. install to /Applications ----------------------------------------------
step "Installing ${APP_NAME} to ${APP_DIR}"
MOUNT_POINT="$(mktemp -d)/mount"
hdiutil attach "$DMG_FILE" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet \
  </dev/null || die "could not mount the DMG (it may be corrupted — re-download)."
APP_IN_DMG="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP_IN_DMG" ] || die "no .app found inside the DMG."

if [ -d "${APP_DIR}/${APP_NAME}.app" ]; then
  rm -rf "${APP_DIR}/${APP_NAME}.app"
  ok "removed previous version"
fi
ditto "$APP_IN_DMG" "${APP_DIR}/${APP_NAME}.app" </dev/null || die "could not copy the app to ${APP_DIR}."
# Clear quarantine recursively without xattr -r (not available on newer macOS).
find "${APP_DIR}/${APP_NAME}.app" -exec xattr -d com.apple.quarantine {} + >/dev/null 2>&1 </dev/null || true
ok "installed at ${APP_DIR}/${APP_NAME}.app"

# --- 5. launch -------------------------------------------------------------------
step "Launching ${APP_NAME}"
open -a "${APP_DIR}/${APP_NAME}.app" </dev/null
ok "started"

printf '\n%s\n' "${BOLD}Done.${RESET} Connect from the app — your macOS password is requested at connect time."
printf '%s\n' "${DIM}First time: the app window checks your setup (openconnect, expect, admin). Profiles are stored locally; leave the password field empty when saving a profile if you do not want it on disk.${RESET}"
