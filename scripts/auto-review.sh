#!/usr/bin/env bash
# Auto code review — detects local changes and writes structured review notes.
#
# Usage:
#   bash scripts/auto-review.sh              # review unstaged + staged changes
#   bash scripts/auto-review.sh --staged     # review only staged (commit-ready)
#   bash scripts/auto-review.sh --all        # review full codebase
#
# The review is written to code-review/review-<timestamp>.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p code-review

REVIEW_MODE="${1:-diff}"
TIMESTAMP="$(date +%Y%m%d-%H%M)"
OUTFILE="code-review/review-${TIMESTAMP}"

# ---- helpers ----
section() {
  echo "" >> "$OUTFILE"
  echo "## $1" >> "$OUTFILE"
  echo "" >> "$OUTFILE"
}

warn() {
  echo "- [ ] **$1** — $2" >> "$OUTFILE"
}

info() {
  echo "- [x] $1 — $2" >> "$OUTFILE"
}

codeblock() {
  echo '```' >> "$OUTFILE"
  head -c 2000 <<< "$1" >> "$OUTFILE" 2>/dev/null || echo "$1" | head -c 2000 >> "$OUTFILE"
  echo '```' >> "$OUTFILE"
}

changed_files() {
  case "$REVIEW_MODE" in
    --staged) git diff --cached --name-only ;;
    --all) git ls-files ;;
    *) git diff --name-only; git diff --cached --name-only ;;
  esac | sort -u
}

changed_diff() {
  case "$REVIEW_MODE" in
    --staged) git diff --cached ;;
    --all) ;;
    *) git diff; git diff --cached ;;
  esac
}

# ---- gather context ----
DIFF="$(changed_diff)"
FILES="$(changed_files)"
FILE_COUNT="$(echo "$FILES" | grep -c . || true)"

{
  echo "# Code Review — ${TIMESTAMP}"
  echo ""
  echo "**Mode:** ${REVIEW_MODE}  "
  echo "**Files changed:** ${FILE_COUNT}  "
  echo ""
} > "$OUTFILE"

echo "Scanning ${FILE_COUNT} changed file(s)..."

# ---- 1. Changed files ----
section "Changed Files"
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ -f "$f" ]; then
    echo "- \`$f\` ($(wc -l < "$f") lines)" >> "$OUTFILE"
  fi
done <<< "$FILES"

# ---- 2. Diff summary ----
section "Diff Summary"
codeblock "$DIFF"

# ---- 3. Pattern checks ----
section "Pattern Checks"

## 3a. Hardcoded success in message handlers (known bug pattern)
grep -rn 'success: true' --include='*.ts' "$ROOT/apps" "$ROOT/packages" 2>/dev/null \
  | grep -v '.d.ts' \
  | grep -v '__tests__' \
  | grep -v node_modules \
  | grep -v '\.next' \
  | grep -v '.turbo' \
  | while IFS=: read -r file line match; do
  rel="${file#$ROOT/}"
  # flag if success:true is unconditional (not inside a real success branch)
  if echo "$match" | grep -q 'success: true'; then
    warn "Unconditional success" "\`$rel:$line\` — \`success: true\` without checking engine result (see known bug in messages.service.ts)"
  fi
done

## 3b. Promise.race without cleanup (known bug pattern)
grep -rn 'Promise\.race' --include='*.ts' "$ROOT/apps" "$ROOT/packages" 2>/dev/null \
  | grep -v '.d.ts' \
  | grep -v '__tests__' \
  | grep -v node_modules \
  | while IFS=: read -r file line match; do
  rel="${file#$ROOT/}"
  warn "Promise.race" "\`$rel:$line\` — verify timeout doesn't orphan resources (see known connectProfile bug)"
done

## 3c. catch blocks that silently swallow errors
grep -rn 'catch' --include='*.ts' "$ROOT/apps" "$ROOT/packages" 2>/dev/null \
  | grep -v '.d.ts' \
  | grep -v '__tests__' \
  | grep -v node_modules \
  | grep -v '\.next' \
  | grep -v '.turbo' \
  | grep -E '(console\.(error|warn)|catch\s*(\{|\(\)).*\{\s*\})' \
  | while IFS=: read -r file line match; do
  rel="${file#$ROOT/}"
  if echo "$match" | grep -qE 'catch\s*(\{|\(\)).*\{\s*\}\s*$'; then
    warn "Empty catch block" "\`$rel:$line\` — silently swallows errors"
  fi
done

## 3d. console.log left in production code
grep -rn 'console\.log' --include='*.ts' "$ROOT/apps" "$ROOT/packages" 2>/dev/null \
  | grep -v '.d.ts' \
  | grep -v '__tests__' \
  | grep -v node_modules \
  | grep -v '\.next' \
  | grep -v '.turbo' \
  | grep -v 'console\.error' \
  | while IFS=: read -r file line match; do
  rel="${file#$ROOT/}"
  info "console.log" "\`$rel:$line\` — debug log in production code"
done

## 3e. Hardcoded timeouts / magic numbers
grep -rnE '[0-9]{4,}\s*(\* 1000|[;,\)])' --include='*.ts' "$ROOT/apps" "$ROOT/packages" 2>/dev/null \
  | grep -v '.d.ts' \
  | grep -v '__tests__' \
  | grep -v node_modules \
  | grep -v '\.next' \
  | grep -v '.turbo' \
  | grep -v '3000' \
  | grep -v '60000' \
  | while IFS=: read -r file line match; do
  rel="${file#$ROOT/}"
  warn "Magic number" "\`$rel:$line\` — large literal may be a hardcoded timeout"
done

# ---- 4. Lint check on changed files ----
section "Lint Results"
if command -v npx &>/dev/null && [ -f "$ROOT/tsconfig.json" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *.ts|*.tsx) ;;
      *) continue ;;
    esac
    out="$(npx tsc --noEmit --pretty 2>&1 | head -20)" || true
    if [ -n "$out" ]; then
      codeblock "$out"
    fi
  done <<< "$FILES"
else
  echo "(typescript compiler not available)" >> "$OUTFILE"
fi

# ---- 5. Summary ----
BUG_COUNT="$(grep -c '^- \[ \]' "$OUTFILE" || true)"
PASS_COUNT="$(grep -c '^- \[x\]' "$OUTFILE" || true)"
TOTAL=$((BUG_COUNT + PASS_COUNT))

{
  echo ""
  echo "---"
  echo "**Review complete.** ${BUG_COUNT} issue(s) flagged, ${PASS_COUNT} info(s)."
  echo "**Review saved to:** \`${OUTFILE}\`"
} >> "$OUTFILE"

echo ""
echo "=== Review complete ==="
echo "  Issues flagged: ${BUG_COUNT}"
echo "  Info items:     ${PASS_COUNT}"
echo "  Saved to:       ${OUTFILE}"
