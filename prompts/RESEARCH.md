# AI Coding Agent Prompt Best Practices Research

## Sources Analyzed
- Claude Code Best Practices (rosmur.github.io - synthesis of 12 sources)
- GitHub Blog: "How to write a great agents.md" (2500+ repo analysis)
- Builder.io: "Improve your AI code output with AGENTS.md"
- souls.directory/architect (role definition example)

---

## Key Findings

### 1. Clear Role Definition
- Start with a specific persona: "You are a senior QA engineer" beats "You are a helpful assistant"
- Define expertise, skills, and responsibilities explicitly
- Use active voice and present tense

### 2. Specificity is Non-Negotiable
- Vague instructions → vague results
- Bad: "Add tests for the feature"
- Good: "Write unit tests covering: happy path, validation errors, edge cases. Use Jest with describe/it blocks. Mock external APIs."

### 3. Context Management (Most Critical)
- Context degradation is the primary failure mode for AI agents
- Use documentation files (.factory/*.md) to preserve state across sessions
- Keep prompts focused; don't try to do everything in one stage
- Progressive disclosure: point to files rather than embedding everything

### 4. Three-Tier Boundaries Pattern
From 2500+ repo analysis, the best agent files use:
- ✅ **Always do:** Actions the agent should take without asking
- ⚠️ **Ask first:** Actions requiring confirmation
- 🚫 **Never do:** Hard guardrails that must not be violated

### 5. Commands Early & Specific
- Put executable commands near the top
- Include exact flags and options, not just tool names
- File-scoped commands (single file lint/test) save time vs project-wide

### 6. Examples Beat Explanations
- One real code snippet showing your style beats three paragraphs describing it
- Point to existing files as examples: "See path/to/good-example.ts"
- Show what good output looks like

### 7. Planning Before Coding
- Consensus across all sources: planning is non-negotiable for production work
- Validate plans before implementation
- Update plans as work progresses (living documents)

### 8. Test-Driven Development
- Write tests BEFORE implementation
- Confirm tests fail first (avoid mock implementations)
- Do NOT modify tests during implementation to make them pass
- Fix the implementation, not the test

### 9. Incremental Commits
- Commit early and often with meaningful messages
- Each commit should compile and pass tests
- Use Conventional Commits format (feat:, fix:, test:)
- Enables rollback if something goes wrong

### 10. Error Handling Patterns
- Be explicit about error handling expectations
- "Never silently swallow exceptions"
- Include monitoring/logging requirements (e.g., Sentry)

### 11. Structured Output Expectations
- Define exact file names and formats for outputs
- Specify what each output file should contain
- Use checklists for progress tracking: `- [ ]` → `- [x]`

### 12. Self-Review Pattern
- Have the agent review its own work before declaring done
- Use separate contexts for writing and reviewing (fresh perspective)
- Code review findings should be documented

---

## Patterns Applied to Attractor Pipeline

### Stage-Specific Improvements

| Stage | Key Improvements |
|-------|-----------------|
| **setup** | Explicit exploration checklist, visual context extraction, repo readiness validation |
| **plan** | Checkbox format for tracking, include test strategy, reference actual patterns |
| **implement** | Follow plan exactly, incremental commits per step, address feedback.md |
| **test** | Parallel quality checks, triage failures, only fix test-infrastructure issues |
| **review** | Security checklist, pattern compliance, document findings |
| **publish** | Clean PR body, reference review.md, cleanup artifacts |

### Cross-Cutting Improvements
1. **Role clarity** - Each stage has a distinct persona (setup explorer, plan architect, implementer, QA engineer, reviewer, publisher)
2. **Boundaries** - Each stage knows what it should/shouldn't do
3. **Output artifacts** - Clear file expectations per stage
4. **Error handling** - Explicit guidance on what to do when things fail
5. **Context preservation** - Use .factory/ files to pass information between stages
6. **Verification steps** - Each stage validates its own work

---

## Anti-Patterns to Avoid
- ❌ Vague personas ("helpful assistant")
- ❌ Missing boundaries (what NOT to do)
- ❌ No examples (abstract descriptions only)
- ❌ Skipping planning phase
- ❌ Modifying tests to make them pass
- ❌ Large speculative changes without confirmation
- ❌ Silently swallowing errors
- ❌ Project-wide commands when file-scoped would suffice

---

## Template Structure (from 2500+ repo analysis)

```markdown
# Stage: [Name]

You are a [specific role] [doing what].

## Your Role
- Specific responsibilities
- Skills and expertise
- What you produce

## Inputs
- What you read/receive

## Outputs  
- What you create/produce

## Commands
- Exact commands with flags

## Process
1. Step-by-step instructions
2. With checkpoints
3. And validation

## Boundaries
- ✅ Always: [required actions]
- ⚠️ Ask first: [conditional actions]  
- 🚫 Never: [prohibited actions]

## Error Handling
- What to do when things fail
```

---

## References
- https://rosmur.github.io/claudecode-best-practices/
- https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
- https://www.builder.io/blog/agents-md
- https://souls.directory/souls/thedaviddias/architect
