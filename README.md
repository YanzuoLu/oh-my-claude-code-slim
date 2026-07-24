# oh-my-claude-code-slim (omcc-slim)

OMO-slim orchestration, ported to **Claude Code**. It ships an **orchestrator agent** you
launch as the main thread with `claude --agent`, five specialist subagents as native plugin
agents, two orchestrator-gated reminder hooks, and six ported OMO skills. Default `claude`
sessions are unaffected — nothing is injected unless the orchestrator is the active agent.

This is the Claude Code sibling of [oh-my-codex-slim](https://github.com/YanzuoLu/oh-my-codex-slim)
(Codex) and a port of `oh-my-opencode-slim` (OpenCode). The directives are re-ported from the
upstream native prompts and adapted to Claude Code's tools and delegation semantics.

## Install

```sh
claude plugin marketplace add YanzuoLu/oh-my-claude-code-slim
claude plugin install oh-my-claude-code-slim@omcc-slim
```

Update with:

```sh
claude plugin marketplace update omcc-slim
claude plugin update oh-my-claude-code-slim@omcc-slim
```

A restart or new session may be required to apply the update. **Upgrading from 0.1.x:** the
session-start directive injection is gone; update the plugin and start a new session, then use
the launch command below.

## Launch

```sh
claude --agent oh-my-claude-code-slim:orchestrator
```

This runs the orchestrator as the main-thread agent. Its directive (the OMO-slim
Role/Agents/Workflow/Communication prompt) lives in the agent body — no hook injection, no
size split. A plain `claude` session behaves exactly as if the plugin were not installed,
except that the specialists and skills remain visible (a plugin cannot hide its agents).

## Agents

| Agent | Lane | Effort | Access posture |
|---|---|---|---|
| `orchestrator` | plan / delegate / reconcile / verify | xhigh | full tools; `EnterPlanMode` denied by hook; may spawn **only** the five lanes below |
| `explorer` | fast codebase recon | medium | read-only (prompt-enforced) |
| `librarian` | external docs / web research | medium | read-only (prompt-enforced), WebSearch/WebFetch |
| `oracle` | architecture, debugging strategy, review | max | read-only (prompt-enforced) |
| `designer` | UI/UX design and implementation | high | read + write |
| `fixer` | bounded implementation | high | read + write, no web research (prompt-enforced) |

The agents map to four model tiers, each bound to an overridable alias: `orchestrator`
inherits the main session's model; `oracle` pins the `opus` alias; `fixer` and `designer`
share the `sonnet` alias; `explorer` and `librarian` share the `haiku` alias. In a normal
session the aliases resolve to the real Claude tiers; the `ANTHROPIC_DEFAULT_OPUS_MODEL` /
`ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_HAIKU_MODEL` env vars can redirect any
of them to a gateway model. All agents set `permissionMode: bypassPermissions`. As in
omo-slim, code review is the **oracle** lane; there is no separate reviewer agent.

Hard restrictions are deliberately minimal, mirroring upstream (where read-only lanes are also
prompt-governed rather than permission-locked):

- A `PreToolUse` hook on `EnterPlanMode` denies orchestrator-initiated Plan Mode. Frontmatter
  `disallowedTools: EnterPlanMode` was NOT applied to a main-thread `--agent` session (observed
  on CC 2.1.211: the tool stayed in the tool list), so the orchestrator sets no
  `disallowedTools` and the hook is the enforcement mechanism — same reason the agent-gate
  lives in a hook. (The subagent spawn path does apply frontmatter denylists; the specialists'
  `disallowedTools: Agent` relies on that.) Users may still enter Plan Mode through the Claude
  Code UI/command, and `ExitPlanMode` remains available to submit the plan for approval.
- Each specialist sets `disallowedTools: Agent` — subagents cannot spawn subagents (the
  OpenCode rule).
- A `PreToolUse` hook on `Agent|Task` denies the orchestrator any `subagent_type` other than
  the five specialists, so delegation cannot route to Claude Code's built-ins
  (`general-purpose`, `Explore`, `Plan`, …). A frontmatter denylist can't express this: on
  Claude Code 2.1.207 a `disallowedTools: Agent(Explore)` entry removes the **entire** `Agent`
  tool.
- No other tools are hard-restricted. `oracle`/`explorer`/`librarian` READ-ONLY and `fixer`'s
  "no external research" are prompt-level constraints, not hard bans — by design, not a bug.

Tune any lane without editing the plugin: drop a same-named agent file in
`~/.claude/agents/<name>.md` (user scope overrides the plugin), or set
`CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_EFFORT_LEVEL` globally. To additionally hard-deny
built-in subagents in every session (not just the orchestrator), add
`{ "permissions": { "deny": ["Agent(Explore)"] } }` to your settings — note that applies
session-wide.

## Mixed-model sessions (claudem)

`router/omcc-router.js` is a dependency-free splitter on `127.0.0.1:8318`. Point
`ANTHROPIC_BASE_URL` at it and each request is routed by its `model` field: `claude*` →
`api.anthropic.com` (headers/body passed through untouched), `*gpt*` → the local CLIProxyAPI at
`127.0.0.1:8317`, `k3*`/`kimi*` → `api.kimi.com/coding`. A `SessionStart` hook auto-starts the
router when the base URL targets 8318; plain sessions never touch it.

Three fish functions mirror omo-slim's fable/kimi/gpt presets. The orchestrator always
inherits the preset's main-session model; the `opus` / `sonnet` / `haiku` alias tiers land as
follows:

| Function | omo preset | orchestrator (main) | oracle (`opus`) | fixer + designer (`sonnet`) | explorer + librarian (`haiku`) |
|---|---|---|---|---|---|
| `claudem`  | fable | Claude fable (session default) | Claude opus      | gpt-5.6-sol-fast | gpt-5.6-sol-fast |
| `claudemk` | kimi  | k3                             | Claude opus      | gpt-5.6-sol-fast | gpt-5.6-sol-fast |
| `claudemg` | gpt   | gpt-5.6-sol-fast               | gpt-5.6-sol-fast | gpt-5.6-sol-fast | gpt-5.6-sol-fast |

Tokens (exported globally in the shell): `claudem` needs `CLAUDEX_TOKEN` (gpt cheap lanes);
`claudemk` needs `KIMI_TOKEN` (k3 main) plus `CLAUDEX_TOKEN`; `claudemg` needs `CLAUDEX_TOKEN`
only. The plain-session functions `claude` / `claudex` / `claudek` do not point at the router
and are unaffected by these pins — each already overrides the haiku/opus aliases with its own
model, so they stay single-model sessions.

The route table is user-configurable: copy `router/router.example.json` to
`~/.config/omcc-slim/router.json` and edit. Schema: `{ "port", "routes": [...] }` where each
route is `{ name, match, baseUrl, tokenEnv | passthrough, modelRewrite?, effort? }` — `match`
is a list of substrings tested against the lowercased model name (first hit in array order
wins, `"*"` is the catch-all); `passthrough: true` forwards all client headers untouched,
otherwise `Authorization` is replaced with `Bearer $<tokenEnv>`; `modelRewrite` / `effort`
rewrite the body's `model` / `output_config.effort` on that leg (the body is re-serialized
only when one of them is set). The file's mtime is checked per request and the table
hot-reloaded on change (a broken edit keeps the last good config; with no config file the
builtin defaults apply and no checks happen). Adding a new preset = add one route to
`router.json` plus (optionally) a fish function — no plugin upgrade needed.

### 配置自由度

- **Model binding** — the four tiers are env-bound: the orchestrator follows the session model
  (`--model`), the other tiers follow `ANTHROPIC_DEFAULT_OPUS_MODEL`,
  `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Repoint any tier at
  any gateway model without editing the plugin.
- **Effort, three layers** — (1) each agent's frontmatter carries the plugin's default effort;
  (2) when a tier is bound to GPT, CLIProxyAPI accepts an effort suffix in the model name,
  e.g. `ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.6-sol-fast(high)"`; (3) a `router.json` route can
  force `effort` / `modelRewrite` per match, hot-reloaded (see the `cpa-gpt-high` example in
  `router/router.example.json`).
- Do NOT set `CLAUDE_CODE_EFFORT_LEVEL`: it flattens every tier to a single effort globally
  and defeats the four-tier split.

## Hooks

Both hooks are ports of upstream behaviors, fire **only when the active agent is
`oh-my-claude-code-slim:orchestrator`** (gated on the hook payload's `agent_type`, with the
`CLAUDE_CODE_AGENT`/`CLAUDE_AGENT` env vars as fallback — so default sessions and specialist
subagents see nothing), and never block on errors:

- **Phase reminder** (`UserPromptSubmit`) — injects the OMO-slim scheduler reminder
  (plan lanes → dispatch background specialists → reconcile → verify) on every user turn.
- **File-tool nudge** (`PostToolUse` on `Read|Write|Edit`) — if the orchestrator starts
  touching files itself (the "inspect/edit → implement myself" anti-pattern), the same
  reminder is re-injected, at most once per user turn. Upstream injects it on the next model
  call; this port injects it in the current turn, which corrects the drift sooner.

## Skills

Five loaded OMO skills: `simplify`, `reflect`, `codemap`, `clonedeps`, `worktrees`.
`deepwork` is ported but kept unloaded at `skills-disabled/deepwork/` — the manifest
`skills` field only appends to the default `skills/` scan, so moving a skill out of
`skills/` is the only way to exclude it. The orchestration workflow itself lives in the
orchestrator agent, not a skill.

## Disable

Set `OMCC_SLIM_DISABLE=1` (also accepts `true`/`yes`/`on`) to silence the hooks without
uninstalling. The agents themselves are unaffected by the switch.

## Faithfulness & Claude Code adaptations

- Directives are re-ported from the upstream native prompts (`src/agents/*.ts`,
  `src/config/constants.ts`), near-verbatim, with tool names adapted:
  `grep/glob/read/edit/write` → `Grep`/`Glob`/`Read`/`Edit`/`Write`; the `websearch`/docs
  MCPs → `WebSearch`/`WebFetch`; the `question` tool → `AskUserQuestion`.
- OpenCode-only structural tools have no equivalent and are dropped; structural search is
  approximated with `Grep`. (Their names are banned tokens in `scripts/validate.mjs`.)
- Delegation: OpenCode's `task` tool → Claude Code's `Agent` tool with
  `run_in_background: true`; the Background Job Board → automatic task notifications;
  task cancellation → `TaskStop`; session reuse via the task tool's id argument →
  `SendMessage` to an existing teammate's name/ID.
- Upstream's Workflow numbering gap (4→6) is fixed to `## 5. Verify`.
- Not ported: `council`/`councillor`/`observer` (disabled or opt-in upstream), per-agent
  temperatures (no frontmatter equivalent), the preset/config system (use
  `~/.claude/agents/` overrides instead), and OpenCode-specific machinery
  (delegate-task-retry, multiplexer, interview, companion).

## Validate

```sh
npm run validate
```

Executes the reminder hook against a payload matrix (gating, kill switch, nudge debounce),
checks agent frontmatter invariants and residue banlists, then runs
`claude plugin validate --strict`.

## Uninstall

```sh
claude plugin uninstall oh-my-claude-code-slim@omcc-slim
```

## License

MIT
