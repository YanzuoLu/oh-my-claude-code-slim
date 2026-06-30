# oh-my-claude-code-slim (omcc-slim)

OMO-slim orchestration, ported to **Claude Code**. It injects an orchestrator directive at
session start, a per-turn scheduler anchor on each root prompt, ships five specialist
subagents as native plugin agents, and ports six OMO skills. Claude Code's built-in subagents
remain available.

This is the Claude Code sibling of [oh-my-codex-slim](https://github.com/YanzuoLu/oh-my-codex-slim)
(Codex) and a port of `oh-my-opencode-slim` (OpenCode). Because Claude Code's native tools and
plugin/subagent model closely match OpenCode's, this port stays close to the original OMO.

## Install

```sh
claude plugin marketplace add YanzuoLu/oh-my-claude-code-slim
claude plugin install oh-my-claude-code-slim@omcc-slim
```

Start a new session to load it. Update with `claude plugin update oh-my-claude-code-slim`
(a restart may be required to apply).

## What it does

- **Orchestrator directive** at `SessionStart` (sources `startup|clear|compact`). Claude Code
  caps each hook's `additionalContext` at 10,000 chars and the directive is ~13k, so it is
  delivered in **two parts** — `<Role>`+`<Agents>` and `<Workflow>`+`<Communication>` — via two
  SessionStart hook outputs that Claude Code appends in order. The `compact` source re-injects
  it after auto-compaction; `resume` is intentionally excluded (the transcript already replays
  it).
- **Per-turn anchor** at `UserPromptSubmit`, injected **only in the root session** (suppressed
  inside subagents via the `agent_id` hook field) so specialist contexts stay clean.
- **Five specialist subagents** — `explorer`, `librarian`, `oracle`, `designer`, `fixer`
  (namespaced `oh-my-claude-code-slim:<name>`). As in omo-slim, code review is the **oracle**
  lane; there is no separate reviewer agent.
- **Six ported OMO skills** — `simplify`, `deepwork`, `reflect`, `codemap`, `clonedeps`,
  `worktrees`. The workflow itself lives in the SessionStart directive, not a separate skill.

## Models & effort

All five lanes run on `claude-opus-4-8[1m]` (the 1M-token context window variant). Effort is tiered per role: `explorer`/`librarian` =
`medium` (lighter, faster recon and research), `oracle`/`designer`/`fixer` = `max` (deepest
reasoning for architecture, design, and implementation). Per-agent `effort` frontmatter overrides
the session effort level. Note: an active `CLAUDE_CODE_EFFORT_LEVEL` env var is highest precedence
and would override per-agent effort — to keep per-role tiers, set your default via the `effortLevel`
setting (e.g. `xhigh`) instead of that env var.

Read-only lanes restrict their tools: `explorer` (Read/Glob/Grep) and `librarian`
(Read/Glob/Grep/WebFetch/WebSearch) cannot write; `oracle` blocks Write/Edit but keeps Bash for
diagnostics; `fixer` blocks WebFetch/WebSearch/Agent (no research, no delegation); `designer`
has full tool access.

## Built-in subagents

Claude Code's built-ins (`Explore`, `Plan`, `general-purpose`, `statusline-setup`,
`claude-code-guide`) remain registered — a plugin cannot remove them. If you want to force
routing to this plugin's `explorer` over the built-in `Explore`, deny it in your settings:

```json
{ "permissions": { "deny": ["Agent(Explore)"] } }
```

## Disable

Set `OMCC_SLIM_DISABLE=1` (also accepts `true`/`yes`/`on`) to silence the hooks without
uninstalling.

## Faithfulness & Claude Code adaptations

- Faithful to `oh-my-opencode-slim`, adapted to Claude Code. Prompts use Claude Code's native
  tools (`Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash`/`Agent`/`WebFetch`/`WebSearch`).
- OpenCode-only tool names (`ast_grep_search`, `apply_patch`) are intentionally **dropped** —
  Claude Code has no equivalent (structural search is approximated with `Grep`). This is a
  deliberate correctness deviation, not an omission.
- Delegation uses Claude Code's `Agent` tool / specialist subagents (one-shot; they return a
  summary). There is no async job board or subagent "resume".
- Read-only enforcement is advisory where `Bash` is available (plugin agents cannot set
  `permissionMode`).

## Uninstall

```sh
claude plugin uninstall oh-my-claude-code-slim@omcc-slim
```

## License

MIT
