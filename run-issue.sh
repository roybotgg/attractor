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
REPO_PATH="${2:-/home/rey/clawd/localrank-city}"

# Derive repo slug from git remote
REPO_SLUG=$(cd "$REPO_PATH" && git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')

# Construct issue URL
ISSUE_URL="https://github.com/${REPO_SLUG}/issues/${ISSUE_NUMBER}"

echo "Issue:  $ISSUE_URL"
echo "Repo:   $REPO_PATH ($REPO_SLUG)"
echo ""

export ISSUE_NUMBER ISSUE_URL REPO_PATH REPO_SLUG

cd "$(dirname "$0")"
exec bun run run.ts issue.dot
