# AGENTS.md

This file serves the purpose of guiding the AI agents working on this repository.

## Repository Overview

TriLog is a personal trainer and coach for athletes wanting guidance in their triathlon training.

It is a **pnpm + Turbo monorepo**. Packages are published under the `@trihards/*` scope.

```
apps/
  web/        # Next.js 16 app (the only app today; a mobile app is planned)
packages/
  core/       # @trihards/core — shared business logic
  db/         # @trihards/db — Turso / libSQL database layer
```

### Running it

```bash
pnpm install
pnpm db:bootstrap   # creates the local SQLite db at apps/web/.data/local.db
pnpm dev            # turbo run dev — starts the web app on http://localhost:3000
```

Other useful scripts (run from the repo root): `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the `pnpm db:*` family (`generate`, `migrate`, `import`, `studio`, `backfill-seed-plan`). The local database uses **Turso / libSQL** (SQLite-based) — there is no separate "push the data" step.

### Training plans are per-user

Each athlete's plan is a row in `training_plans`, uploaded on the Plan tab and parsed out of the document by the Claude API. **There is no default plan at read time**: an athlete without a row has no plan, and the calendar, plan tab, and coach prompt must all say so rather than falling back to anything. `SEED_PLAN` in `@trihards/core` (the bundled `runna-plan.json`) exists solely for the one-time `pnpm db:backfill-seed-plan <athlete-or-user-id>` backfill that assigns it to the one athlete it was written for — never import it into a read path.

### Next.js docs

`next` is a dependency of `apps/web`, so the version-pinned docs referenced below live at **`apps/web/node_modules/next/dist/docs/`**.

## Skills structure

Skills live in the `.claude/skills/` directory. Each skill is a self-contained module named after the skill:

```
.claude/skills/{skill-name}/
├── SKILL.md           # Main skill definition (REQUIRED — must not be empty)
└── references/        # Optional additional context
    └── topic.md
```

Current skills: `code-commit`, `frontend-design`.

### Skill File Format

`SKILL.md` must start with YAML frontmatter, followed by the instruction body:

```yaml
---
name: skill-name
description: When to use this skill (AI reads this to auto-load)
---
```

Skills are auto-invoked based on a match between their `description` and the current context. An empty `SKILL.md` will register the skill by name but it will not load or do anything.

## Session/Task start

**When starting a session or a task**, you MUST pull the latest changes from main, and branch off the main branch given the feature or changes you are given.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**

- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->
