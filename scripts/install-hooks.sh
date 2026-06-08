#!/usr/bin/env bash
# Install git hooks for auto code review.
# Run: bash scripts/install-hooks.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_DIR="$ROOT/.git/hooks"

echo "Installing git hooks..."

# ---- post-commit: review staged changes after each commit ----
cat > "$HOOKS_DIR/post-commit" << 'HOOK'
#!/usr/bin/env bash
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
bash "$ROOT/scripts/auto-review.sh" --staged
HOOK
chmod +x "$HOOKS_DIR/post-commit"

# ---- post-merge: review files modified by merge ----
cat > "$HOOKS_DIR/post-merge" << 'HOOK'
#!/usr/bin/env bash
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
echo "--- Auto-reviewing merge changes ---"
bash "$ROOT/scripts/auto-review.sh"
HOOK
chmod +x "$HOOKS_DIR/post-merge"

# ---- pre-push: run lint + review before push ----
cat > "$HOOKS_DIR/pre-push" << 'HOOK'
#!/usr/bin/env bash
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel)"
echo "--- Running pre-push review ---"
bash "$ROOT/scripts/auto-review.sh" --staged
HOOK
chmod +x "$HOOKS_DIR/pre-push"

echo "Done. Installed hooks:"
echo "  - post-commit  (reviews each commit)"
echo "  - post-merge   (reviews merge changes)"
echo "  - pre-push     (reviews before push)"
echo ""
echo "To trigger a review manually:"
echo "  pnpm run review           # review working tree changes"
echo "  pnpm run review:staged    # review staged (commit-ready) changes"
echo "  pnpm run review:all       # review entire codebase"
