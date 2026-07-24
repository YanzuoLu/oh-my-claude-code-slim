#!/usr/bin/env node
'use strict';
// oh-my-claude-code-slim SessionStart hook: auto-start the omcc-router model
// splitter when the session's ANTHROPIC_BASE_URL points at it (port 8318).
// Plain sessions exit immediately with zero network overhead. Always silent
// (no stdout), always exit 0. CLAUDEX_TOKEN / KIMI_TOKEN are inherited from the
// user's shell environment as-is.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HEALTH_URL = 'http://127.0.0.1:8318/health';
const LOG_FILE = path.join(os.homedir(), '.claude', 'plugins', 'data', 'omcc-router.log');

function healthy(cb) {
  let done = false;
  const finish = (ok) => { if (!done) { done = true; cb(ok); } };
  const req = http.get(HEALTH_URL, { timeout: 300 }, (res) => {
    res.resume();
    finish(res.statusCode === 200);
  });
  req.on('timeout', () => { req.destroy(); finish(false); });
  req.on('error', () => finish(false));
}

function main() {
  // Style parity with reminder.cjs: consume the hook payload from stdin first.
  try { fs.readFileSync(0, 'utf8'); } catch {}

  const base = String(process.env.ANTHROPIC_BASE_URL || '');
  if (!base.includes(':8318') && !base.includes('8318')) return process.exit(0);

  healthy((ok) => {
    if (ok) return process.exit(0);
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      const out = fs.openSync(LOG_FILE, 'a');
      const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
      const child = spawn(process.execPath, [path.join(root, 'router', 'omcc-router.js')], {
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
    } catch {}
    // Poll up to 2s for the router to come up; exit silently either way.
    const deadline = Date.now() + 2000;
    const poll = () => {
      healthy((up) => {
        if (up || Date.now() >= deadline) return process.exit(0);
        setTimeout(poll, 100);
      });
    };
    poll();
  });
}

try { main(); } catch { process.exit(0); }
