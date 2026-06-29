#!/usr/bin/env node
// Lean validator for oh-my-claude-code-slim. Asserts ONLY what `claude plugin validate
// --strict` does not (Codex/OpenCode residue, root-only gate, split-size budget, matcher,
// plugin-agent frontmatter rules), then defers schema validation to `claude plugin validate`.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'plugins', 'oh-my-claude-code-slim');
const hookDir = path.join(pluginDir, 'components', 'orchestrator-hook');
const roles = ['explorer', 'librarian', 'oracle', 'designer', 'fixer'];
const roleModel = { explorer: 'claude-opus-4-6', librarian: 'claude-opus-4-6', oracle: 'claude-opus-4-8', designer: 'claude-opus-4-8', fixer: 'claude-opus-4-8' };

const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };
const read = (p) => readFileSync(p, 'utf8');

// 1. plugin.json
const manifest = JSON.parse(read(path.join(pluginDir, '.claude-plugin', 'plugin.json')));
check(manifest.name === 'oh-my-claude-code-slim', 'plugin.json name must be "oh-my-claude-code-slim"');
check(manifest.hooks === './hooks/hooks.json', 'plugin.json must reference "./hooks/hooks.json"');

// 2. marketplace.json (subdir source, per oracle G3)
const market = JSON.parse(read(path.join(root, '.claude-plugin', 'marketplace.json')));
check(
  Array.isArray(market.plugins) &&
    market.plugins.some((p) => p.source === './plugins/oh-my-claude-code-slim'),
  'marketplace.json must list a plugin with source "./plugins/oh-my-claude-code-slim"'
);

// 3. hooks.json
const hooks = JSON.parse(read(path.join(pluginDir, 'hooks', 'hooks.json')));
const ss = hooks.hooks?.SessionStart?.[0];
check(ss?.matcher === 'startup|clear|compact', 'SessionStart matcher must be "startup|clear|compact"');
check((ss?.hooks?.length || 0) === 2, 'SessionStart must have 2 command handlers (the two directive split parts)');
check(read(path.join(pluginDir, 'hooks', 'hooks.json')).includes('${CLAUDE_PLUGIN_ROOT}'), 'hooks.json must use ${CLAUDE_PLUGIN_ROOT}');
check(!!hooks.hooks?.UserPromptSubmit, 'hooks.json must define a UserPromptSubmit hook');

// 4. cli.cjs (root-only gate + disable + split)
const cli = read(path.join(hookDir, 'cli.cjs'));
check(cli.includes('agent_id'), 'cli.cjs must gate the per-turn anchor on `agent_id` (root-only)');
check(cli.includes('OMCC_SLIM_DISABLE'), 'cli.cjs must honor OMCC_SLIM_DISABLE');
check(cli.includes('SPLIT_MARKER'), 'cli.cjs must split the directive into two parts');

// 5. directive: 4 sections + both split parts < 10k
const directive = read(path.join(hookDir, 'directive.md')).replace(/\r\n/g, '\n').trim();
for (const tag of ['<Role>', '<Agents>', '<Workflow>', '<Communication>']) {
  check(directive.includes(tag), `directive.md missing section ${tag}`);
}
const idx = directive.indexOf('\n<Workflow>');
check(idx !== -1, 'directive.md must contain a "\\n<Workflow>" split boundary');
if (idx !== -1) {
  const p1 = directive.slice(0, idx).trim();
  const p2 = directive.slice(idx + 1).trim();
  check(p1.length < 10000, `directive part 1 must be < 10000 chars (got ${p1.length})`);
  check(p2.length < 10000, `directive part 2 must be < 10000 chars (got ${p2.length})`);
}

// 6. agents: frontmatter rules (plugin agents must NOT set permissionMode/hooks/mcpServers)
for (const r of roles) {
  const ap = path.join(pluginDir, 'agents', `${r}.md`);
  if (!existsSync(ap)) { errors.push(`missing agent file agents/${r}.md`); continue; }
  const a = read(ap);
  check(a.startsWith('---'), `agents/${r}.md must start with YAML frontmatter`);
  check(new RegExp(`name:\\s*${r}\\b`).test(a), `agents/${r}.md frontmatter name must be "${r}"`);
  check(new RegExp(`model:\\s*${roleModel[r]}`).test(a), `agents/${r}.md must set model ${roleModel[r]}`);
  for (const banned of ['permissionMode:', 'mcpServers:', 'hooks:']) {
    check(!new RegExp(`\\n${banned}`).test(a), `agents/${r}.md must not set "${banned}" (ignored for plugin agents)`);
  }
}

// 7. Codex/OpenCode residue across model-facing files
const residue = [
  'exec_command', 'apply_patch', 'spawn_agent', 'wait_agent', 'resume_agent', 'close_agent',
  'gpt-5.5', '${PLUGIN_ROOT}', 'ast_grep_search', 'ast_grep_replace', '$CODEX_HOME',
  'developer_instructions', 'model_reasoning_effort', 'service_tier'
];
const scanFiles = [path.join(hookDir, 'directive.md'), ...roles.map((r) => path.join(pluginDir, 'agents', `${r}.md`))];
for (const f of scanFiles) {
  if (!existsSync(f)) continue;
  const t = read(f);
  for (const tok of residue) {
    if (t.includes(tok)) errors.push(`${path.relative(root, f)} contains banned token: ${tok}`);
  }
}

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
