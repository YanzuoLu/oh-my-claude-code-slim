#!/usr/bin/env node
// Validator for oh-my-claude-code-slim v0.2+. Asserts the omcc-specific invariants that
// `claude plugin validate --strict` does not — and EXECUTES the reminder hook (not just greps
// it) so a gating/debounce regression cannot slip through — then defers schema validation to
// the real CLI.

import { readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'plugins', 'oh-my-claude-code-slim');
const hookPath = path.join(pluginDir, 'hooks', 'reminder.cjs');
const roles = ['explorer', 'librarian', 'oracle', 'designer', 'fixer'];
const roleEffort = { explorer: 'medium', librarian: 'medium', oracle: 'max', designer: 'high', fixer: 'high' };
const ORCH = 'oh-my-claude-code-slim:orchestrator';

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
const read = (p) => readFileSync(p, 'utf8');

// 1. plugin.json
const manifest = JSON.parse(read(path.join(pluginDir, '.claude-plugin', 'plugin.json')));
check(manifest.name === 'oh-my-claude-code-slim', 'plugin.json name must be "oh-my-claude-code-slim"');
check(manifest.hooks === undefined, 'plugin.json must NOT declare "hooks" — hooks/hooks.json is auto-loaded; declaring it duplicates the load and fails the plugin');
check(existsSync(path.join(pluginDir, 'hooks', 'hooks.json')), 'hooks/hooks.json must exist (auto-loaded by Claude Code)');
check(!existsSync(path.join(pluginDir, 'components')), 'components/ must be gone — the SessionStart directive machinery was removed in 0.2.0');

// 2. marketplace.json (subdir source)
const market = JSON.parse(read(path.join(root, '.claude-plugin', 'marketplace.json')));
check(Array.isArray(market.plugins) && market.plugins.some((p) => p.source === './plugins/oh-my-claude-code-slim'), 'marketplace.json must list a plugin with source "./plugins/oh-my-claude-code-slim"');

// 3. hooks.json — no SessionStart; prompt + nudge registrations
const hooksRaw = read(path.join(pluginDir, 'hooks', 'hooks.json'));
const hooks = JSON.parse(hooksRaw);
check(hooks.hooks?.SessionStart === undefined, 'hooks.json must NOT define SessionStart — the directive lives in agents/orchestrator.md now');
check(hooksRaw.includes('${CLAUDE_PLUGIN_ROOT}'), 'hooks.json must use ${CLAUDE_PLUGIN_ROOT}');
const upsHandler = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
check((upsHandler?.args || []).join(' ').includes('reminder.cjs') && (upsHandler?.args || []).includes('prompt'), 'UserPromptSubmit must run reminder.cjs in "prompt" mode');
const ptuGroup = hooks.hooks?.PostToolUse?.[0];
for (const tool of ['Read', 'Write', 'Edit']) {
  check(!!ptuGroup?.matcher && new RegExp(`(^|\\|)${tool}(\\||$)`).test(ptuGroup.matcher), `PostToolUse matcher must cover ${tool}`);
}
const ptuHandler = ptuGroup?.hooks?.[0];
check((ptuHandler?.args || []).join(' ').includes('reminder.cjs') && (ptuHandler?.args || []).includes('nudge'), 'PostToolUse must run reminder.cjs in "nudge" mode');
const preGroup = hooks.hooks?.PreToolUse?.[0];
check(!!preGroup?.matcher && /(^|\|)Agent(\||$)/.test(preGroup.matcher) && /(^|\|)Task(\||$)/.test(preGroup.matcher), 'PreToolUse matcher must cover Agent and Task (legacy alias)');
const preHandler = preGroup?.hooks?.[0];
check((preHandler?.args || []).join(' ').includes('reminder.cjs') && (preHandler?.args || []).includes('agent-gate'), 'PreToolUse must run reminder.cjs in "agent-gate" mode — the frontmatter Agent(type) denylist removes the whole Agent tool on CC 2.1.207, so the hook is the enforcement mechanism');
const planGroup = (hooks.hooks?.PreToolUse || []).find((g) => /(^|\|)EnterPlanMode(\||$)/.test(g?.matcher || ''));
check(!!planGroup, 'PreToolUse must have an EnterPlanMode matcher group — frontmatter disallowedTools is not applied to a main-thread --agent session on CC 2.1.211, so the hook is the enforcement mechanism');
const planHandler = planGroup?.hooks?.[0];
check((planHandler?.args || []).join(' ').includes('reminder.cjs') && (planHandler?.args || []).includes('plan-gate'), 'the EnterPlanMode PreToolUse group must run reminder.cjs in "plan-gate" mode');

// 4. reminder.cjs RUNTIME behavior — execute the real hook with payloads
function runHook(mode, payload, extraEnv) {
  try {
    return execFileSync('node', [hookPath, mode], {
      input: JSON.stringify(payload),
      env: { ...process.env, OMCC_SLIM_DISABLE: '', CLAUDE_AGENT: '', CLAUDE_CODE_AGENT: '', ...(extraEnv || {}) },
      encoding: 'utf8'
    }).trim();
  } catch (e) {
    errors.push(`reminder.cjs execution failed (${mode}): ${e.message}`);
    return '';
  }
}
const parseOut = (out) => { if (!out) return null; try { return JSON.parse(out).hookSpecificOutput || null; } catch { return null; } };

// prompt mode: injects for the orchestrator — payload agent_type is authoritative
// (Claude Code 2.1.207); CLAUDE_CODE_AGENT / CLAUDE_AGENT env vars are fallbacks.
const promptVariants = [
  ['payload agent_type (scoped)', { agent_type: ORCH }, {}],
  ['payload agent_type (bare)', { agent_type: 'orchestrator' }, {}],
  ['CLAUDE_CODE_AGENT env', {}, { CLAUDE_CODE_AGENT: ORCH }],
  ['CLAUDE_AGENT env', {}, { CLAUDE_AGENT: ORCH }],
];
for (const [label, payloadExtra, envExtra] of promptVariants) {
  const out = parseOut(runHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'vtest', ...payloadExtra }, envExtra));
  check(out?.hookEventName === 'UserPromptSubmit', `prompt mode must emit a UserPromptSubmit hookSpecificOutput via ${label}`);
  check((out?.additionalContext || '').includes('Scheduler workflow') && (out?.additionalContext || '').includes('!IMPORTANT!'), `prompt mode must inject the phase reminder via ${label}`);
}
// gates: no agent / non-orchestrator / subagent payload / kill switch → silent, exit 0
check(runHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'vtest' }) === '', 'prompt mode must emit NOTHING when no agent is identified (default sessions unaffected)');
check(runHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'vtest', agent_type: 'oh-my-claude-code-slim:explorer' }) === '', 'prompt mode must emit NOTHING for a non-orchestrator agent');
check(runHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'vtest', agent_type: ORCH, agent_id: 'agent-1' }) === '', 'prompt mode must emit NOTHING when the payload carries agent_id (subagent session)');
check(runHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: 'vtest', agent_type: ORCH }, { OMCC_SLIM_DISABLE: '1' }) === '', 'OMCC_SLIM_DISABLE=1 must silence the hook');

// nudge debounce: nudge → emit, nudge → silent, prompt → emit + reset, nudge → emit again
const nudgeSid = 'vtest-nudge';
const nudgeFlag = path.join(os.tmpdir(), `omcc-slim-nudge-${nudgeSid}`);
try { unlinkSync(nudgeFlag); } catch {}
const nudgePayload = { hook_event_name: 'PostToolUse', tool_name: 'Read', session_id: nudgeSid, agent_type: ORCH };
const n1 = parseOut(runHook('nudge', nudgePayload));
check(n1?.hookEventName === 'PostToolUse' && (n1?.additionalContext || '').includes('Scheduler workflow'), 'first nudge of a turn must inject the reminder');
check(runHook('nudge', nudgePayload) === '', 'second nudge in the same turn must be debounced (silent)');
check(parseOut(runHook('prompt', { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: nudgeSid, agent_type: ORCH }))?.hookEventName === 'UserPromptSubmit', 'prompt mode must still emit while resetting the nudge debounce');
const n3 = parseOut(runHook('nudge', nudgePayload));
check(n3?.hookEventName === 'PostToolUse', 'nudge must fire again after the next prompt reset the debounce');
check(runHook('nudge', { ...nudgePayload, session_id: '' }) === '', 'nudge without a session_id must be silent');
try { unlinkSync(nudgeFlag); } catch {}

// agent-gate fallback mode: deny non-specialists, stay silent for the five lanes
const gateDeny = parseOut(runHook('agent-gate', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, session_id: 'vtest', agent_type: ORCH }));
check(gateDeny?.permissionDecision === 'deny', 'agent-gate must deny a native subagent_type');
for (const r of roles) {
  check(runHook('agent-gate', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: r }, session_id: 'vtest', agent_type: ORCH }) === '', `agent-gate must allow specialist "${r}"`);
  check(runHook('agent-gate', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: `oh-my-claude-code-slim:${r}` }, session_id: 'vtest', agent_type: ORCH }) === '', `agent-gate must allow scoped specialist "oh-my-claude-code-slim:${r}"`);
}
check(runHook('agent-gate', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, session_id: 'vtest' }) === '', 'agent-gate must be silent outside orchestrator sessions');

// plan-gate: deny EnterPlanMode in orchestrator sessions, silent elsewhere
const planDeny = parseOut(runHook('plan-gate', { hook_event_name: 'PreToolUse', tool_name: 'EnterPlanMode', tool_input: {}, session_id: 'vtest', agent_type: ORCH }));
check(planDeny?.permissionDecision === 'deny', 'plan-gate must deny EnterPlanMode in orchestrator sessions');
check(runHook('plan-gate', { hook_event_name: 'PreToolUse', tool_name: 'EnterPlanMode', tool_input: {}, session_id: 'vtest' }) === '', 'plan-gate must be silent outside orchestrator sessions');

// 5. agents/orchestrator.md — frontmatter + ported directive sections
const orchPath = path.join(pluginDir, 'agents', 'orchestrator.md');
check(existsSync(orchPath), 'agents/orchestrator.md must exist');
if (existsSync(orchPath)) {
  const o = read(orchPath);
  check(/name:\s*orchestrator\b/.test(o), 'orchestrator frontmatter name must be "orchestrator"');
  check(o.includes('effort: xhigh'), 'orchestrator must set effort: xhigh');
  check(o.includes('permissionMode: bypassPermissions'), 'orchestrator must set permissionMode: bypassPermissions');
  check(!/\nmodel:/.test(o), 'orchestrator must not pin a model (inherit the session model)');
  check(!/\nmcpServers:/.test(o) && !/\ntools:/.test(o), 'orchestrator must not set mcpServers/tools');
  check(!/\ndisallowedTools:/.test(o), 'orchestrator must not set disallowedTools — a main-thread --agent session does not apply it at all (CC 2.1.211), and an "Agent(...)" entry removes the entire Agent tool (CC 2.1.207); the EnterPlanMode and native-subagent bans are enforced by the plan-gate/agent-gate PreToolUse hooks');
  check(o.includes('Never call or initiate `EnterPlanMode`') && o.includes('only the user may enter Plan Mode through Claude Code UI/command'), 'orchestrator.md must forbid self-initiated Plan Mode entry');
  check(o.includes('If the user has already entered Plan Mode') && o.includes('use `ExitPlanMode` to submit it for approval'), 'orchestrator.md must preserve the native user-entered Plan Mode flow and ExitPlanMode approval');
  for (const tag of ['<Role>', '<Agents>', '<Workflow>', '<Communication>']) check(o.includes(tag), `orchestrator.md missing section ${tag}`);
  for (const lane of roles) check(o.includes(`@${lane}`), `orchestrator.md missing @${lane} routing block`);
  for (const tok of ['run_in_background', '`SendMessage`', '`TaskStop`', '`AskUserQuestion`']) check(o.includes(tok), `orchestrator.md must reference ${tok}`);
  check(o.includes('## 5. Verify'), 'orchestrator.md Workflow must end with "## 5. Verify" (upstream 4→6 numbering bug fixed)');
  check(!/\n## 6\./.test(o), 'orchestrator.md must not contain a "## 6." section');
  check(!o.includes('@council') && !o.includes('@observer'), 'orchestrator.md must not port the disabled council/observer lanes');
}

// 6. five specialist agents — effort tiers, Agent-only denylist, no allowlists
for (const r of roles) {
  const ap = path.join(pluginDir, 'agents', `${r}.md`);
  if (!existsSync(ap)) { errors.push(`missing agent file agents/${r}.md`); continue; }
  const a = read(ap);
  check(a.startsWith('---'), `agents/${r}.md must start with YAML frontmatter`);
  check(new RegExp(`name:\\s*${r}\\b`).test(a), `agents/${r}.md frontmatter name must be "${r}"`);
  check(!/\nmodel:/.test(a), `agents/${r}.md must not override the parent session model`);
  check(a.includes(`effort: ${roleEffort[r]}`), `agents/${r}.md must set effort ${roleEffort[r]}`);
  check(!/\ntools:/.test(a), `agents/${r}.md must not set a tools allowlist — lane posture is prompt-enforced (mirrors upstream)`);
  check(a.includes('permissionMode: bypassPermissions'), `agents/${r}.md must set permissionMode: bypassPermissions`);
  check(!/\nmcpServers:/.test(a) && !/\nhooks:/.test(a), `agents/${r}.md must not set mcpServers/hooks`);
  const denyLine = ((a.match(/\ndisallowedTools:\s*(.+)/) || [])[1] || '').trim();
  check(denyLine === 'Agent', `agents/${r}.md disallowedTools must be exactly "Agent" (subagents must not spawn subagents; nothing else is hard-restricted)`);
}
check((read(path.join(pluginDir, 'agents', 'fixer.md'))).includes('NO external research'), 'fixer.md must keep the prompt-level "NO external research" constraint');
for (const r of ['explorer', 'librarian', 'oracle']) {
  check(read(path.join(pluginDir, 'agents', `${r}.md`)).includes('READ-ONLY'), `agents/${r}.md must keep the prompt-level READ-ONLY constraint`);
}

// 7. residue banlist — OpenCode/Codex tool names and dead v0.1.x machinery
const residue = ['exec_command', 'apply_patch', 'spawn_agent', 'wait_agent', 'resume_agent', 'close_agent', 'gpt-5.5', '${PLUGIN_ROOT}', 'ast_grep_search', 'ast_grep_replace', '$CODEX_HOME', 'developer_instructions', 'model_reasoning_effort', 'service_tier', 'cancel_task', 'task_id', 'Background Job Board', 'cli.cjs', 'directive.md', 'context7', 'gh_grep'];
const skillFiles = readdirSync(path.join(pluginDir, 'skills')).map((d) => path.join(pluginDir, 'skills', d, 'SKILL.md')).filter(existsSync);
const agentFiles = ['orchestrator', ...roles].map((r) => path.join(pluginDir, 'agents', `${r}.md`)).filter(existsSync);
for (const f of [...agentFiles, ...skillFiles]) {
  const t = read(f);
  for (const tok of residue) if (t.includes(tok)) errors.push(`${path.relative(root, f)} contains banned token: ${tok}`);
}
for (const f of agentFiles) check(!read(f).includes('SessionStart'), `${path.relative(root, f)} must not reference the removed SessionStart mechanism`);

// 8. README documents the new lifecycle
const readme = read(path.join(root, 'README.md'));
check(readme.includes('claude --agent oh-my-claude-code-slim:orchestrator'), 'README.md must document the --agent launch command');
check(readme.includes('OMCC_SLIM_DISABLE'), 'README.md must document the kill switch');
check(!readme.includes('SessionStart'), 'README.md must not claim SessionStart injection anymore');

// 9. defer schema validation to the real CLI
let strictOk = false;
try {
  execFileSync('claude', ['plugin', 'validate', pluginDir, '--strict'], { stdio: 'pipe' });
  strictOk = true;
} catch (e) {
  const out = `${e.stdout ? e.stdout.toString() : ''}${e.stderr ? e.stderr.toString() : ''}`.trim();
  errors.push(`\`claude plugin validate --strict\` failed:\n${out || e.message}`);
}

if (errors.length) {
  console.error(`Validation FAILED:\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`Validation passed.${strictOk ? ' (claude plugin validate --strict OK)' : ''}`);
