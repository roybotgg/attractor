#!/bin/bash
# Run the generic issue pipeline against a GitHub repo issue.
#
# Usage:
#   ./run-issue.sh <issue-number> [repo-path]
#
# Examples:
#   ./run-issue.sh 57                              # uses default repo
#   ./run-issue.sh 57 /home/rey/clawd/localrank-city
#
# Environment variables (override defaults):
#   ATTRACTOR_MODEL     Model alias (default: normal)
#   ATTRACTOR_THINKING  Thinking level (default: low)
#   ATTRACTOR_TIMEOUT   Timeout per stage in seconds (default: 600)
#   CXDB_ENABLED        Set to 1 to enable CXDB tracking (default: 1)
#   CXDB_HTTP_PORT      CXDB HTTP port (default: 9010)

set -euo pipefail

# Enable CXDB tracking by default
export CXDB_ENABLED="${CXDB_ENABLED:-1}"
export CXDB_HTTP_PORT="${CXDB_HTTP_PORT:-9010}"

ISSUE_NUMBER="${1:?Usage: ./run-issue.sh <issue-number> [repo-path]}"
ORIG_REPO_PATH="${2:-/home/rey/clawd/localrank-city}"

# Derive repo slug from git remote
REPO_SLUG=$(cd "$ORIG_REPO_PATH" && git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')

# Construct issue URL
ISSUE_URL="https://github.com/${REPO_SLUG}/issues/${ISSUE_NUMBER}"

# Create an isolated git worktree so the pipeline doesn't conflict with other
# branches checked out in the main repo.  The worktree is created off main in
# a sibling directory named after the branch.
BRANCH_NAME="fix/${ISSUE_NUMBER}"
WORKTREE_DIR="${ORIG_REPO_PATH}-worktrees/fix-${ISSUE_NUMBER}"

echo "Issue:  $ISSUE_URL"
echo "Repo:   $ORIG_REPO_PATH ($REPO_SLUG)"
echo "Branch: $BRANCH_NAME"
echo "Work:   $WORKTREE_DIR"
echo ""

# Auto-initialize repo if needed (idempotent)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SCRIPT_DIR/init-repo.sh" ]; then
  "$SCRIPT_DIR/init-repo.sh" "$ORIG_REPO_PATH"
  echo ""
fi

# Ensure main is up to date
(cd "$ORIG_REPO_PATH" && git fetch origin main)

# Create worktree (idempotent — skip if it already exists)
if [ ! -d "$WORKTREE_DIR" ]; then
  mkdir -p "$(dirname "$WORKTREE_DIR")"
  (cd "$ORIG_REPO_PATH" && git worktree add -b "$BRANCH_NAME" "$WORKTREE_DIR" origin/main 2>/dev/null) || \
  (cd "$ORIG_REPO_PATH" && git worktree add "$WORKTREE_DIR" "$BRANCH_NAME" 2>/dev/null) || \
  { echo "ERROR: Failed to create worktree"; exit 1; }
fi

# Install deps in worktree if node_modules missing
if [ ! -d "$WORKTREE_DIR/node_modules" ]; then
  echo "Installing dependencies in worktree..."
  (cd "$WORKTREE_DIR" && npm install --ignore-scripts 2>/dev/null) || true
fi

# Pipeline works in the worktree, not the original repo
REPO_PATH="$WORKTREE_DIR"

export ISSUE_NUMBER ISSUE_URL REPO_PATH REPO_SLUG ORIG_REPO_PATH BRANCH_NAME

# Write pipeline metadata to a file in the worktree so OpenClaw node sessions
# (which don't inherit shell env vars) can read it during the publish stage.
mkdir -p "$WORKTREE_DIR/.factory"
cat > "$WORKTREE_DIR/.factory/pipeline-env.sh" <<EOF
export ISSUE_NUMBER="$ISSUE_NUMBER"
export ISSUE_URL="$ISSUE_URL"
export REPO_PATH="$WORKTREE_DIR"
export REPO_SLUG="$REPO_SLUG"
export BRANCH_NAME="$BRANCH_NAME"
EOF

# --- Single-pipeline mutex ---
# Only one pipeline should run at a time to avoid rate-limit exhaustion.
# Others will queue (flock blocks until the lock is released).
PIPELINE_LOCK="/tmp/attractor-pipeline.lock"
exec 9>"$PIPELINE_LOCK"
echo "🔒 Acquiring pipeline lock (waiting if another pipeline is running)..."
flock 9
echo "🔓 Lock acquired — starting pipeline"

# --- Rate-limit cooldown ---
# If another pipeline finished recently, wait before starting to avoid
# hitting provider rate limits across back-to-back runs.
LOCKFILE="/tmp/attractor-last-run.ts"
COOLDOWN_SECS=120
if [ -f "$LOCKFILE" ]; then
  LAST_RUN=$(cat "$LOCKFILE" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  ELAPSED=$((NOW - LAST_RUN))
  if [ "$ELAPSED" -lt "$COOLDOWN_SECS" ]; then
    WAIT=$((COOLDOWN_SECS - ELAPSED))
    echo "⏳ Cooling down ${WAIT}s (rate-limit protection)..."
    sleep "$WAIT"
  fi
fi

# Default project board IDs for LocalRank.city (optional)
if [[ "$REPO_SLUG" == "reymarx/localrank-city" ]]; then
  export PROJECT_ID="PVT_kwHOACgTfs4BO4P2"
  export STATUS_FIELD_ID="PVTSSF_lAHOACgTfs4BO4P2zg9c5jQ"
  export STATUS_IN_PROGRESS_ID="47fc9ee4"
  export STATUS_REVIEW_ID="354aa509"
  export STATUS_DONE_ID="98236657"
fi

if [[ "$REPO_SLUG" == "reymarx/llmstxt-saas" ]]; then
  export PROJECT_ID="PVT_kwHOACgTfs4BPSt3"
  export STATUS_FIELD_ID="PVTSSF_lAHOACgTfs4BPSt3zg9viWI"
  export STATUS_IN_PROGRESS_ID="47fc9ee4"
  export STATUS_REVIEW_ID="47fc9ee4"
  export STATUS_DONE_ID="98236657"
fi

cd "$(dirname "$0")"

# --- Project Board Automation ---
move_to_status() {
  local status_id="$1"
  local label="$2"
  if [ -z "${PROJECT_ID:-}" ] || [ -z "${STATUS_FIELD_ID:-}" ] || [ -z "$status_id" ]; then
    return 0
  fi
  local node_id
  node_id=$(gh api "repos/${REPO_SLUG}/issues/${ISSUE_NUMBER}" --jq '.node_id' 2>/dev/null) || return 0
  local item_id
  item_id=$(gh api graphql -f query='mutation {
    addProjectV2ItemById(input: {
      projectId: "'"${PROJECT_ID}"'"
      contentId: "'"${node_id}"'"
    }) { item { id } }
  }' --jq '.data.addProjectV2ItemById.item.id' 2>/dev/null) || return 0
  gh api graphql -f query='mutation {
    updateProjectV2ItemFieldValue(input: {
      projectId: "'"${PROJECT_ID}"'"
      itemId: "'"${item_id}"'"
      fieldId: "'"${STATUS_FIELD_ID}"'"
      value: { singleSelectOptionId: "'"${status_id}"'" }
    }) { projectV2Item { id } }
  }' >/dev/null 2>&1 || true
  echo "📋 Project board: #${ISSUE_NUMBER} → ${label}"
}

# Move to In Progress at start
move_to_status "${STATUS_IN_PROGRESS_ID:-}" "In Progress"

# Run the pipeline — on exit, clean up the worktree and update board
cleanup() {
  local exit_code=$?
  echo ""
  # Stamp finish time for rate-limit cooldown between runs
  date +%s > /tmp/attractor-last-run.ts
  echo "Cleaning up worktree: $WORKTREE_DIR"
  (cd "$ORIG_REPO_PATH" && git worktree remove "$WORKTREE_DIR" --force 2>/dev/null) || true
  # If pipeline succeeded (PR created), move to Done
  if [ $exit_code -eq 0 ] && [ -n "${STATUS_DONE_ID:-}" ]; then
    move_to_status "${STATUS_DONE_ID}" "Done"
  fi
}
trap cleanup EXIT

# Check for existing checkpoint (from a prior interrupted run)
# Scoped to this specific issue to avoid cross-contamination (#33)
LOGS_DIR="/tmp/attractor-logs"
CHECKPOINT=""
if [ -d "$LOGS_DIR" ]; then
  CHECKPOINT=$(find "$LOGS_DIR" -name "checkpoint.json" -exec grep -l "\"issueNumber\":\"${ISSUE_NUMBER}\"" {} + 2>/dev/null | head -1 || true)
fi

if [ -n "$CHECKPOINT" ]; then
  # Validate checkpoint isn't at exit node
  CURRENT_NODE=$(python3 -c "import json; print(json.load(open('$CHECKPOINT')).get('currentNode',''))" 2>/dev/null || echo "")
  if [ "$CURRENT_NODE" = "exit" ]; then
    echo "Stale checkpoint at exit node — starting fresh"
    rm -f "$CHECKPOINT"
    CHECKPOINT=""
  fi
fi

if [ -n "$CHECKPOINT" ]; then
  echo "Found checkpoint from interrupted run: $CHECKPOINT"
  echo "Resuming pipeline..."
  echo ""
  bun run run.ts issue.dot --resume "$CHECKPOINT"
else
  bun run run.ts issue.dot
fi
EXIT_CODE=$?
exit $EXIT_CODE
