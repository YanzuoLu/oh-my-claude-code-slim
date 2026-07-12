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

Start a new session to load it. Update the marketplace and plugin with:

```sh
claude plugin marketplace update omcc-slim
claude plugin update oh-my-claude-code-slim@omcc-slim
```

A restart or new session may be required to apply the update.

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

All five plugin subagents inherit the main session's current model. They override only effort and
permission mode: `explorer`/`librarian` use `effort: medium`, `designer`/`fixer` use `effort: high`,
and `oracle` uses `effort: max`; all five set `permissionMode: bypassPermissions`.

Tune any lane without editing the plugin: drop a same-named agent file in `~/.claude/agents/<name>.md`
(user scope overrides the plugin). If an agent file omits `permissionMode`, it inherits the parent
session's active permission mode at spawn time; it does not separately re-read
`permissions.defaultMode`. You can also set `CLAUDE_CODE_SUBAGENT_MODEL` (model, all subagents) or
`CLAUDE_CODE_EFFORT_LEVEL` (effort, all) globally.

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
- Delegation uses Claude Code's `Agent` tool / specialist subagents. Foreground calls return a
  final summary directly; background and named agents deliver completion automatically and can
  be continued with `SendMessage`. Agent-team IDs such as `name@session-*` are teammate addresses,
  not `TaskOutput` task IDs.
- All plugin agents run with `permissionMode: bypassPermissions`; read/write scope is constrained by
  each lane's `tools` or `disallowedTools` frontmatter and its role instructions.

## Uninstall

```sh
claude plugin uninstall oh-my-claude-code-slim@omcc-slim
```

## License

MIT
