#!/usr/bin/env bash
# init-repo.sh — Bootstrap a repo for Attractor pipeline readiness.
# Usage: ./init-repo.sh /path/to/repo
# Idempotent — safe to run multiple times.

set -euo pipefail

REPO="${1:?Usage: $0 /path/to/repo}"
REPO="$(cd "$REPO" && pwd)"

echo "🔧 Initializing repo: $REPO"
echo ""

summary=()
ok() { summary+=("✅ $1"); echo "✅ $1"; }
warn() { summary+=("⚠️  $1"); echo "⚠️  $1"; }

# --- Detect stack from package.json ---
detect_stack() {
  local pkg="$REPO/package.json"
  HAS_NEXT=false; HAS_REACT=false; HAS_COSMOS=false
  SCRIPTS_BUILD=""; SCRIPTS_TEST=""; SCRIPTS_LINT=""

  if [[ ! -f "$pkg" ]]; then return; fi

  local deps
  deps="$(cat "$pkg")"

  grep -q '"next"' "$pkg" 2>/dev/null && HAS_NEXT=true
  grep -q '"react"' "$pkg" 2>/dev/null && HAS_REACT=true
  grep -q -i 'cosmos' "$pkg" 2>/dev/null && HAS_COSMOS=true

  SCRIPTS_BUILD="$(echo "$deps" | grep -oP '"build"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"//')" || true
  SCRIPTS_TEST="$(echo "$deps" | grep -oP '"test"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"//')" || true
  SCRIPTS_LINT="$(echo "$deps" | grep -oP '"lint"\s*:\s*"[^"]*"' | head -1 | sed 's/.*: *"//' | sed 's/"//')" || true
}

detect_stack

# --- 1. AGENTS.md ---
if [[ -f "$REPO/AGENTS.md" ]]; then
  ok "AGENTS.md already exists"
else
  stack_desc="Node.js"
  $HAS_NEXT && stack_desc="Next.js"
  $HAS_REACT && ! $HAS_NEXT && stack_desc="React"

  gotcha_sections=""
  $HAS_NEXT && gotcha_sections+=$'\n### Next.js\n\n<!-- e.g. App Router vs Pages Router, server components, etc. -->\n'
  $HAS_COSMOS && gotcha_sections+=$'\n### CosmosDB\n\n<!-- e.g. partition keys, RU limits, query quirks -->\n'
  gotcha_sections+=$'\n### Testing\n\n<!-- e.g. mock patterns, test database setup -->\n'

  cat > "$REPO/AGENTS.md" << AGENTS_EOF
# AGENTS.md

## Project Overview

<!-- One-liner: what does this project do? -->
TODO: Describe this project.

## Quick Reference

| Task  | Command |
|-------|---------|
| Build | \`${SCRIPTS_BUILD:-npm run build}\` |
| Test  | \`${SCRIPTS_TEST:-npm test}\` |
| Lint  | \`${SCRIPTS_LINT:-npm run lint}\` |

## Known Gotchas
${gotcha_sections}
## Code Conventions

<!-- e.g. import style, naming, file structure -->

## Deploy Notes

<!-- e.g. environment variables, hosting platform -->
AGENTS_EOF

  ok "AGENTS.md created ($stack_desc template)"
fi

# --- 2. .factory/ in .gitignore ---
if [[ -f "$REPO/.gitignore" ]] && grep -q '\.factory' "$REPO/.gitignore"; then
  ok ".factory/ already in .gitignore"
else
  echo '.factory/' >> "$REPO/.gitignore"
  ok ".factory/ added to .gitignore"
fi

# --- 3. Test runner ---
if ls "$REPO"/jest.config* "$REPO"/vitest.config* 2>/dev/null | head -1 > /dev/null 2>&1; then
  ok "Test runner config found"
else
  warn "No jest.config or vitest.config found — tests may not be configured"
fi

# --- 4. Linter ---
if ls "$REPO"/.eslintrc* "$REPO"/eslint.config* "$REPO"/.eslintrc 2>/dev/null | head -1 > /dev/null 2>&1 || \
   ([ -f "$REPO/package.json" ] && grep -q '"eslintConfig"' "$REPO/package.json" 2>/dev/null); then
  ok "ESLint config found"
else
  warn "No ESLint config found — linting may not be configured"
fi

# --- 5. TypeScript strict ---
if [[ -f "$REPO/tsconfig.json" ]]; then
  if grep -q '"strict"' "$REPO/tsconfig.json" && grep '"strict"' "$REPO/tsconfig.json" | grep -q 'true'; then
    ok "TypeScript strict mode enabled"
  else
    warn "TypeScript strict mode not enabled in tsconfig.json"
  fi
else
  warn "No tsconfig.json found"
fi

# --- 6. CI workflow ---
if [[ -d "$REPO/.github/workflows" ]] && ls "$REPO/.github/workflows/"*.yml "$REPO/.github/workflows/"*.yaml 2>/dev/null | head -1 > /dev/null 2>&1; then
  ok "CI workflow found"
else
  warn "No CI workflow found in .github/workflows/"
fi

# --- 7. Issue template ---
if [[ -d "$REPO/.github/ISSUE_TEMPLATE" ]]; then
  ok "Issue templates already exist"
else
  mkdir -p "$REPO/.github/ISSUE_TEMPLATE"
  cat > "$REPO/.github/ISSUE_TEMPLATE/feature.md" << 'TMPL_EOF'
---
name: Feature Request
about: Propose a new feature
title: ""
labels: enhancement
---

## Description

<!-- What should this feature do? -->

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Screenshots

<!-- If applicable, add mockups or screenshots -->
TMPL_EOF
  ok "Issue template created (.github/ISSUE_TEMPLATE/feature.md)"
fi

# --- Summary ---
echo ""
echo "━━━ Summary ━━━"
for line in "${summary[@]}"; do
  echo "  $line"
done
echo ""
echo "Done! Review any ⚠️  items above."
