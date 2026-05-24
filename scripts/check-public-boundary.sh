#!/usr/bin/env bash
# Release gate: public boundary scan.
#
# This is a public-safe scanner. It must NOT hardcode internal hostnames,
# IPs, passwords, or operator-specific markers. Instead it runs a small set
# of generic patterns against tracked files and fails when something that
# looks like a real secret, a merge conflict, or a private network literal
# appears in committed/staged content.
#
# Implementation notes:
#   - Uses `git ls-files` so only tracked content is scanned; untracked files
#     (BLAST memory, internal SOPs, .tmp/, sessions/, etc.) are out of scope
#     by construction and cannot reach a public push.
#   - Uses GNU/BSD `grep -nE` (POSIX ERE). No PCRE so no `\b` or `\d`.
#   - Per-pattern loops, not one big alternation, because long shell-quoted
#     alternations have been observed to silently match zero on some hosts.
#
# Exit codes:
#   0 - no hard-fail issues
#   1 - at least one hard-fail issue
#
# Usage:
#   bash scripts/check-public-boundary.sh

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "::error::git is required."
  exit 1
fi
if ! command -v grep >/dev/null 2>&1; then
  echo "::error::grep is required."
  exit 1
fi

# Exclude vendor/build/cache/session paths even though git ls-files already
# filters most of them. Keep this list small and obvious.
SKIP_REGEX='^(node_modules|.*/node_modules|dist|.*/dist|build|.*/build|\.next|.*/\.next|\.turbo|.*/\.turbo|\.pnpm-store|coverage|.*/coverage|sessions|.*/sessions|apps/api/sessions|apps/api/\.wwebjs_cache|\.wwebjs_auth|\.wwebjs_cache|docs-site/build|docs-site/\.docusaurus|\.tmp)/'

# Files that legitimately contain pattern text (examples, docs, snapshots).
# Substring match against the file path.
ALLOWLIST_FILES=(
  'CHANGELOG.md'
  'README.md'
  'SECURITY.md'
  'docs/'
  'docs-site/docs/'
  '.env.example'
  '.env.docker'
  '.env.production.example'
  '.env.server.example'
  'docker-compose.yml'
  'docker-compose.dev.yml'
  'docker-compose.production.yml'
  'docker-compose.staging.yml'
  'docker/'
  'apps/api/src/'
  'apps/admin/src/'
  'apps/worker/src/'
  'apps/api/test/'
  'apps/admin/app/'
  'packages/'
  'scripts/'
  'tools/'
  '.github/'
  'plugins/'
)

# Tokens that mark a value as a known placeholder rather than a real secret.
PLACEHOLDER_REGEX='change|placeholder|example|todo|fixme|your-|here|dev-|test-|demo|xxx|<.*>|\$\{|process\.env|null|undefined|minio123|minioadmin'

EXIT=0
TOTAL_HITS=0
SCRIPT_NAME="$(basename "$0")"

is_allowlisted() {
  local p="$1"
  local entry
  for entry in "${ALLOWLIST_FILES[@]}"; do
    case "$p" in
      *"$entry"*) return 0 ;;
    esac
  done
  return 1
}

# tracked_files writes the list of tracked file paths (NUL-separated).
tracked_files() {
  git ls-files -z | tr '\0' '\n' | grep -Ev "$SKIP_REGEX" || true
}

report() {
  local sev="$1" cat="$2" loc="$3" snippet="$4"
  TOTAL_HITS=$((TOTAL_HITS + 1))
  if [ "$sev" = "error" ]; then
    EXIT=1
    echo "::error file=${loc%%:*}::[$cat] $loc :: $snippet"
  else
    echo "::warning file=${loc%%:*}::[$cat] $loc :: $snippet"
  fi
}

scan_files_for_pattern() {
  # Args: pattern, category, severity, allowlist_behavior
  #   allowlist_behavior = "downgrade" (warn instead of error) or "skip"
  local pattern="$1" category="$2" severity="$3" allow="$4"
  local file line
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      "scripts/$SCRIPT_NAME") continue ;;
    esac
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      if is_allowlisted "$file"; then
        if [ "$allow" = "skip" ]; then
          continue
        fi
        report warning "${category}-in-docs" "$file:$line" "<allowlisted file; verify placeholder>"
        continue
      fi
      report "$severity" "$category" "$file:$line" "<redacted; investigate>"
    done < <(grep -nE -- "$pattern" "$file" 2>/dev/null | cut -d: -f1)
  done < <(tracked_files)
}

scan_files_for_fixed_string() {
  # Args: literal-string, category, severity, allowlist_behavior
  local needle="$1" category="$2" severity="$3" allow="$4"
  local file line
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    case "$file" in
      "scripts/$SCRIPT_NAME") continue ;;
    esac
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      if is_allowlisted "$file"; then
        if [ "$allow" = "skip" ]; then
          continue
        fi
        report warning "${category}-in-docs" "$file:$line" "<allowlisted file; verify placeholder>"
        continue
      fi
      report "$severity" "$category" "$file:$line" "<redacted; investigate>"
    done < <(grep -nF -- "$needle" "$file" 2>/dev/null | cut -d: -f1)
  done < <(tracked_files)
}

echo "== Hard fail: PEM private key blocks =="
for pat in 'BEGIN RSA PRIVATE KEY' 'BEGIN OPENSSH PRIVATE KEY' 'BEGIN PRIVATE KEY' 'BEGIN ENCRYPTED PRIVATE KEY' 'BEGIN DSA PRIVATE KEY' 'BEGIN EC PRIVATE KEY'; do
  scan_files_for_fixed_string "$pat" "private-key-block" "error" "downgrade"
done

echo "== Hard fail: merge conflict markers =="
# Match the start markers <<<<<<< and >>>>>>>. We deliberately do NOT match
# '=======' alone because it is a common Markdown heading separator.
scan_files_for_fixed_string '<<<<<<<' 'conflict-marker' 'error' 'skip'
scan_files_for_fixed_string '>>>>>>>' 'conflict-marker' 'error' 'skip'

echo "== Hard fail: RFC1918 private IP literals (non-docs) =="
# POSIX ERE: \b is not portable; we anchor with surrounding non-digit using
# character classes. The pattern matches a.b.c.d where the prefix is private.
PRIV_IP_PATTERN='(^|[^0-9.])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9.]|$)'
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    "scripts/$SCRIPT_NAME") continue ;;
  esac
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    line_no="${match%%:*}"
    # Treat doc references to the standard /8, /12, /16 CIDR strings as harmless.
    if echo "$match" | grep -qE '(10\.0\.0\.0/8|172\.16\.0\.0/12|192\.168\.0\.0/16)'; then
      continue
    fi
    if is_allowlisted "$file"; then
      report warning "private-ip-in-docs" "$file:$line_no" "<verify the IP is generic>"
      continue
    fi
    report error "private-ip-literal" "$file:$line_no" "<RFC1918 IP in non-doc tracked file>"
  done < <(grep -nE -- "$PRIV_IP_PATTERN" "$file" 2>/dev/null)
done < <(tracked_files)

echo "== Soft warn: credential-like assignments (non-allowlisted files) =="
CRED_PATTERN='(password|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9+/=._-]{16,}"?'
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    "scripts/$SCRIPT_NAME") continue ;;
  esac
  if is_allowlisted "$file"; then
    continue
  fi
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    if echo "$match" | grep -qEi -- "$PLACEHOLDER_REGEX"; then
      continue
    fi
    line_no="${match%%:*}"
    report warning "possible-credential-assignment" "$file:$line_no" "<value looks opaque>"
  done < <(grep -inE -- "$CRED_PATTERN" "$file" 2>/dev/null)
done < <(tracked_files)

echo "== Soft warn: .env-style assignments in non-env tracked files =="
ENV_LEAK_PATTERN='^[[:space:]]*[A-Z][A-Z0-9_]{3,}=[A-Za-z0-9+/=._:@-]{12,}[[:space:]]*$'
while IFS= read -r file; do
  [ -z "$file" ] && continue
  case "$file" in
    "scripts/$SCRIPT_NAME") continue ;;
    *.env*|*/.env*) continue ;;
    *Dockerfile*|*docker-compose*|*.yml|*.yaml) continue ;;
  esac
  if is_allowlisted "$file"; then
    continue
  fi
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    if echo "$match" | grep -qEi -- "$PLACEHOLDER_REGEX"; then
      continue
    fi
    line_no="${match%%:*}"
    report warning "env-style-leak" "$file:$line_no" "<KEY=value in non-env file>"
  done < <(grep -nE -- "$ENV_LEAK_PATTERN" "$file" 2>/dev/null)
done < <(tracked_files)

echo ""
if [ "$EXIT" -eq 0 ]; then
  echo "Public boundary scan PASSED. ($TOTAL_HITS finding(s) reported, none are hard-fails.)"
else
  echo "Public boundary scan FAILED. ($TOTAL_HITS finding(s) reported, including at least one hard-fail.)"
fi

exit "$EXIT"
