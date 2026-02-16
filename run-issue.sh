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

set -euo pipefail

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

# Run the pipeline — on exit, clean up the worktree
cleanup() {
  echo ""
  echo "Cleaning up worktree: $WORKTREE_DIR"
  (cd "$ORIG_REPO_PATH" && git worktree remove "$WORKTREE_DIR" --force 2>/dev/null) || true
}
trap cleanup EXIT

bun run run.ts issue.dot
EXIT_CODE=$?
exit $EXIT_CODE
