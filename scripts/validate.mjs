#!/usr/bin/env node
// Validator for oh-my-claude-code-slim. Asserts the omcc-specific invariants that
// `claude plugin validate --strict` does not — and EXECUTES the hook (not just greps it) so a
// logic regression in the split/gate cannot slip through — then defers schema validation to the
// real CLI.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'plugins', 'oh-my-claude-code-slim');
const hookDir = path.join(pluginDir, 'components', 'orchestrator-hook');
const cliPath = path.join(hookDir, 'cli.cjs');
const roles = ['explorer', 'librarian', 'oracle', 'designer', 'fixer'];
const roleModel = { explorer: 'claude-opus-4-6', librarian: 'claude-opus-4-6', oracle: 'claude-opus-4-8', designer: 'claude-opus-4-8', fixer: 'claude-opus-4-8' };

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
const read = (p) => readFileSync(p, 'utf8');

// 1. plugin.json
const manifest = JSON.parse(read(path.join(pluginDir, '.claude-plugin', 'plugin.json')));
check(manifest.name === 'oh-my-claude-code-slim', 'plugin.json name must be "oh-my-claude-code-slim"');
check(manifest.hooks === undefined, 'plugin.json must NOT declare "hooks" — hooks/hooks.json is auto-loaded; declaring it duplicates the load and fails the plugin');
check(existsSync(path.join(pluginDir, 'hooks', 'hooks.json')), 'hooks/hooks.json must exist (auto-loaded by Claude Code)');

// 2. marketplace.json (subdir source)
const market = JSON.parse(read(path.join(root, '.claude-plugin', 'marketplace.json')));
check(Array.isArray(market.plugins) && market.plugins.some((p) => p.source === './plugins/oh-my-claude-code-slim'), 'marketplace.json must list a plugin with source "./plugins/oh-my-claude-code-slim"');

// 3. hooks.json — matcher + TWO distinct SessionStart split handlers
const hooks = JSON.parse(read(path.join(pluginDir, 'hooks', 'hooks.json')));
const ssGroup = hooks.hooks?.SessionStart?.[0];
check(ssGroup?.matcher === 'startup|clear|compact', 'SessionStart matcher must be "startup|clear|compact"');
const ssHandlers = ssGroup?.hooks || [];
check(ssHandlers.length === 2, 'SessionStart must have exactly 2 command handlers (the two directive split parts)');
const ssArgs = ssHandlers.map((h) => JSON.stringify(h.args || []));
check(new Set(ssArgs).size === ssHandlers.length, 'the two SessionStart handlers must have DISTINCT args — identical command+args are deduped by Claude Code, silently dropping one directive part');
check(ssHandlers.some((h) => (h.args || []).includes('1')) && ssHandlers.some((h) => (h.args || []).includes('2')), 'SessionStart handlers must carry the part discriminators "1" and "2"');
check(read(path.join(pluginDir, 'hooks', 'hooks.json')).includes('${CLAUDE_PLUGIN_ROOT}'), 'hooks.json must use ${CLAUDE_PLUGIN_ROOT}');
check(!!hooks.hooks?.UserPromptSubmit, 'hooks.json must define a UserPromptSubmit hook');

// 4. cli.cjs RUNTIME behavior — execute the real hook with payloads (catches split/gate regressions)
function runHook(args, payload, extraEnv) {
  try {
    return execFileSync('node', [cliPath, ...args], {
      input: JSON.stringify(payload),
      env: { ...process.env, ...(extraEnv || {}) },
      encoding: 'utf8'
    }).trim();
  } catch (e) {
    errors.push(`cli.cjs execution failed (${args.join(' ')}): ${e.message}`);
    return '';
  }
}
const ctxOf = (out) => { if (!out) return ''; try { return JSON.parse(out).hookSpecificOutput.additionalContext || ''; } catch { return ''; } };

const part1 = ctxOf(runHook(['session-start', '1'], { hook_event_name: 'SessionStart', source: 'startup' }));
const part2 = ctxOf(runHook(['session-start', '2'], { hook_event_name: 'SessionStart', source: 'startup' }));
check(part1.length > 0 && part1.length < 10000, `SessionStart part 1 must be nonempty and <10000 chars (got ${part1.length})`);
check(part1.startsWith('<Role>') && part1.trimEnd().endsWith('</Agents>') && !part1.includes('<Workflow>'), 'SessionStart part 1 must be exactly <Role>+<Agents>');
check(part2.length > 0 && part2.length < 10000, `SessionStart part 2 must be nonempty and <10000 chars (got ${part2.length})`);
check(part2.startsWith('<Workflow>') && part2.trimEnd().endsWith('</Communication>') && !part2.includes('<Role>'), 'SessionStart part 2 must be exactly <Workflow>+<Communication>');

const anchorRoot = ctxOf(runHook(['user-prompt-submit'], { hook_event_name: 'UserPromptSubmit', prompt: 'x' }));
check(anchorRoot.includes('internal_reminder'), 'UserPromptSubmit must inject the anchor in a root session');
const anchorSub = runHook(['user-prompt-submit'], { hook_event_name: 'UserPromptSubmit', prompt: 'x', agent_id: 'agent-1' });
check(anchorSub === '', 'UserPromptSubmit must emit NOTHING in a subagent session (agent_id present)');

const disabled = runHook(['session-start', '1'], { hook_event_name: 'SessionStart', source: 'startup' }, { OMCC_SLIM_DISABLE: '1' });
check(disabled === '', 'OMCC_SLIM_DISABLE=1 must silence the hook');

// 5. directive.md has the four sections (runtime split already asserted above)
const directive = read(path.join(hookDir, 'directive.md')).replace(/\r\n/g, '\n').trim();
for (const tag of ['<Role>', '<Agents>', '<Workflow>', '<Communication>']) check(directive.includes(tag), `directive.md missing section ${tag}`);

// 6. agents: model, effort, read-only tool posture, and forbidden plugin-agent fields
for (const r of roles) {
  const ap = path.join(pluginDir, 'agents', `${r}.md`);
  if (!existsSync(ap)) { errors.push(`missing agent file agents/${r}.md`); continue; }
  const a = read(ap);
  check(a.startsWith('---'), `agents/${r}.md must start with YAML frontmatter`);
  check(new RegExp(`name:\\s*${r}\\b`).test(a), `agents/${r}.md frontmatter name must be "${r}"`);
  check(new RegExp(`model:\\s*${roleModel[r]}`).test(a), `agents/${r}.md must set model ${roleModel[r]}`);
  check(/\neffort:\s*\S+/.test(a), `agents/${r}.md must set effort`);
  for (const banned of ['permissionMode:', 'mcpServers:', 'hooks:']) {
    check(!new RegExp(`\\n${banned}`).test(a), `agents/${r}.md must not set "${banned}" (ignored for plugin agents)`);
  }
  const toolsLine = (a.match(/\ntools:\s*(.+)/) || [])[1] || '';
  const denyLine = (a.match(/\ndisallowedTools:\s*(.+)/) || [])[1] || '';
  if (r === 'explorer' || r === 'librarian') {
    check(toolsLine && !/\b(Write|Edit|NotebookEdit)\b/.test(toolsLine), `agents/${r}.md (read-only lane) must use a tools allowlist without Write/Edit`);
  }
  if (r === 'oracle') {
    check(/\bWrite\b/.test(denyLine) && /\bEdit\b/.test(denyLine), 'agents/oracle.md (read-only) must disallow Write and Edit');
  }
  if (r === 'fixer') {
    check(/\bWebFetch\b/.test(denyLine) && /\bWebSearch\b/.test(denyLine) && /\bAgent\b/.test(denyLine), 'agents/fixer.md must disallow WebFetch, WebSearch, and Agent (no research, no delegation)');
  }
}

// 7. Codex/OpenCode residue — directive + agents + skills (full banlist)
const residue = ['exec_command', 'apply_patch', 'spawn_agent', 'wait_agent', 'resume_agent', 'close_agent', 'gpt-5.5', '${PLUGIN_ROOT}', 'ast_grep_search', 'ast_grep_replace', '$CODEX_HOME', 'developer_instructions', 'model_reasoning_effort', 'service_tier'];
const skillFiles = readdirSync(path.join(pluginDir, 'skills')).map((d) => path.join(pluginDir, 'skills', d, 'SKILL.md')).filter(existsSync);
const scanFiles = [path.join(hookDir, 'directive.md'), ...roles.map((r) => path.join(pluginDir, 'agents', `${r}.md`)), ...skillFiles];
for (const f of scanFiles) {
  const t = read(f);
  for (const tok of residue) if (t.includes(tok)) errors.push(`${path.relative(root, f)} contains banned token: ${tok}`);
}
// README: narrower banlist — it intentionally documents the dropped apply_patch/ast_grep names.
const readmeResidue = ['exec_command', 'spawn_agent', 'wait_agent', 'resume_agent', 'close_agent', 'gpt-5.5', '${PLUGIN_ROOT}', '$CODEX_HOME', 'developer_instructions', 'model_reasoning_effort'];
const readme = read(path.join(root, 'README.md'));
for (const tok of readmeResidue) if (readme.includes(tok)) errors.push(`README.md contains banned token: ${tok}`);

// 8. defer schema validation to the real CLI
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
