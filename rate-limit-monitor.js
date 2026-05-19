'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'logs', 'rate-limit.jsonl');
const OPENCLAW_BIN = '/Users/rafaelreisr/.nvm/versions/node/v24.14.1/bin/openclaw';
const CHANNEL = 'telegram';
const ACCOUNT = 'default';
const TARGET  = '146330741';  // Telegram chat_id (username rr0174)
const HYSTERESIS = 0.05;
const GLOBAL_COOLDOWN_MS = 60_000;

const THRESHOLDS = [
  { level: 0.70, label: '⚠️  5h em 70%' },
  { level: 0.85, label: '🟠 5h em 85% — fallback provável' },
  { level: 0.95, label: '🔴 5h em 95% — 429 iminente' },
];

const armed = new Map(THRESHOLDS.map(t => [t.level, true]));
let alerted429 = false;
let lastAlertTs = 0;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pct(v) { return v == null ? '?' : Math.round(v * 100) + '%'; }

function sendAlert(text) {
  const now = Date.now();
  if (now - lastAlertTs < GLOBAL_COOLDOWN_MS) return false;
  lastAlertTs = now;
  try {
    const child = spawn(OPENCLAW_BIN, [
      'message', 'send',
      '--channel', CHANNEL,
      '--account', ACCOUNT,
      '--target',  TARGET,
      '--message', text,
    ], { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', e => console.error('[rate-limit-monitor] spawn err:', e.message));
    child.unref();
    return true;
  } catch (e) {
    console.error('[rate-limit-monitor] alert failed:', e.message);
    return false;
  }
}

function recordResponse(status, headers) {
  if (!headers) return;
  const u5 = num(headers['anthropic-ratelimit-unified-5h-utilization']);
  const u7 = num(headers['anthropic-ratelimit-unified-7d-utilization']);
  const st = headers['anthropic-ratelimit-unified-status'];
  const claim = headers['anthropic-ratelimit-unified-representative-claim'];
  const fb = num(headers['anthropic-ratelimit-unified-fallback-percentage']);
  const r5 = num(headers['anthropic-ratelimit-unified-5h-reset']);
  const r7 = num(headers['anthropic-ratelimit-unified-7d-reset']);
  // Sonnet/Opus split (best-effort: capture if Anthropic exposes per-model)
  const uSon = num(headers['anthropic-ratelimit-unified-sonnet-utilization']);
  const rSon = num(headers['anthropic-ratelimit-unified-sonnet-reset']);
  // Capture all anthropic-ratelimit-* headers for forensics on rare names
  const allRl = {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase().startsWith('anthropic-ratelimit-')) allRl[k] = headers[k];
  }

  if (u5 != null || status === 429) {
    const rec = { ts: new Date().toISOString(), st: status, u5, u7, claim, s: st, fb, r5, r7, uSon, rSon, raw: allRl };
    fs.appendFile(LOG_PATH, JSON.stringify(rec) + '\n', () => {});
  }

  if (u5 != null) {
    for (const t of THRESHOLDS) {
      if (u5 >= t.level && armed.get(t.level)) {
        armed.set(t.level, false);
        sendAlert(`${t.label}\n5h: ${pct(u5)} · 7d: ${pct(u7)}`);
      } else if (u5 < t.level - HYSTERESIS && !armed.get(t.level)) {
        armed.set(t.level, true);
      }
    }
  }

  if (status === 429) {
    if (!alerted429) {
      alerted429 = true;
      sendAlert(`🚫 429 rate_limit_error\n5h: ${pct(u5)} · 7d: ${pct(u7)}`);
    }
  } else if (status === 200 && u5 != null && u5 < 0.90) {
    alerted429 = false;
  }
}

module.exports = { recordResponse };
