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
# Pass "nobrew" as $3 for a machine with NO Homebrew: the script must then
# authorize sudo (dialog), run the fake Homebrew installer, and continue.
make_fake_machine() {
  local dir="$1"
  mkdir -p "$dir/bin" "$dir/appdir" "$dir/home"
  export FAKE_BIN="$dir/bin" FAKE_HOME="$dir/home" FAKE_APP_DIR="$dir/appdir"
  export FAKE_CURL_MODE="$2" FAKE_STATE="$dir/state"
  mkdir -p "$FAKE_STATE"
  # Per-machine defaults; individual cases override after this call. TTY_DEV
  # points at a missing file so an unexpected terminal prompt fails fast
  # instead of hanging the suite on the real terminal. BREW_PATHS keeps the
  # script's absolute-path probe away from the real /opt/homebrew on the
  # machine running the tests.
  export TTY_DEV="$dir/no-tty" SUDO_KEEPALIVE_SECS=45 BREW_PATHS="$dir/bin/brew"
  printf 'hunter2' > "$FAKE_STATE/correct_pw"

  if [ "${3:-}" != "nobrew" ]; then
    # brew: records the call, then EATS stdin like the real bug did
    cat > "$dir/bin/brew" <<'EOF'
#!/usr/bin/env bash
echo "brew $*" >> "$FAKE_STATE/brew.log"
cat > /dev/null   # the fresh-Mac bug: consume whatever stdin we inherited
exit 0
EOF
  fi
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
  *Homebrew/install*)
    cat "$FAKE_STATE/homebrew-install.sh" 2>/dev/null || { echo "curl: no fake homebrew installer" >&2; exit 1; }
    ;;
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
  # sudo: emulates the (user,tty) cached-credential timestamp with a state
  # file and logs every call. Never executes the payload — assertions read
  # sudo.log. Honest for every form the scripts use:
  #   sudo -k              → drop the timestamp
  #   sudo -n -v / -n cmd  → OK iff timestamp fresh; never prompts
  #   sudo -S -v -p ''     → read password from stdin, seed the timestamp
  #   sudo -n -k -l        → ignore cache (Homebrew's conservative detect)
  cat > "$dir/bin/sudo" <<'EOF'
#!/usr/bin/env bash
state="$FAKE_STATE/sudo_ts"
log() { printf '%s\n' "$*" >> "$FAKE_STATE/sudo.log"; }
fresh() {
  [ -f "$state" ] || return 1
  [ "$(( $(date +%s) - $(cat "$state") ))" -lt "${FAKE_SUDO_TTL:-300}" ]
}
flags=""; skip=0; cmd=()
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ ${#cmd[@]} -gt 0 ]; then cmd+=("$a"); continue; fi   # past the command name, everything is its argument
  case "$a" in
    -p) skip=1 ;;
    -*) flags="$flags${a#-}" ;;
    *)  cmd+=("$a") ;;
  esac
done
has() { case "$flags" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
check_stdin_password() {
  IFS= read -r pw || return 1
  if [ "$pw" = "$(cat "$FAKE_STATE/correct_pw" 2>/dev/null)" ]; then
    date +%s > "$state"; log "seeded via stdin"; return 0
  fi
  log "wrong password via stdin"; return 1
}
if has k && [ ${#cmd[@]} -eq 0 ] && ! has l; then
  log "-k (timestamp dropped)"; rm -f "$state"; exit 0
fi
if [ ${#cmd[@]} -eq 0 ]; then              # validation only (-v / -l)
  if ! has k && fresh; then date +%s > "$state"; log "authed ($flags)"; exit 0; fi
  if has S; then check_stdin_password; exit $?; fi
  log "auth needed, none given ($flags)"; exit 1
fi
if ! has k && fresh; then                  # command with a valid timestamp
  date +%s > "$state"                      # real sudo refreshes on success
  log "run: ${cmd[*]}"; exit 0
fi
if has S; then check_stdin_password && { log "run: ${cmd[*]}"; exit 0; }; fi
log "auth failed: ${cmd[*]}"; exit 1
EOF
  # osascript: serves scripted dialog answers from $FAKE_STATE/osascript_answers
  # (one per call). Lines: "pw:<text>" returns it; "cancel" reproduces the
  # user-canceled error; anything else a no-GUI failure (drives tty fallback).
  cat > "$dir/bin/osascript" <<'EOF'
#!/usr/bin/env bash
echo "dialog" >> "$FAKE_STATE/osascript.log"
f="$FAKE_STATE/osascript_answers"
if [ ! -s "$f" ]; then echo "execution error: no scripted answer" >&2; exit 1; fi
line="$(head -1 "$f")"
tail -n +2 "$f" > "$f.next" && mv "$f.next" "$f"
case "$line" in
  pw:*)    printf '%s\n' "${line#pw:}"; exit 0 ;;
  cancel)  echo "execution error: User canceled. (-128)" >&2; exit 1 ;;
  *)       echo "execution error: Not authorized to send Apple events. (-1743)" >&2; exit 1 ;;
esac
EOF
  # The Homebrew installer stand-in, served by the fake curl. Same
  # NONINTERACTIVE sudo dance as the real script: without a seeded sudo
  # timestamp it fails with "Need sudo access" exactly like the real fresh-Mac
  # bug; with one, it "installs" brew into the fake bin dir.
  cat > "$FAKE_STATE/homebrew-install.sh" <<'EOF'
#!/usr/bin/env bash
set -u
sudo -n -k -l >/dev/null 2>&1 || true
if ! sudo -n -v 2>/dev/null; then trap 'sudo -k' EXIT; fi
if ! sudo -n -l mkdir >/dev/null 2>&1; then
  echo "Error: Need sudo access to install Homebrew." >&2
  exit 1
fi
sudo mkdir -p /opt/homebrew
printf '#!/usr/bin/env bash\necho "brew $*" >> "$FAKE_STATE/brew.log"\ncat > /dev/null\nexit 0\n' > "$FAKE_BIN/brew"
chmod +x "$FAKE_BIN/brew"
echo "==> Installation successful!"
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

# --- case 3: fresh machine, NO Homebrew — dialog must authorize sudo -----------
# The regression this guards: NONINTERACTIVE + pipe meant sudo could never
# get a password, so Homebrew's installer died with "Need sudo access".
say "== case: no homebrew, dialog authorization"
W="$(mktemp -d)"; make_fake_machine "$W" api nobrew
printf 'pw:hunter2\n' > "$FAKE_STATE/osascript_answers"
run_piped_install; check_common nobrew
grep -q "seeded via stdin" "$FAKE_STATE/sudo.log" \
  && pass "nobrew: dialog password seeded sudo" \
  || fail "nobrew: sudo never seeded (log: $(tr '\n' ';' < "$FAKE_STATE/sudo.log" 2>/dev/null))"
grep -q "run: mkdir -p /opt/homebrew" "$FAKE_STATE/sudo.log" \
  && pass "nobrew: Homebrew installed with sudo privileges" \
  || fail "nobrew: Homebrew never got its privileged install"
[ -s "$FAKE_STATE/osascript.log" ] \
  && pass "nobrew: password dialog was shown" \
  || fail "nobrew: no dialog shown"
grep -qx -- "-k (timestamp dropped)" "$FAKE_STATE/sudo.log" \
  && pass "nobrew: sudo timestamp dropped on exit" \
  || fail "nobrew: timestamp outlived the install"

# --- case 4: wrong password first, correct on the second dialog ----------------
say "== case: no homebrew, wrong password then correct"
W="$(mktemp -d)"; make_fake_machine "$W" api nobrew
printf 'pw:wrongfirst\npw:hunter2\n' > "$FAKE_STATE/osascript_answers"
run_piped_install; check_common nobrew-retry
grep -q "wrong password via stdin" "$FAKE_STATE/sudo.log" \
  && pass "retry: wrong attempt rejected" \
  || fail "retry: wrong-password path not exercised"
grep -q "seeded via stdin" "$FAKE_STATE/sudo.log" \
  && pass "retry: second attempt seeded sudo" \
  || fail "retry: never recovered from the wrong password"

# --- case 5: user cancels the dialog — clean abort, nothing installed ----------
say "== case: dialog canceled"
W="$(mktemp -d)"; make_fake_machine "$W" api nobrew
printf 'cancel\n' > "$FAKE_STATE/osascript_answers"
run_piped_install
grep -q "Password dialog canceled" "$FAKE_STATE/run.out" \
  && pass "cancel: clean abort message" \
  || fail "cancel: no clean message (got: $(tail -1 "$FAKE_STATE/run.out" 2>/dev/null))"
if grep -q "run: mkdir -p /opt/homebrew" "$FAKE_STATE/sudo.log" 2>/dev/null; then
  fail "cancel: Homebrew was installed anyway"
else
  pass "cancel: nothing installed"
fi

# --- case 6: no GUI (SSH) — terminal fallback via /dev/tty ---------------------
say "== case: no GUI, terminal fallback"
W="$(mktemp -d)"; make_fake_machine "$W" api nobrew
printf 'nogui\n' > "$FAKE_STATE/osascript_answers"
printf 'hunter2\n' > "$W/tty-input"
export TTY_DEV="$W/tty-input"
run_piped_install; check_common tty-fallback
grep -q "seeded via stdin" "$FAKE_STATE/sudo.log" \
  && pass "tty: password read from the terminal device" \
  || fail "tty: fallback never delivered a password"
unset TTY_DEV

# --- case 7: the seeded sudo session stays fresh, then dies with the script ----
say "== case: sudo session kept alive, then dies with the script"
W="$(mktemp -d)"; make_fake_machine "$W" api nobrew
printf 'pw:hunter2\n' > "$FAKE_STATE/osascript_answers"
export SUDO_KEEPALIVE_SECS=1
run_piped_install
grep -q "run: true" "$FAKE_STATE/sudo.log" \
  && pass "keepalive: session refreshed during the run" \
  || fail "keepalive: never refreshed sudo"
sleep 2.5
n1="$(wc -l < "$FAKE_STATE/sudo.log" | tr -d ' ')"
sleep 1.3
n2="$(wc -l < "$FAKE_STATE/sudo.log" | tr -d ' ')"
[ "$n1" = "$n2" ] \
  && pass "keepalive: stopped after the script exited" \
  || fail "keepalive: still alive after exit ($n1 -> $n2)"
unset SUDO_KEEPALIVE_SECS

say
say "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
