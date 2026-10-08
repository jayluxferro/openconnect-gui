#!/usr/bin/env bash
#
# One-click installer for OpenConnect VPN (macOS).
#
#   1. Installs Homebrew if missing (official installer, non-interactive)
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
set -euo pipefail

REPO="jayluxferro/openconnect-gui"
APP_NAME="OpenConnect VPN"
APP_DIR="/Applications"
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
    -h|--help)         sed -n '2,20p' "$0"; exit 0 ;;
    *)                 die "unknown option: $1 (try --help)" ;;
  esac
done

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
step "Checking for Homebrew"
if command -v brew >/dev/null 2>&1; then
  ok "found at $(command -v brew)"
else
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      eval "$("$candidate" shellenv)"
      ok "found at $candidate (added to PATH for this run)"
      break
    fi
  done
fi

if ! command -v brew >/dev/null 2>&1; then
  warn "Homebrew not found — installing it now."
  warn "The official installer may ask for your macOS password to create /opt/homebrew."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || die "Homebrew installation failed. Install it manually from https://brew.sh and re-run."
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then eval "$("$candidate" shellenv)"; break; fi
  done
  command -v brew >/dev/null 2>&1 || die "Homebrew installed but not on PATH. Open a new terminal and re-run."
  ok "Homebrew installed"
fi

# --- 2. openconnect ------------------------------------------------------------
if [ "$SKIP_OPENCONNECT" -eq 1 ]; then
  step "Skipping openconnect (--skip-openconnect)"
elif command -v openconnect >/dev/null 2>&1; then
  step "Checking for openconnect"
  ok "already installed: $(command -v openconnect) ($(openconnect --version 2>&1 | head -1 | sed 's/^ *[Oo]pen[Cc]onnect //;s/ *$//'))"
else
  step "Installing openconnect via Homebrew"
  brew install openconnect || die "brew install openconnect failed."
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
cleanup() { [ -n "${MOUNT_POINT:-}" ] && hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || true; }
trap cleanup EXIT

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
  API_URL="https://api.github.com/repos/${REPO}/releases/latest"
  DMG_URL="$(curl -fsSL "$API_URL" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    for asset in data.get("assets", []):
        if asset["name"].endswith(".dmg"):
            print(asset["browser_download_url"]); break
    else:
        sys.exit("release has no .dmg asset")
except Exception as e:
    sys.exit(str(e))
')" || die "could not find a release DMG on github.com/${REPO}. Publish a release or pass --dmg."
  DMG_FILE="$(mktemp -t ocgui).dmg"
  curl -fL --progress-bar "$DMG_URL" -o "$DMG_FILE" || die "download failed: $DMG_URL"
  ok "downloaded latest release from github.com/${REPO}"
fi

# --- 4. install to /Applications ----------------------------------------------
step "Installing ${APP_NAME} to ${APP_DIR}"
MOUNT_POINT="$(mktemp -d)/mount"
hdiutil attach "$DMG_FILE" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet \
  || die "could not mount the DMG (it may be corrupted — re-download)."
APP_IN_DMG="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$APP_IN_DMG" ] || die "no .app found inside the DMG."

if [ -d "${APP_DIR}/${APP_NAME}.app" ]; then
  rm -rf "${APP_DIR}/${APP_NAME}.app"
  ok "removed previous version"
fi
ditto "$APP_IN_DMG" "${APP_DIR}/${APP_NAME}.app" || die "could not copy the app to ${APP_DIR}."
# Clear quarantine recursively without xattr -r (not available on newer macOS).
find "${APP_DIR}/${APP_NAME}.app" -exec xattr -d com.apple.quarantine {} + >/dev/null 2>&1 || true
ok "installed at ${APP_DIR}/${APP_NAME}.app"

# --- 5. launch -------------------------------------------------------------------
step "Launching ${APP_NAME}"
open -a "${APP_DIR}/${APP_NAME}.app"
ok "started"

printf '\n%s\n' "${BOLD}Done.${RESET} Connect from the app — your macOS password is requested at connect time."
printf '%s\n' "${DIM}First time: the app window checks your setup (openconnect, expect, admin). Profiles are stored locally; leave the password field empty when saving a profile if you do not want it on disk.${RESET}"
