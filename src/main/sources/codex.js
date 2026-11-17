// Codex (CLI and IDE extension): local rollout logs in ~/.codex/sessions/**/rollout-*.jsonl.
// token_count events carry cumulative token usage and the plan rate limits
// (primary ≈ 5h window, secondary ≈ weekly). Written against the documented
// rollout format; not tested on a machine with Codex installed.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonlTail } = require('../jsonl');
const { costOpenAI } = require('../pricing');
const { projectOf, relPath } = require('./common');

const HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ROOTS = [path.join(HOME, 'sessions'), path.join(HOME, 'archived_sessions')];
const ZERO = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function shellText(cmd) {
  if (Array.isArray(cmd)) {
    const i = cmd.findIndex(a => a === '-lc' || a === '-c' || /^-command$/i.test(a));
    cmd = i >= 0 && cmd[i + 1] ? cmd[i + 1] : cmd.join(' ');
  }
  return String(cmd || '').split('\n')[0].slice(0, 100);
}

class CodexSource {
  constructor(store) {
    this.id = 'codex';
    this.store = store;
    this.tail = new JsonlTail(ROOTS, (line, file) => this.onLine(line, file), () => store.cutoff);
    this.files = new Map();   // file -> per-session parse state
    this.rl = {};             // 'primary' | 'secondary' -> latest snapshot
    this.plan = null;
    // Since start, for diagnostics: what the parser recognised, and the types
    // of lines it skipped (a different log format shows up here).
    this.stats = { badJson: 0, noTimestampOrPayload: 0, sessionMeta: 0, turnContext: 0, tokenCount: 0, tokenCountNoUsage: 0, rateLimits: 0, toolCalls: 0, skippedTypes: Object.create(null) };
  }

  get enabled() { return ROOTS.some(r => fs.existsSync(r)); }

  // ── on-disk usage cache: read positions plus the parser state each file needs
  // to continue (cumulative token totals, model, cwd) and the last rate limits ──
  get changes() { return this.tail.changes; }
  exportState() {
    const tail = this.tail.exportState();
    const kept = new Set(tail.map(([p]) => p)); // parser state only for files the tail still tracks
    return { tail, files: [...this.files].filter(([p]) => kept.has(p)), rl: this.rl, plan: this.plan };
  }
  importState(s) {
    this.tail.importState(s.tail);
    this.files = new Map(Array.isArray(s.files) ? s.files : []);
    this.rl = s.rl && typeof s.rl === 'object' ? s.rl : {};
    this.plan = s.plan || null;
  }
  init() { return this.enabled ? this.tail.scan(true) : Promise.resolve(); }
  tick() { return this.enabled ? this.tail.scan(false) : Promise.resolve(); }

  onLine(line, file) {
    if (!/"(session_meta|turn_context|token_count|function_call|custom_tool_call|local_shell_call)"/.test(line)) {
      // "outer/inner": the line's type and its payload's type (response_item/reasoning)
      const outer = /^\{[^{]*?"type"\s*:\s*"([\w.-]{1,40})"/.exec(line) || /"type"\s*:\s*"([\w.-]{1,40})"/.exec(line);
      const inner = /"payload"\s*:\s*\{[^{}]*?"type"\s*:\s*"([\w.-]{1,40})"/.exec(line);
      const k = (outer ? outer[1] : '?') + (inner ? '/' + inner[1] : '');
      const seen = this.stats.skippedTypes;
      if (Object.hasOwn(seen, k) || Object.keys(seen).length < 30) seen[k] = (seen[k] || 0) + 1;
      return;
    }
    let d;
    try { d = JSON.parse(line); } catch { this.stats.badJson++; return; }
    const ts = Date.parse(d.timestamp);
    const p = d.payload;
    if (!ts || !p) { this.stats.noTimestampOrPayload++; return; }
    let f = this.files.get(file);
    if (!f) {
      f = { sid: 'codex:' + path.basename(file, '.jsonl'), cwd: '', project: '?', model: '', app: 'Codex', prev: ZERO };
      this.files.set(file, f);
    }
    const S = this.store;

    if (d.type === 'session_meta') {
      this.stats.sessionMeta++;
      if (p.id) f.sid = 'codex:' + p.id;
      if (p.cwd) { f.cwd = p.cwd; f.project = projectOf(p.cwd); }
      f.app = /vscode|ide/i.test(p.originator || '') ? 'Codex · IDE' : 'Codex CLI';
      if (p.model) f.model = p.model;
      return;
    }
    if (d.type === 'turn_context') {
      this.stats.turnContext++;
      if (p.model) f.model = p.model;
      if (p.cwd) { f.cwd = p.cwd; f.project = projectOf(p.cwd); }
      return;
    }
    if (d.type === 'event_msg' && p.type === 'token_count') {
      this.onTokens(p, ts, f);
      return;
    }
    if (d.type === 'response_item' && ts >= S.cutoff) {
      let text = null;
      if (p.type === 'function_call') {
        let args = {};
        try { args = JSON.parse(p.arguments || '{}'); } catch { /* ignore */ }
        text = args.command ? `${p.name}: ${shellText(args.command)}` : p.name;
      } else if (p.type === 'local_shell_call') {
        text = `shell: ${shellText(p.action && p.action.command)}`;
      } else if (p.type === 'custom_tool_call') {
        const m = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(p.input || '');
        text = m ? `${p.name} ${relPath(m[1].trim(), f.cwd)}` : p.name;
      }
      if (!text) return;
      this.stats.toolCalls++;
      S.addEvent('codex:' + (p.call_id || p.id || ts), { ts, provider: 'codex', project: f.project, text, tok: 0, kind: 'tool' }, f.sid);
      const s = S.sessions.get(f.sid);
      if (s && ts >= s.lastTs - 1) s.lastAction = text;
    }
  }

  onTokens(p, ts, f) {
    const S = this.store;
    const info = p.info;
    this.stats.tokenCount++;
    if (!(info && info.total_token_usage)) this.stats.tokenCountNoUsage++;
    if (p.rate_limits) this.stats.rateLimits++;
    if (info && info.total_token_usage) {
      const t = info.total_token_usage;
      let prev = f.prev;
      if ((t.total_tokens || 0) < (prev.total_tokens || 0)) prev = ZERO; // counter restarted
      if ((t.total_tokens || 0) > (prev.total_tokens || 0)) {
        const inAll = Math.max(0, (t.input_tokens || 0) - (prev.input_tokens || 0));
        const cached = Math.max(0, (t.cached_input_tokens || 0) - (prev.cached_input_tokens || 0));
        const out = Math.max(0, (t.output_tokens || 0) - (prev.output_tokens || 0));
        const fresh = Math.max(0, inAll - cached);
        const model = f.model || 'gpt-5';
        const s = S.session(f.sid, { provider: 'codex', project: f.project, app: f.app, model });
        s.project = f.project; s.app = f.app; s.model = model;
        if (ts > s.lastTs) s.lastTs = ts;
        if (info.last_token_usage) {
          s.ctx = info.last_token_usage.input_tokens || 0;
          s.ctxMax = info.model_context_window || 272e3;
          s.ctxTs = ts;
        }
        S.addRecord(f.sid + ':' + t.total_tokens, {
          ts, provider: 'codex', sid: f.sid, project: f.project, app: f.app, model, fam: 'codex',
          in: fresh, out, cr: cached, cw: 0, total: fresh + cached + out, cost: costOpenAI(model, { in: fresh, cr: cached, out })
        });
      }
      f.prev = t;
    }
    const rl = p.rate_limits;
    if (rl) {
      for (const k of ['primary', 'secondary']) {
        const w = rl[k];
        if (!w || w.used_percent == null) continue;
        if (this.rl[k] && this.rl[k].ts > ts) continue;
        let resetsAt = null;
        if (w.resets_at != null) resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : w.resets_at > 1e12 ? w.resets_at : w.resets_at * 1000;
        else if (w.resets_in_seconds != null) resetsAt = ts + w.resets_in_seconds * 1000;
        this.rl[k] = { ts, percent: +w.used_percent, windowMin: w.window_minutes || (k === 'primary' ? 300 : 10080), resetsAt };
      }
      if (rl.plan_type) this.plan = { name: String(rl.plan_type), price: null };
    }
  }

  diagnostics() {
    return {
      logFolders: ROOTS.map(r => ({ path: r, exists: fs.existsSync(r) })), codexHomeFromEnv: !!process.env.CODEX_HOME,
      filesTracked: this.tail.files.size, linesRead: this.tail.linesRead, parser: this.stats,
      rateLimits: Object.fromEntries(Object.entries(this.rl).map(([k, x]) => [k, { percent: x.percent, windowMin: x.windowMin, resetsAt: x.resetsAt, seenAt: x.ts }]))
    };
  }

  status() {
    const any = this.rl.primary || this.rl.secondary;
    return { id: 'codex', label: 'codex', plan: this.plan, error: null, fetchedAt: any ? Math.max(...Object.values(this.rl).map(x => x.ts)) : 0 };
  }

  limits() {
    const now = Date.now();
    return ['primary', 'secondary'].filter(k => this.rl[k]).map(k => {
      const x = this.rl[k];
      const expired = x.resetsAt && x.resetsAt < now;
      const h = x.windowMin / 60;
      return {
        key: 'codex:' + k, provider: 'codex', kind: h <= 24 ? 'session' : 'weekly',
        name: h <= 24 ? `${Math.round(h)}h window` : h >= 24 * 6 && h <= 24 * 8 ? 'weekly' : `${Math.round(h / 24)}d window`,
        percent: expired ? 0 : x.percent, resetsAt: expired ? null : x.resetsAt, windowSec: x.windowMin * 60,
        integer: false, synthetic: !!expired, fetchedAt: x.ts, match: r => r.provider === 'codex'
      };
    });
  }
}

module.exports = { CodexSource };
