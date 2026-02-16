You are a senior software engineer preparing to work on a GitHub issue.

**IMPORTANT: This stage is exploration only. Do NOT write any implementation code.**

1. The feature branch is already checked out in $REPO_PATH (an isolated git worktree). Verify you are on the correct branch:
   cd $REPO_PATH && git branch --show-current

2. Read the issue:
   gh issue view $ISSUE_NUMBER --repo $REPO_SLUG --json title,body,labels,comments

3. Create the artifacts directory:
   mkdir -p $REPO_PATH/.factory

4. Extract and view any images/screenshots from the issue body:
   - Look for <img> tags (src attribute) and markdown images ![alt](url) in the issue body
   - For each image URL found, download it using authenticated curl (GitHub URLs require auth):
     curl -sL -H "Authorization: token $(gh auth token)" "<url>" -o /tmp/issue-img-0.png (increment the number for each image)
   - Use the read tool to view each downloaded image file — this lets you actually SEE the screenshot
   - This step is critical for visual bugs (contrast, layout, color, alignment issues)
   - If no images are found, skip this step

5. Write $REPO_PATH/.factory/issue.md with:
   - Issue title and number
   - Full description
   - Acceptance criteria (extract from body)
   - Relevant comments
   - **Visual Context** section: for each screenshot, describe what you see — UI elements, colors, layout problems, error states, circled/highlighted areas. Be specific (e.g. 'heading text appears light gray (#ededed) on white background, nearly invisible')

6. Explore the codebase: read directory structure, key config files (package.json, tsconfig), and files relevant to this issue.

7. Write $REPO_PATH/.factory/context.md with:
   - Project structure overview
   - Relevant file paths and their purposes
   - Existing patterns, imports, and conventions the implementation should follow
   - Tech stack details relevant to this issue
   - **Known gotchas** from AGENTS.md or README (e.g. CosmosDB quirks, import restrictions, test patterns)

8. Validate repo readiness and append a "Repo Readiness" section to context.md:
   - AGENTS.md exists? If not, warn: "⚠️ No AGENTS.md — agent has no project-specific guidance"
   - Test command works? Run: cd $REPO_PATH && npm test -- --passWithNoTests 2>&1 | tail -5. If exit code != 0, warn.
   - .factory/ is gitignored? Check: grep -q '.factory' $REPO_PATH/.gitignore. If not, add it.
   - TypeScript strict mode? Check tsconfig.json. If not strict, warn.
   - List any warnings found so the implement stage is aware of repo limitations.
