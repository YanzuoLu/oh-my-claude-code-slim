#!/usr/bin/env node
'use strict';
// omcc-router: model-based request splitter for Claude Code mixed-model sessions.
// Listens on 127.0.0.1:<port> (default 8318); point ANTHROPIC_BASE_URL at it and
// each request is routed by the JSON body's `model` field according to a route
// table. Routes come from ~/.config/omcc-slim/router.json when present, else the
// builtin defaults below (gpt -> local CLIProxyAPI, k3/kimi -> api.kimi.com/coding,
// * -> api.anthropic.com passthrough). A route may optionally set "modelRewrite"
// (rewrite the body's model field) and/or "effort" (set output_config.effort) —
// only then is the body parsed/re-serialized; all other legs forward the raw
// buffer byte-for-byte. The file's mtime is statSync'd per request and the table
// hot-reloaded on change; a broken edit keeps the last good config.
// Responses are streamed (SSE-safe). One log line per proxied request on stdout.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const VERSION = '0.2.5';
const HOST = '127.0.0.1';
const CONFIG_PATH = path.join(os.homedir(), '.config', 'omcc-slim', 'router.json');

const BUILTIN_CONFIG = {
  port: 8318,
  routes: [
    { name: 'cpa', match: ['gpt'], baseUrl: 'http://127.0.0.1:8317', tokenEnv: 'CLAUDEX_TOKEN' },
    { name: 'kimi', match: ['k3', 'kimi'], baseUrl: 'https://api.kimi.com/coding', tokenEnv: 'KIMI_TOKEN' },
    { name: 'anthropic', match: ['*'], baseUrl: 'https://api.anthropic.com', passthrough: true },
  ],
};

const START = Date.now();
process.title = 'omcc-router';

let config = BUILTIN_CONFIG;
let configSource = 'builtin';
let configMtime = 0;
let watchConfig = false; // no config file at startup -> skip per-request checks

function loadConfigFile() {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!parsed || !Array.isArray(parsed.routes) || parsed.routes.length === 0) {
    throw new Error('invalid router config: missing routes');
  }
  return parsed;
}

try {
  const st = fs.statSync(CONFIG_PATH);
  config = loadConfigFile();
  configSource = CONFIG_PATH;
  configMtime = st.mtimeMs;
  watchConfig = true;
} catch (err) {
  if (err && err.code !== 'ENOENT') {
    console.log(`omcc-router: warning: failed to load ${CONFIG_PATH}: ${err.message}; using builtin defaults`);
  }
}

function maybeReloadConfig() {
  if (!watchConfig) return;
  let st;
  try { st = fs.statSync(CONFIG_PATH); } catch { return; } // file deleted: keep current
  if (st.mtimeMs === configMtime) return;
  configMtime = st.mtimeMs; // warn once per broken version, not per request
  try {
    config = loadConfigFile();
    configSource = CONFIG_PATH;
  } catch (err) {
    console.log(`omcc-router: warning: failed to reload ${CONFIG_PATH}: ${err.message}; keeping previous config`);
  }
}

// match: model name is lowercased, then substring-matched against the route's
// patterns in order; first route with a hit wins, "*" is the catch-all.
function route(model) {
  const m = String(model || '').toLowerCase();
  for (const r of config.routes) {
    for (const p of r.match || []) {
      if (p === '*' || m.includes(String(p))) return r;
    }
  }
  return config.routes[config.routes.length - 1];
}

function sendError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

const server = http.createServer((req, res) => {
  const t0 = Date.now();
  maybeReloadConfig();

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      uptime: Math.floor((Date.now() - START) / 1000),
      config: configSource,
      routes: config.routes.map((rt) => {
        const notes = [];
        if (rt.modelRewrite !== undefined) notes.push('rewrite');
        if (rt.effort !== undefined) notes.push(`effort:${rt.effort}`);
        return notes.length ? `${rt.name}(${notes.join(',')})` : rt.name;
      }),
    }));
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    let model = '';
    try { model = JSON.parse(body.toString('utf8')).model || ''; } catch { model = ''; }
    const r = route(model);

    res.on('finish', () => {
      console.log(`[${new Date().toISOString()}] model=${model || 'claude'} leg=${r.name} path=${req.url} status=${res.statusCode} ms=${Date.now() - t0}`);
    });

    // Optional route-level rewrites: the body is parsed/re-serialized ONLY when
    // the matched route configures modelRewrite and/or effort; every other leg
    // forwards the raw buffer byte-for-byte (passthrough purity preserved).
    let outBody = body;
    if (r.modelRewrite !== undefined || r.effort !== undefined) {
      try {
        const parsed = JSON.parse(body.toString('utf8'));
        if (r.modelRewrite !== undefined) parsed.model = r.modelRewrite;
        if (r.effort !== undefined) {
          if (!parsed.output_config || typeof parsed.output_config !== 'object') parsed.output_config = {};
          parsed.output_config.effort = r.effort;
        }
        outBody = Buffer.from(JSON.stringify(parsed), 'utf8');
      } catch { outBody = body; } // unparseable body: forward untouched
    }

    // Copy every original header; rebuild host/content-length/connection per
    // spec. passthrough legs keep the client Authorization untouched; token
    // legs replace it with Bearer $<tokenEnv>.
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length' || lk === 'connection') continue;
      headers[k] = v;
    }
    if (!r.passthrough) {
      const token = r.tokenEnv ? process.env[r.tokenEnv] : undefined;
      if (!token) {
        sendError(res, 500, 'authentication_error', `omcc-router: ${r.tokenEnv || 'token'} not set`);
        return;
      }
      headers.authorization = `Bearer ${token}`;
    }
    headers['content-length'] = outBody.length;

    const upstreamReq = (String(r.baseUrl).startsWith('https') ? https : http).request(r.baseUrl + req.url, {
      method: req.method,
      headers,
    }, (upstreamRes) => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'content-length' || lk === 'transfer-encoding' || lk === 'connection') continue;
        resHeaders[k] = v;
      }
      res.writeHead(upstreamRes.statusCode || 502, resHeaders);
      upstreamRes.pipe(res); // stream as chunks arrive (SSE must not be buffered)
    });
    upstreamReq.on('error', (err) => {
      if (res.headersSent) { res.destroy(); return; }
      sendError(res, 502, 'api_error', `omcc-router: upstream ${r.name} connect failed: ${err.message}`);
    });
    upstreamReq.end(outBody); // raw buffer unless the route rewrote it
  });
});

server.listen(config.port || 8318, HOST, () => {
  console.log(`omcc-router v${VERSION} listening on http://${HOST}:${server.address().port} pid=${process.pid}`);
  console.log(`omcc-router: config=${configSource} routes=${config.routes.map((r) => `${r.name}->${r.baseUrl}`).join(', ')}`);
});
