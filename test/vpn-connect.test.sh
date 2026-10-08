#!/bin/bash
# Runs vpn-connect.exp for real, with a fake `sudo` first on PATH.
# The fake records the exact arguments openconnect would receive and answers
# the sudo, username and password prompts. No root and no network needed.
#
# Credentials are NOT on the command line: as in production (issue #4), they
# go to the script's stdin as three percent-encoded lines plus a fourth line
# holding the sudo-prompt nonce, and every case asserts the credentials
# appear nowhere in the recorded argv of the spawned sudo.
#
# Usage: npm run test:expect

set -u

# The script pins `encoding system utf-8`, but give this harness the same
# locale so bash string comparisons see the same bytes for non-ASCII values.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

repo="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo/vpn-connect.exp"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# percent-encode an ASCII string exactly like JS encodeURIComponent:
# unreserved characters stay raw, everything else becomes uppercase %XX.
# (Multibyte input would need UTF-8 byte splitting, which bash makes awkward
# -- the non-ASCII cases below hand-write their encoded forms instead.)
enc() {
  local s=$1 out="" i ch code
  local safe='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'"'"'()'
  for ((i = 0; i < ${#s}; i++)); do
    ch=${s:i:1}
    if [[ "$safe" == *"$ch"* ]]; then
      out+=$ch
    else
      printf -v code '%%%02X' "'$ch"
      out+=$code
    fi
  done
  printf '%s' "$out"
}

mkdir -p "$tmp/bin"
cat > "$tmp/bin/sudo" <<'FAKE'
#!/bin/bash
# Stands in for `sudo` in both forms the expect script uses:
#   sudo -k                               -> record a "k" line, drop the fake cache
#   sudo -S -p sudo-prompt-<nonce>: CMD   -> answer the prompts, record everything
# The -p prompt is printed verbatim, as real sudo would, so the script has to
# match the nonce'd prompt itself to deliver the sudo password (issue #36).
# FAKE_ORDER=password-first asks the VPN Password: before Username: -- the
# issue #36 hostile shape. FAKE_FORGE=1 swaps that first VPN prompt for a
# forged wrong nonce, which must never be answered with the sudo password.
#
# get LABEL: read one answer line. Bounded wait, so a prompt the script never
# answers records an empty value instead of hanging until the 20s kill.
get() {
  local label=$1 v=""
  IFS= read -t 5 -r v
  printf '%s:%s\n' "$label" "${v%$'\r'}" >> "$FAKE_OUT.input"
}
stty -echo 2>/dev/null
if [ "$1" = "-k" ]; then
  printf 'k\n' >> "$FAKE_OUT.sudolog"
  : > "$FAKE_OUT.cached"
  exit 0
fi
printf 'spawn\n' >> "$FAKE_OUT.sudolog"
: > "$FAKE_OUT.argv"
for a in "$@"; do printf '%s\0' "$a" >> "$FAKE_OUT.argv"; done
prompt=Password:
while [ $# -gt 0 ]; do
  case "$1" in
    -S) shift ;;
    -p) prompt=$2; shift 2 ;;
    *) break ;;
  esac
done
# Only skip the prompt if a timestamp was cached AND no -k has run since:
# the script always runs -k first, so in practice the prompt always appears
# (that is the issue #36 guarantee this suite checks).
if [ -z "${FAKE_SUDO_CACHED:-}" ] || [ -e "$FAKE_OUT.cached" ]; then
  printf '%s' "$prompt"; get sudo
fi
if [ -n "${FAKE_SUDO_RETRY:-}" ]; then
  # sudo on a wrong password re-issues the same -p prompt. Silent retry, as
  # a non-English locale would produce (no "Sorry, try again"): the script's
  # only failure signal left is the repeated nonce'd prompt itself.
  printf '%s' "$prompt"; get sudo2
fi
if [ "${FAKE_ORDER:-}" = password-first ]; then
  if [ -n "${FAKE_FORGE:-}" ]; then
    printf 'sudo-prompt-ffffffffffffffffffffffffffffffff:'; get forged
  else
    printf 'Password:'; get vpn
  fi
  printf 'Username:'; get user
  printf 'Password:'; get vpn
else
  printf 'Username:'; get user
  printf 'Password:'; get vpn
fi
echo "CONNECTED"
FAKE
chmod +x "$tmp/bin/sudo"

passed=0
failed=0

# Per-case settings; reset after every case. Encoded forms are derived from
# the plain values in run_case; a *_over hook supplies the bytes by hand where
# the value is not ASCII (enc() cannot split UTF-8 the way JS does).
sudo_pw=SUDOPW
vpn_user=alice
vpn_pw=VPNPW
enc_sudo_over=""
enc_user_over=""
enc_pw_over=""
input_override=""
cached=""
order=""
forge=""
reset_settings() {
  sudo_pw=SUDOPW; vpn_user=alice; vpn_pw=VPNPW
  enc_sudo_over=""; enc_user_over=""; enc_pw_over=""
  input_override=""
  cached=""
  order=""
  forge=""
}

# run_case NAME OPENCONNECT_PATH ARG...
# Feeds the three encoded credential lines plus a fresh nonce on stdin and
# checks that openconnect gets `-S`, `-p sudo-prompt-<nonce>:`, the path and
# every ARG unchanged, one argument each; that no credential is in the
# recorded argv; that `sudo -k` ran before the spawn; and that the prompts
# are answered in order.
run_case() {
  local name="$1"; shift
  local oc="$1"; shift
  local out="$tmp/$name"
  local log="$out.log"

  local e_sudo e_user e_pw
  e_sudo=$(enc "$sudo_pw"); e_user=$(enc "$vpn_user"); e_pw=$(enc "$vpn_pw")
  [ -n "$enc_sudo_over" ] && e_sudo=$enc_sudo_over
  [ -n "$enc_user_over" ] && e_user=$enc_user_over
  [ -n "$enc_pw_over" ] && e_pw=$enc_pw_over

  # Line 4 is the nonce main.js draws per attempt (crypto.randomBytes(16) as
  # hex); /dev/urandom gives the same shape here. The fake sudo echoes it
  # back inside its -p prompt, exactly as real sudo would.
  local nonce
  nonce="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

  printf '%s\n%s\n%s\n%s\n' "$e_sudo" "$e_user" "$e_pw" "$nonce" \
    | PATH="$tmp/bin:$PATH" FAKE_OUT="$out" FAKE_SUDO_CACHED="$cached" \
      FAKE_ORDER="$order" FAKE_FORGE="$forge" \
      expect "$script" "$oc" "$@" > "$log" 2>&1 &
  local pid=$!
  # Stop a hung run after 20 seconds. Polls instead of one long sleep, so no
  # stray sleep outlives the case and holds a piped test run open.
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 200 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null

  local expected=(-S -p "sudo-prompt-$nonce:" "$oc" "$@")
  local got=()
  if [ -f "$out.argv" ]; then
    while IFS= read -r -d '' a; do got+=("$a"); done < "$out.argv"
  fi

  local problem=""
  if [ "${#got[@]}" -ne "${#expected[@]}" ]; then
    problem="openconnect got ${#got[@]} arguments, expected ${#expected[@]}"
  else
    local i
    for i in "${!expected[@]}"; do
      [ "${got[$i]}" = "${expected[$i]}" ] && continue
      problem="argument $i is <${got[$i]}>, expected <${expected[$i]}>"
      break
    done
  fi

  # The point of the stdin transport (issue #4): no credential anywhere in
  # the spawned argv, however hostile the value.
  if [ "${#got[@]}" -gt 0 ]; then
    local cred a
    for cred in "$sudo_pw" "$vpn_user" "$vpn_pw"; do
      for a in "${got[@]}"; do
        [ "$a" = "$cred" ] && problem="credential <$cred> appears in sudo argv"
      done
    done
  fi

  # Issue #36: -k must run first, so the sudo prompt is always the first
  # thing answered.
  if [ -z "$problem" ] && [ "$(cat "$out.sudolog" 2>/dev/null)" != "$(printf 'k\nspawn')" ]; then
    problem="sudo invocations were <$(tr '\n' ' ' < "$out.sudolog" 2>/dev/null)>, wanted k before spawn"
  fi

  # The sudo line is always answered now: -k runs before every spawn, so a
  # cached timestamp can never suppress the prompt (issue #36).
  local want_input="sudo:$sudo_pw"$'\n'"user:$vpn_user"$'\n'"vpn:$vpn_pw"
  [ -n "$input_override" ] && want_input="$input_override"
  if [ -z "$problem" ] && [ "$(cat "$out.input" 2>/dev/null)" != "$want_input" ]; then
    problem="prompts answered as <$(cat "$out.input" 2>/dev/null | tr '\n' ' ')>"
  fi
  if [ -z "$problem" ] && ! grep -q "VPN connection established" "$log"; then
    problem="script did not reach the connected state"
  fi

  if [ -n "$problem" ]; then
    failed=$((failed + 1))
    echo "FAIL $name: $problem"
    [ "${#got[@]}" -gt 0 ] && printf '     got: %s\n' "$(printf '<%s> ' "${got[@]}")"
    reset_settings
    return
  fi
  passed=$((passed + 1))
  echo "PASS $name"
  reset_settings
}

# --- pdecode unit cases -----------------------------------------------------
# Extract the proc verbatim from the script so these cases test the real
# implementation, not a copy that could drift from it.
pd_src="$tmp/pdecode.tcl"
awk '/^proc pdecode /,/^}$/' "$script" > "$pd_src"
if ! grep -q '^proc pdecode ' "$pd_src" || ! grep -q '^}$' "$pd_src"; then
  failed=$((failed + 1))
  echo "FAIL pdecode-extract: proc not found verbatim in vpn-connect.exp"
fi

# pd_case NAME ENCODED EXPECTED — decode through the extracted proc. The END
# sentinel survives $() stripping, so values ending in newline still compare.
pd_case() {
  local name="$1" in="$2" want="$3"
  local got
  got="$(PDECODE_SRC="$pd_src" PDECODE_IN="$in" \
    expect -c 'source $env(PDECODE_SRC); puts "[pdecode $env(PDECODE_IN)]END"; exit' 2>&1)"
  if [ "$got" != "$want"'END' ]; then
    failed=$((failed + 1))
    echo "FAIL pdecode-$name: got <$(printf '%s' "$got" | tr '\n' '~')>, wanted <$(printf '%s' "$want" | tr '\n' '~')>"
    return
  fi
  passed=$((passed + 1))
  echo "PASS pdecode-$name"
}

pd_case empty '' ''
pd_case plain 'abc' 'abc'
pd_case space 'a%20b' 'a b'
pd_case percent 'a%25b%25c' 'a%b%c'
pd_case ampersand 'x%26y' 'x&y'
pd_case double-quote 'say%22hi%22' 'say"hi"'
pd_case backslash 'a%5Cb' 'a\b'
pd_case newline 'x%0Ay' "$(printf 'x\ny')"
pd_case cr 'a%0Db' "$(printf 'a\rb')"
pd_case lowercase-hex '%6a%0a%4a' "$(printf 'j\nJ')"
pd_case utf8-2byte 'p%C3%A4ss' 'päss'
pd_case utf8-3byte 'ok%E2%9C%93' 'ok✓'
pd_case stray-percent 'a%zz' 'a%zz'
pd_case trailing-percent 'ab%' 'ab%'

# Round-trip: the bash encoder against the Tcl decoder on a nasty value.
rt='100% &"done" \{$env(HOME)\} [exec id]'
pd_case roundtrip "$(enc "$rt")" "$rt"

# --- end-to-end cases -------------------------------------------------------
oc=/opt/homebrew/bin/openconnect
base=(--reconnect-timeout 60 --dtls-ciphers DEFAULT)
server=--server=https://vpn.example.com

run_case benign "$oc" -s /opt/homebrew/etc/vpnc/vpnc-script --protocol=anyconnect "$server" "${base[@]}"

run_case space-in-server "$oc" --protocol=anyconnect "--server=https://vpn.example.com --script=/tmp/x.sh" "${base[@]}"

run_case command-substitution "$oc" --protocol=anyconnect "$server" --servercert "[exec touch $tmp/pwned]" "${base[@]}"
if [ -e "$tmp/pwned" ]; then
  failed=$((failed + 1))
  echo "FAIL command-substitution: the bracketed command ran"
fi

run_case variable-substitution "$oc" --protocol=anyconnect "$server" '--authgroup=$env(HOME)' "${base[@]}"

run_case quoting-characters "$oc" --protocol=anyconnect "$server" '--authgroup=a{b"c\d;e' "${base[@]}"

run_case space-in-path "$tmp/with space/openconnect" --protocol=anyconnect "$server" "${base[@]}"

run_case all-options "$oc" -s /opt/homebrew/etc/vpnc/vpnc-script --protocol=gp "$server" --servercert pin-sha256:abc= --authgroup=Staff "${base[@]}"

run_case literal-expand "$oc" --protocol=anyconnect "$server" --servercert '{*}$env(HOME)' "${base[@]}"

run_case newlines "$oc" --protocol=anyconnect "$server" $'--authgroup=a\nb' $'--servercert=c\\\nd' "${base[@]}"

run_case metachar-path "$tmp/br[a]ce\$x;{y/openconnect" --protocol=anyconnect "$server" "${base[@]}"

vpn_user=-alice; vpn_pw=-secret; sudo_pw=-sudo
run_case dash-credentials "$oc" --protocol=anyconnect "$server" "${base[@]}"

sudo_pw='s [pwd] $x {'; vpn_user='a b$[x]{y}\\'; vpn_pw='p w$env(HOME)[exec id]{"'
run_case tcl-in-credentials "$oc" --protocol=anyconnect "$server" "${base[@]}"

# Issue #36: even when a timestamp would be cached, -k runs first, so the
# sudo prompt still appears and is the first thing answered.
cached=1
run_case sudo-cached-still-prompts "$oc" --protocol=anyconnect "$server" "${base[@]}"

# Issue #36, the leak itself: a password-first VPN server (Password: before
# Username:) must have its prompt answered with the VPN password. Only the
# nonce'd sudo prompt is ever answered with the macOS password, so SUDOPW
# appears exactly once, at the sudo line.
order=password-first
input_override="sudo:SUDOPW"$'\n'"vpn:VPNPW"$'\n'"user:alice"$'\n'"vpn:VPNPW"
run_case password-first-server "$oc" --protocol=anyconnect "$server" "${base[@]}"

# A forged sudo-prompt marker -- a wrong nonce, as a server that read the
# script's source would emit -- is answered with nothing at all: the forged
# line records empty, and the macOS password stays on the one real sudo line.
order=password-first forge=1
input_override="sudo:SUDOPW"$'\n'"forged:"$'\n'"user:alice"$'\n'"vpn:VPNPW"
run_case forged-sudo-marker "$oc" --protocol=anyconnect "$server" "${base[@]}"

# A wrong sudo password must abort, not resend: when sudo silently re-issues
# the nonce'd prompt (non-English locales drop "Sorry, try again"), the
# second nonce match is itself the failure signal. The macOS password is
# sent exactly once.
wp="$tmp/wrongpw"
FAKE_OUT="$wp" FAKE_SUDO_RETRY=1 PATH="$tmp/bin:$PATH" \
  expect "$script" "$oc" --protocol=anyconnect "$server" "${base[@]}" \
  < <(printf 'WRONGPW\nalice\nVPNPW\n%s\n' "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')") \
  > "$wp.log" 2>&1
wp_ok=1
grep -q 'Incorrect sudo password' "$wp.log" || wp_ok=0
# The macOS password must have been submitted exactly once: the input file
# holds a single sudo line and nothing else. (The re-prompt's own record is
# unreliable -- expect's exit closes the pty and SIGHUPs the fake mid-read,
# so assert on what was answered, not on what was asked.)
[ -s "$wp.input" ] || wp_ok=0
[ "$(wc -l < "$wp.input" 2>/dev/null)" -eq 1 ] || wp_ok=0
grep -q '^sudo:WRONGPW$' "$wp.input" 2>/dev/null || wp_ok=0
if [ "$wp_ok" -eq 1 ]; then
  passed=$((passed + 1)); echo "PASS wrong-sudo-password-aborts"
else
  failed=$((failed + 1)); echo "FAIL wrong-sudo-password-aborts: input <$(tr '\n' ' ' < "$wp.input" 2>/dev/null)>, log has <$(grep -c 'Incorrect sudo password' "$wp.log")> error lines"
fi

# Percent-decoding of the credential values themselves, end to end.
vpn_pw='p w'
run_case creds-space "$oc" --protocol=anyconnect "$server" "${base[@]}"

vpn_pw='100%safe'
run_case creds-percent "$oc" --protocol=anyconnect "$server" "${base[@]}"

vpn_pw='a&b="c\d'
run_case creds-amp-quote-backslash "$oc" --protocol=anyconnect "$server" "${base[@]}"

# Non-ASCII: encodeURIComponent emits UTF-8 byte groups; hand-written because
# enc() only handles ASCII.
vpn_pw='pässwörd'; enc_pw_over='p%C3%A4ssw%C3%B6rd'
run_case creds-unicode "$oc" --protocol=anyconnect "$server" "${base[@]}"

# A literal newline in the password decodes before the send, so the fake sees
# it split ("vpn:p" plus a stray "w" it never reads) -- an undecoded value
# would arrive as the single line "vpn:p%0Aw" instead.
vpn_pw=$'p\nw'; enc_pw_over='p%0Aw'
input_override="sudo:SUDOPW"$'\n'"user:alice"$'\n'"vpn:p"
run_case creds-newline "$oc" --protocol=anyconnect "$server" "${base[@]}"

# All three fields hostile at once.
sudo_pw='50% off'; vpn_user='bob&"x"'; vpn_pw=$'q\\r%'
run_case creds-nasty-all-fields "$oc" --protocol=anyconnect "$server" "${base[@]}"

echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
