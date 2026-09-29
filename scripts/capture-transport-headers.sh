#!/usr/bin/env bash
# Operator-authorized host capture only. Never invoke through a privileged container.
set -euo pipefail
umask 077
check=0
if [ "${1:-}" = --check ]; then check=1; shift; fi
[ "$#" = 9 ] || { echo 'Usage: [--check] IFACE LOCAL_IP LOCAL_PORT PEER_IP PEER_PORT PID INODE DIRECTORY SECONDS' >&2; exit 2; }
interface=$1; local_ip=$2; local_port=$3; peer_ip=$4; peer_port=$5
target_pid=$6; target_inode=$7; directory=$8; seconds=$9
[[ $interface =~ ^br-[a-f0-9]{12}$ ]] && [ "$(cat "/sys/class/net/$interface/type")" = 1 ] || exit 2
ip_hex() {
  local address=$1 a b c d
  [[ $address =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  IFS=. read -r a b c d <<< "$address"
  for octet in "$a" "$b" "$c" "$d"; do (( 10#$octet <= 255 )) || return 1; done
  printf '%02X%02X%02X%02X' "$((10#$d))" "$((10#$c))" "$((10#$b))" "$((10#$a))"
}
local_hex=$(ip_hex "$local_ip"); peer_hex=$(ip_hex "$peer_ip")
for number in "$local_port" "$peer_port" "$target_pid" "$target_inode" "$seconds"; do
  [[ $number =~ ^[1-9][0-9]{0,10}$ ]] || exit 2
done
(( local_port <= 65535 && peer_port <= 65535 && seconds <= 21600 )) || exit 2
printf -v local_tuple '%s:%04X' "$local_hex" "$local_port"
printf -v peer_tuple '%s:%04X' "$peer_hex" "$peer_port"
directory=$(realpath -e -- "$directory")
# Ubuntu's tcpdump profile explicitly denies home dot-directories, even when
# ordinary ownership allows writes. Use its existing owner /tmp allowance.
[[ $directory = /tmp/multiwa-mm-headers-* || $directory = /var/tmp/multiwa-mm-headers-* ]] || exit 2
owner=${SUDO_UID:-$(id -u)}
[ "$(stat -c %u "$directory")" = "$owner" ] && [ "$(stat -c %a "$directory")" = 700 ] || exit 2
[ -z "$(find "$directory" -mindepth 1 -maxdepth 1 -print -quit)" ] || { echo 'Use an empty capture directory' >&2; exit 2; }
socket_exists() {
  awk -v local="$local_tuple" -v peer="$peer_tuple" -v inode="$target_inode" \
    '$2 == local && $3 == peer && $10 == inode { found=1 } END { exit !found }' \
    "/proc/$target_pid/net/tcp" 2>/dev/null
}
[ -r "/proc/$target_pid/net/tcp" ] || { echo 'Target PID network table unavailable in this context; verify on the host' >&2; exit 2; }
socket_exists || { echo 'Selected socket no longer exists; re-identify before capturing' >&2; exit 2; }
has_reserve() { [ "$(df --output=avail -B1 "$directory" | tail -1)" -ge 2155872256 ]; }
has_reserve || { echo '2 GiB reserve plus capture headroom unavailable' >&2; exit 2; }
filter="ip and tcp and ((src host $local_ip and src port $local_port and dst host $peer_ip and dst port $peer_port) or (src host $peer_ip and src port $peer_port and dst host $local_ip and dst port $local_port))"
if [ "$check" = 1 ]; then
  printf 'Validated Ethernet IPv4 headers only: snaplen=54, ring=4 x 1MB, duration=%ss, inode=%s\nFilter: %s\n' "$seconds" "$target_inode" "$filter"
  exit 0
fi
[ "$(id -u)" = 0 ] && [ "$owner" != 0 ] || { echo 'Run this reviewed command through sudo; no alternate privilege route' >&2; exit 2; }
capture_user=$(getent passwd "$owner" | cut -d: -f1)
[ "$capture_user" = hermes ] || exit 2
install -o "$owner" -g "${SUDO_GID:?}" -m 600 /dev/null "$directory/capture-status.log"
# Refuse to capture if the private packet retention timer cannot be installed.
/usr/sbin/runuser -u "$capture_user" -- /usr/bin/env \
  XDG_RUNTIME_DIR="/run/user/$owner" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$owner/bus" \
  /usr/bin/systemd-run --user --unit="multiwa-header-expiry-${target_pid}-$(date +%s)" \
  --on-active=24h /usr/bin/find "$directory" -maxdepth 1 -type f \
  -name 'mm-headers.pcap*' -delete >>"$directory/capture-status.log" 2>&1
capture_pid=''
stop_capture() {
  if [ -n "$capture_pid" ] && kill -0 "$capture_pid" 2>/dev/null; then
    kill -INT "$capture_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do kill -0 "$capture_pid" 2>/dev/null || break; sleep 1; done
    kill -KILL "$capture_pid" 2>/dev/null || true
  fi
  wait "$capture_pid" 2>/dev/null || true
}
trap stop_capture EXIT
trap 'exit 0' INT TERM
# Ethernet + minimum IPv4 + minimum TCP headers = 54 bytes. Options may be
# truncated, but no TCP/TLS payload can be retained. No -A, -X or decryption.
/usr/bin/tcpdump -p -i "$interface" -Z "$capture_user" -nn -s 54 -C 1 -W 4 -U \
  -w "$directory/mm-headers.pcap" "$filter" >/dev/null \
  2> >(/usr/bin/head -c 65536 >>"$directory/capture-status.log") &
capture_pid=$!
deadline=$((SECONDS + seconds)); absent=0
while kill -0 "$capture_pid" 2>/dev/null && (( SECONDS < deadline )); do
  has_reserve || break
  if socket_exists; then absent=0; else absent=$((absent + 1)); fi
  (( absent < 6 )) || break
  sleep 5
done
if ! kill -0 "$capture_pid" 2>/dev/null; then
  set +e
  wait "$capture_pid"
  result=$?
  capture_pid=''
  exit "$result"
fi
