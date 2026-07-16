#!/usr/bin/env node
'use strict';
// oh-my-claude-code-slim reminder hook (port of omo-slim's phase-reminder and
// post-file-tool-nudge). Modes (argv[2]):
//   prompt      UserPromptSubmit — inject the scheduler phase reminder and reset
//               the per-turn nudge debounce.
//   nudge       PostToolUse (Read|Write|Edit) — re-inject the same reminder at
//               most once per user turn after the orchestrator touches files
//               itself (the "inspect/edit → implement myself" anti-pattern).
//   agent-gate  PreToolUse (Agent|Task) — deny non-specialist subagent_type
//               values, so the orchestrator can only spawn the five plugin
//               lanes. (A frontmatter denylist like "Agent(Explore)" removes
//               the whole Agent tool on Claude Code 2.1.207, so the gate must
//               live here.)
//   plan-gate   PreToolUse (EnterPlanMode) — deny; Plan Mode is user-initiated
//               only. (Frontmatter `disallowedTools: EnterPlanMode` is not
//               applied to a main-thread --agent session on CC 2.1.211 — the
//               tool stays in the tool list — so the gate must live here.)
// All modes fire only when the active agent is this plugin's orchestrator
// (payload agent_type, with the CLAUDE_CODE_AGENT / CLAUDE_AGENT env vars as
// fallback), so default sessions and specialist subagents are unaffected.
// OMCC_SLIM_DISABLE=1 (or true/yes/on) silences everything. Errors are
// swallowed; always exit 0.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ORCHESTRATOR_NAMES = new Set(['oh-my-claude-code-slim:orchestrator', 'orchestrator']);
const SPECIALISTS = new Set(['explorer', 'librarian', 'oracle', 'designer', 'fixer']);

const PHASE_REMINDER_TEXT =
  '!IMPORTANT! Scheduler workflow: plan lanes/dependencies → dispatch background specialists → track agent IDs → wait for automatic completion messages → reconcile terminal results → verify. Do not poll running agents, consume running-agent output, or advance dependent work. !END!';
const PHASE_REMINDER = `<system-reminder>\n${PHASE_REMINDER_TEXT}\n</system-reminder>`;

function main() {
  const mode = process.argv[2];
  if (/^(1|true|yes|on)$/i.test(String(process.env.OMCC_SLIM_DISABLE || '').trim())) return;

  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}') || {}; } catch { payload = {}; }

  // Gate on the active agent: the hook payload's agent_type is authoritative
  // (Claude Code 2.1.207); env vars cover older/newer spellings.
  const agent = String(payload.agent_type || process.env.CLAUDE_CODE_AGENT || process.env.CLAUDE_AGENT || '');
  if (!ORCHESTRATOR_NAMES.has(agent)) return;
  // Defense in depth: subagent sessions carry agent_id — never inject there.
  if (typeof payload.agent_id === 'string' && payload.agent_id) return;

  const sid = String(payload.session_id || '').replace(/[^A-Za-z0-9_-]/g, '');
  const flag = sid ? path.join(os.tmpdir(), `omcc-slim-nudge-${sid}`) : null;
  const emit = (event) => process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: PHASE_REMINDER } })}\n`,
  );

  if (mode === 'prompt') {
    if (flag) { try { fs.unlinkSync(flag); } catch {} }
    emit('UserPromptSubmit');
  } else if (mode === 'nudge') {
    if (!flag || fs.existsSync(flag)) return; // at most one nudge per turn
    try { fs.writeFileSync(flag, '1'); } catch {}
    emit('PostToolUse');
  } else if (mode === 'agent-gate') {
    const raw = String((payload.tool_input && payload.tool_input.subagent_type) || '');
    const name = raw.replace(/^oh-my-claude-code-slim:/, '');
    if (!SPECIALISTS.has(name)) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            'oh-my-claude-code-slim: the orchestrator may only spawn its five specialists (explorer, librarian, oracle, designer, fixer). Pass one of those as subagent_type.',
        },
      })}\n`);
    }
  } else if (mode === 'plan-gate') {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'oh-my-claude-code-slim: Plan Mode is user-initiated only — the orchestrator must never call EnterPlanMode. Continue with the scheduler workflow; the user can enter Plan Mode themselves via the Claude Code UI/command.',
      },
    })}\n`);
  }
}

try { main(); } catch {}
process.exitCode = 0;
