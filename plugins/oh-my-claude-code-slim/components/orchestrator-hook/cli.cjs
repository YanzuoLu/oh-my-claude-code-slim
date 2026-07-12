#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');

// omo-slim's per-turn reminder (PHASE_REMINDER), adapted to Claude Code's two completion
// paths: foreground Agents return one final tool result, while background/named Agents report
// completion automatically and can be continued with SendMessage. Teammate IDs are addresses,
// not TaskOutput task IDs.
const PHASE_REMINDER =
  '<internal_reminder>!IMPORTANT! Scheduler workflow: plan lanes/dependencies → ' +
  'delegate to specialist subagents → reconcile foreground results or automatic background ' +
  'completion messages → verify. Run independent subagents in parallel (non-overlapping scopes); ' +
  'do not act on partial results, fabricate progress, or pass teammate IDs to TaskOutput. ' +
  '!END!</internal_reminder>';

// The full directive exceeds Claude Code's 10,000-char additionalContext limit, so it is
// delivered in two SessionStart outputs split on the <Workflow> tag boundary:
//   part 1 = <Role> + <Agents>
//   part 2 = <Workflow> + <Communication>
// Claude Code appends each hook's additionalContext in order (no dedup), reassembling the
// full directive in the model's context.
const SPLIT_MARKER = '\n<Workflow>';

function isDisabled() {
  const value = process.env.OMCC_SLIM_DISABLE;
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function parseHookInput(input) {
  if (!input || input.trim() === '') {
    return null;
  }
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

async function loadDirective() {
  const directivePath = path.join(__dirname, 'directive.md');
  const contents = await fs.readFile(directivePath, 'utf8');
  return contents.replace(/\r\n/g, '\n').trim();
}

function directivePart(directive, part) {
  const index = directive.indexOf(SPLIT_MARKER);
  if (index === -1) {
    // No split point found: deliver the whole directive in part 1 (best effort).
    return part === '2' ? '' : directive;
  }
  if (part === '2') {
    return directive.slice(index + 1).trim(); // from "<Workflow>" to the end
  }
  return directive.slice(0, index).trim(); // "<Role>" + "<Agents>"
}

function emit(hookEventName, additionalContext) {
  if (!additionalContext) {
    return;
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } })}\n`);
}

async function main() {
  if (isDisabled()) {
    return;
  }

  const argv = process.argv.slice(2);
  const part = argv[1] === '2' ? '2' : '1'; // session-start part discriminator

  const payload = parseHookInput(await readStdin());
  const eventName = payload && typeof payload.hook_event_name === 'string' ? payload.hook_event_name : null;

  if (eventName === 'SessionStart') {
    // Full orchestrator directive, delivered once per session start/clear/compact, split into
    // two <10k parts (omo delivers it via the OpenCode system channel; on Claude Code the
    // official pattern is a SessionStart hook emitting hookSpecificOutput.additionalContext).
    const directive = await loadDirective();
    emit('SessionStart', directivePart(directive, part));
    return;
  }

  if (eventName === 'UserPromptSubmit') {
    // Inject the per-turn anchor ONLY in the root orchestrator session. Claude Code fires
    // hooks inside subagent (Task/Agent) sessions too, but those payloads carry `agent_id`
    // (the root/main session omits it). Skipping subagents keeps the orchestrator scheduler
    // reminder out of specialist contexts.
    const isSubagent = payload && typeof payload.agent_id === 'string';
    if (!isSubagent) {
      emit('UserPromptSubmit', PHASE_REMINDER);
    }
    return;
  }
}

main().catch((error) => {
  process.stderr.write(`oh-my-claude-code-slim hook error: ${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 0;
});
