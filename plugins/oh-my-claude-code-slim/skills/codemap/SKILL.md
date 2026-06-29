---
name: codemap
description: Generate comprehensive hierarchical codemaps for UNFAMILIAR repositories. Expensive operation - only use when explicitly asked for codebase documentation or initial repository mapping
---

# Codemap Skill

You help users understand and map repositories by creating hierarchical codemaps.

## When to Use

- User asks to understand/map a repository
- User wants codebase documentation
- Starting work on an unfamiliar codebase

## Workflow

### Step 1: Check for Existing State

**First, check if `.slim/codemap.json` exists in the repo root.**

If it does not exist, check for legacy state at `.slim/cartography.json`.

If legacy state exists: move `.slim/cartography.json` to `.slim/codemap.json`, then continue with change detection.

If `.slim/codemap.json` exists: Skip to Step 3 (Detect Changes) - no need to re-initialize.

If neither file exists: Continue to Step 2 (Initialize).

### Step 2: Initialize (Only if no state exists)

1. **Analyze the repository structure** - List files, understand directories
2. **Infer patterns** for **core code/config files ONLY** to include:
   - **Include**: `src/**/*.ts`, `package.json`, etc.
   - **Exclude (MANDATORY)**: Do NOT include tests, documentation, or translations.
     - Tests: `**/*.test.ts`, `**/*.spec.ts`, `tests/**`, `__tests__/**`
     - Docs: `docs/**`, `*.md` (except root `README.md` if needed), `LICENSE`
     - Build/Deps: `node_modules/**`, `dist/**`, `build/**`, `*.min.js`
   - Respect `.gitignore` automatically
3. **Run codemap.mjs init**:

The `codemap.mjs` script ships next to this skill, in its `scripts/` directory. Claude Code shows this skill's absolute source path when it loads; use that directory as `<codemap-skill-dir>` below.

```bash
node "<codemap-skill-dir>/scripts/codemap.mjs" init \
  --root ./ \
  --include "src/**/*.ts" \
  --exclude "**/*.test.ts" --exclude "dist/**" --exclude "node_modules/**"
```

This creates:
- `.slim/codemap.json` - File and folder hashes for change detection
- Empty `codemap.md` files in all relevant subdirectories

4. **Delegate codemap writing to Fixer agents** - Use the `Agent` tool to run one-shot fixer subagents, one per folder, to read code and create or update each specific `codemap.md` file.

### Step 3: Detect Changes (If state already exists)

1. **Run codemap.mjs changes** to see what changed:

```bash
node "<codemap-skill-dir>/scripts/codemap.mjs" changes \
  --root ./
```

2. **Review the output** - It shows:
   - Added files
   - Removed files
   - Modified files
   - Affected folders

3. **Only update affected codemaps** - Use the `Agent` tool to run one-shot fixer subagents, one per affected folder, to update its `codemap.md`.
4. **Run update** to save new state:

```bash
node "<codemap-skill-dir>/scripts/codemap.mjs" update \
  --root ./
```

### Step 4: Finalize Repository Atlas (Root Codemap)

Once all specific directories are mapped, the Orchestrator must create or update the root `codemap.md`. This file serves as the **Master Entry Point** for any agent or human entering the repository.

1.  **Map Root Assets**: Document the root-level files (e.g., `package.json`, `index.ts`, `plugin.json`) and the project's overall purpose.
2.  **Aggregate Sub-Maps**: Create a "Repository Directory Map" section. For every folder that has a `codemap.md`, extract its **Responsibility** summary and include it in a table or list in the root map.
3.  **Cross-Reference**: Ensure that the root map contains the absolute or relative paths to the sub-maps so agents can jump directly to the relevant details.

### Step 5: Register Codemap in CLAUDE.md

**Claude Code auto-loads `CLAUDE.md` into context on every session.** To ensure agents automatically discover and use the codemap, update (or create) `CLAUDE.md` at the repo root:

1. If `CLAUDE.md` already exists and already contains a `## Repository Map` section, **skip this step** — the reference is already set up.
2. If `CLAUDE.md` exists but has no `## Repository Map` section, **append** the section below.
3. If `CLAUDE.md` doesn't exist, **create** it with the section below.

```markdown
## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.
```

This is idempotent — repeated codemap runs will detect the existing section and skip. No duplication.

## Codemap Content

Fixers are responsible for writing `codemap.md` files during this workflow. Use precise technical terminology to document the implementation:

- **Responsibility** - Define the specific role of this directory using standard software engineering terms (e.g., "Service Layer", "Data Access Object", "Middleware").
- **Design Patterns** - Identify and name specific patterns used (e.g., "Observer", "Singleton", "Factory", "Strategy"). Detail the abstractions and interfaces.
- **Data & Control Flow** - Explicitly trace how data enters and leaves the module. Mention specific function call sequences and state transitions.
- **Integration Points** - List dependencies and consumer modules. Use technical names for hooks, events, or API endpoints.

Example codemap:

```markdown
# src/agents/

## Responsibility
Defines agent personalities and manages their configuration lifecycle.

## Design
Each agent is a prompt + permission set. The config system uses:
- Default prompts (one module per agent)
- User overrides from the host/project configuration
- Permission wildcards for skill/MCP/tool access control

## Flow
1. Plugin loads → builds agent configs
2. Reads the active config
3. Merges defaults with user overrides
4. Applies permission rules (wildcard expansion)
5. Returns agent configs to the host

## Integration
- Consumed by: the main plugin entry
- Depends on: config loader, skills registry
```

Example **Root Codemap (Atlas)**:

```markdown
# Repository Atlas: example-project

## Project Responsibility
A concise statement of what this repository does and its primary design goals.

## System Entry Points
- `src/index.ts`: Main entry point and host integration.
- `package.json`: Dependency manifest and build scripts.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/agents/` | Defines agent roles and manages model routing. | [View Map](src/agents/codemap.md) |
| `src/core/` | Core orchestration logic and session state. | [View Map](src/core/codemap.md) |
| `src/config/` | Configuration loading pipeline and environment injection. | [View Map](src/config/codemap.md) |
```
