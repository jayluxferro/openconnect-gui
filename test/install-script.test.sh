#!/usr/bin/env bash
# install.sh harness — proves the one-click script survives its own
# deployment style (`curl … | bash`) on a fresh machine.
#
# The bug this guards against, seen on a real fresh Mac: a child process
# (brew's auto-update) read stdin, which under `curl | bash` IS the rest of
# the script — brew swallowed the DMG-install half of the script and the run
# ended silently. Every case here pipes the script into bash exactly like
# production and uses a fake brew that DELIBERATELY consumes stdin, so any
# unguarded command that lets a child read stdin fails the suite.
#
# The fakes also pin the other fresh-machine guarantees: no interpreter is
# used for the release lookup (python3 on a fresh Mac is a Command Line
# Tools stub that pops an installer dialog), and the .dmg asset is picked
# without confusing it with the .pkg or .dmg.blockmap.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
say()  { printf '%s\n' "$*"; }
pass() { PASS=$((PASS+1)); say "PASS $1"; }
fail() { FAIL=$((FAIL+1)); say "FAIL $1"; }

API_JSON='{"tag_name":"v9.9.9","assets":[{"name":"OpenConnect.VPN-9.9.9-arm64.pkg","browser_download_url":"https://github.com/o/r/releases/download/v9.9.9/OpenConnect.VPN-9.9.9-arm64.pkg"},{"name":"OpenConnect.VPN-9.9.9-arm64.dmg.blockmap","browser_download_url":"https://github.com/o/r/releases/download/v9.9.9/OpenConnect.VPN-9.9.9-arm64.dmg.blockmap"},{"name":"OpenConnect.VPN-9.9.9-arm64.dmg","browser_download_url":"https://github.com/o/r/releases/download/v9.9.9/OpenConnect.VPN-9.9.9-arm64.dmg"}]}'

# Sets up a fake machine in $1: PATH-shimmed brew/curl/hdiutil/ditto/open and
# a writable APP_DIR. $FAKE_CURL_MODE selects the release-lookup behavior:
#   api   — API responds with $API_JSON (happy path)
#   dead  — API responds with garbage (exercises the no-API redirect fallback)
make_fake_machine() {
  local dir="$1"
  mkdir -p "$dir/bin" "$dir/appdir" "$dir/home"
  export FAKE_BIN="$dir/bin" FAKE_HOME="$dir/home" FAKE_APP_DIR="$dir/appdir"
  export FAKE_CURL_MODE="$2" FAKE_STATE="$dir/state"
  mkdir -p "$FAKE_STATE"

  # brew: records the call, then EATS stdin like the real bug did
  cat > "$dir/bin/brew" <<'EOF'
#!/usr/bin/env bash
echo "brew $*" >> "$FAKE_STATE/brew.log"
cat > /dev/null   # the fresh-Mac bug: consume whatever stdin we inherited
exit 0
EOF
  # curl: serves API JSON / latest-release redirect / downloads by URL shape
  cat > "$dir/bin/curl" <<'EOF'
#!/usr/bin/env bash
url=""; outfile=""; skip=0; need=""
for a in "$@"; do
  if [ "$skip" = 1 ]; then
    [ "$need" = o ] && outfile="$a"
    skip=0; need=""; continue
  fi
  case "$a" in
    -o) skip=1; need=o ;;
    -w) skip=1 ;;
    -*) : ;;
    *) url="$a" ;;
  esac
done
case "$url" in
  *api.github.com*)
    if [ "$FAKE_CURL_MODE" = api ]; then echo "$API_JSON"; else echo "rate limited garbage"; fi
    ;;
  *releases/latest*)
    echo "https://github.com/jayluxferro/openconnect-gui/releases/tag/v9.9.9"
    ;;
  *releases/download/*)
    echo "$url" >> "$FAKE_STATE/curl-downloads.log"
    printf 'fake dmg for %s' "$url" > "${outfile:-/dev/null}"
    ;;
  *) echo "curl: unexpected url $url" >&2; exit 1 ;;
esac
EOF
  # hdiutil: mounts a DMG containing the app
  cat > "$dir/bin/hdiutil" <<'EOF'
#!/usr/bin/env bash
mp=""; prev=""
for a in "$@"; do [ "$prev" = -mountpoint ] && mp="$a"; prev="$a"; done
mkdir -p "$mp/OpenConnect VPN.app/Contents/MacOS"
EOF
  # ditto: records and materializes the destination so later steps find it
  cat > "$dir/bin/ditto" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/ditto.log"
mkdir -p "$2/Contents/MacOS"
EOF
  cat > "$dir/bin/open" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_STATE/open.log"
EOF
  # python3: must never run — its presence would mean the interpreter-free
  # release lookup regressed (fresh Macs ship a CLT stub here)
  cat > "$dir/bin/python3" <<'EOF'
#!/usr/bin/env bash
touch "$FAKE_STATE/python3-was-called"
exit 3
EOF
  # dscl: this fake user is an admin
  cat > "$dir/bin/dscl" <<'EOF'
#!/usr/bin/env bash
echo "GroupMembership: admin $(id -un)"
EOF
  chmod +x "$dir"/bin/*
}

# Runs install.sh the way the README tells users to: piped into bash. The
# PATH is fakes + system dirs ONLY — a real /opt/homebrew openconnect would
# satisfy the dependency check and skip the very step under test.
run_piped_install() {
  PATH="$FAKE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" APP_DIR="$FAKE_APP_DIR" HOME="$FAKE_HOME" \
    bash < "$ROOT/install.sh" > "$FAKE_STATE/run.out" 2>&1 || \
    echo "exit=$?" >> "$FAKE_STATE/run.out"
}

check_common() {
  local label="$1"
  grep -q "install openconnect" "$FAKE_STATE/brew.log" \
    && pass "$label: openconnect installed via brew" \
    || fail "$label: brew install openconnect never ran"
  [ -f "$FAKE_STATE/open.log" ] && grep -q "OpenConnect VPN.app" "$FAKE_STATE/open.log" \
    && pass "$label: reached app launch (script not eaten)" \
    || fail "$label: run ended before launch — stdin was consumed"
  grep -q "Done\." "$FAKE_STATE/run.out" \
    && pass "$label: run completed" \
    || fail "$label: never reached the end"
  [ ! -f "$FAKE_STATE/python3-was-called" ] \
    && pass "$label: no interpreter used for release lookup" \
    || fail "$label: python3 was invoked"
  [ -f "$FAKE_STATE/ditto.log" ] && grep -q "OpenConnect VPN.app" "$FAKE_STATE/ditto.log" \
    && pass "$label: app copied into APP_DIR" \
    || fail "$label: app never copied"
}

# --- case 1: API answers; the .dmg must be chosen over .pkg and .blockmap ----
say "== case: api lookup, hostile stdin"
W="$(mktemp -d)"; make_fake_machine "$W" api; run_piped_install; check_common api
grep -q "OpenConnect.VPN-9.9.9-arm64.dmg$" "$FAKE_STATE/curl-downloads.log" \
  && pass "api: downloaded the .dmg asset" \
  || fail "api: wrong asset requested: $(cat "$FAKE_STATE/curl-downloads.log" 2>/dev/null)"
if ! grep -q "blockmap" "$FAKE_STATE/curl-downloads.log"; then
  pass "api: blockmap not mistaken for the dmg"
else
  fail "api: blockmap requested"
fi

# --- case 2: API dead; the redirect fallback must build the URL itself -------
say "== case: api unavailable, redirect fallback"
W="$(mktemp -d)"; make_fake_machine "$W" dead; run_piped_install; check_common fallback
grep -q "releases/download/v9.9.9/OpenConnect.VPN-9.9.9-arm64.dmg$" "$FAKE_STATE/curl-downloads.log" \
  && pass "fallback: URL constructed from the latest tag" \
  || fail "fallback: wrong URL: $(cat "$FAKE_STATE/curl-downloads.log" 2>/dev/null)"

say
say "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
