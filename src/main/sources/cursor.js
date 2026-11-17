// Cursor: plan usage and per-request token events from the cursor.com dashboard
// endpoints (unofficial). The session token is read from Cursor's local state
// database, which is opened read-only; conversation titles, repos and context
// size come from the same database.
const fs = require('fs');
const path = require('path');
const { getJson, projectOf } = require('./common');

const DB = path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const BASE = 'https://cursor.com/api/dashboard/';
const POLL_MS = 120e3;
const PLANS = { pro: ['Pro', 20], pro_plus: ['Pro+', 60], ultra: ['Ultra', 200], free: ['Free', 0], free_trial: ['Trial', 0], business: ['Teams', 40], enterprise: ['Enterprise', 40] };

let Database = null;
function openDb() {
  if (!Database) Database = require('better-sqlite3');
  return new Database(DB, { readonly: true, fileMustExist: true });
}

class CursorSource {
  constructor(store) {
    this.id = 'cursor';
    this.store = store;
    this.st = { plan: null, error: null, fetchedAt: 0, cycleStart: 0, cycleEnd: 0, auto: null, api: null };
    this.autoModels = new Set();
    this.known = new Set();
    this.meta = new Map(); // conversationId -> { project, title, ctx, ctxMax, readAt }
    this.timer = null;
  }

  get enabled() { return fs.existsSync(DB); }
  diagnostics() { return { database: { path: DB, exists: fs.existsSync(DB) } }; }
  init() { return Promise.resolve(); }
  tick() { return Promise.resolve(); }

  readAuth() {
    const db = openDb();
    try {
      const get = k => { const r = db.prepare('select value from ItemTable where key = ?').get(k); return r ? String(r.value) : null; };
      return { token: get('cursorAuth/accessToken'), membership: get('cursorAuth/stripeMembershipType') };
    } finally { db.close(); }
  }

  readMeta(ids) {
    if (!ids.length) return;
    const db = openDb();
    try {
      const q = db.prepare(`select json_extract(value, '$.name') name, json_extract(value, '$.trackedGitRepos[0].repoPath') repo,
        json_extract(value, '$.contextTokensUsed') ctx, json_extract(value, '$.contextTokenLimit') lim
        from cursorDiskKV where key = ?`);
      for (const id of ids) {
        let r = null;
        try { r = q.get('composerData:' + id); } catch { /* malformed row */ }
        this.meta.set(id, {
          project: r && r.repo ? projectOf(r.repo) : 'cursor', title: (r && r.name) || '',
          ctx: (r && r.ctx) || 0, ctxMax: (r && r.lim) || 0, readAt: Date.now()
        });
      }
    } finally { db.close(); }
  }

  async poll() {
    let auth;
    try { auth = this.readAuth(); } catch (e) { this.st.error = 'cannot read Cursor state · ' + e.message; return; }
    if (!auth.token) { this.st.error = 'not logged in to Cursor'; return; }
    const m = PLANS[auth.membership] || [auth.membership || '?', null];
    this.st.plan = { name: m[0], price: m[1] };
    let uid;
    try { uid = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString()).sub.split('|').pop(); } catch { this.st.error = 'unexpected Cursor token'; return; }
    const headers = {
      Cookie: `WorkosCursorSessionToken=${uid}%3A%3A${auth.token}`, Origin: 'https://cursor.com',
      Referer: 'https://cursor.com/dashboard', 'Content-Type': 'application/json', 'User-Agent': 'tokenmuncher/0.2'
    };
    const post = (ep, body) => getJson(BASE + ep, { method: 'POST', headers, body: JSON.stringify(body) });

    const cp = await post('get-current-period-usage', {});
    if (cp.status === 401 || cp.status === 403) { this.st.error = 'login expired · open Cursor'; return; }
    if (cp.status !== 200 || !cp.json) { this.st.error = cp.error ? 'offline · ' + cp.error : 'HTTP ' + cp.status; return; }
    const pu = cp.json.planUsage || {};
    Object.assign(this.st, {
      cycleStart: +cp.json.billingCycleStart || 0, cycleEnd: +cp.json.billingCycleEnd || 0,
      auto: pu.autoPercentUsed != null ? +pu.autoPercentUsed : null, api: pu.apiPercentUsed != null ? +pu.apiPercentUsed : null
    });
    this.autoModels = new Set(cp.json.autoBucketModels || []);
    if (this.st.cycleStart) this.store.setFloor('cursor', this.st.cycleStart);

    // Newest first; stop at the first event we already have.
    const start = Math.min(this.store.cutoff, this.st.cycleStart || this.store.cutoff);
    const fresh = [];
    for (let page = 1; page <= 30; page++) {
      const r = await post('get-filtered-usage-events', { startDate: String(start), endDate: String(Date.now()), page, pageSize: 100 });
      const list = (r.json && r.json.usageEventsDisplay) || [];
      let stop = false;
      for (const e of list) {
        const id = e.usageEventId || e.timestamp + e.model;
        if (this.known.has(id)) { stop = true; break; }
        this.known.add(id);
        fresh.push(e);
      }
      if (stop || list.length < 100) break;
    }

    // Conversation metadata: new ones, plus a refresh for ones active in the last hour.
    const ids = new Set();
    for (const e of fresh) if (e.conversationId && !this.meta.has(e.conversationId)) ids.add(e.conversationId);
    for (const [id, mt] of this.meta) if (Date.now() - mt.readAt > 10 * 60e3 && this.store.sessions.get('cursor:' + id)?.lastTs > Date.now() - 3600e3) ids.add(id);
    try { this.readMeta([...ids]); } catch { /* metadata is optional */ }

    const S = this.store;
    for (const e of fresh.reverse()) {
      const ts = +e.timestamp;
      const tu = e.tokenUsage || {};
      const conv = e.conversationId || 'none';
      const mt = this.meta.get(conv) || { project: 'cursor', title: '' };
      const sid = 'cursor:' + conv;
      const t = { in: tu.inputTokens || 0, out: tu.outputTokens || 0, cr: tu.cacheReadTokens || 0, cw: tu.cacheWriteTokens || 0 };
      const total = t.in + t.out + t.cr + t.cw;
      const s = S.session(sid, { provider: 'cursor', project: mt.project, app: 'Cursor', model: e.model });
      if (ts >= s.lastTs) { s.lastTs = ts; s.model = e.model; }
      S.addRecord('cursor:' + (e.usageEventId || ts), {
        ts, provider: 'cursor', sid, project: mt.project, app: 'Cursor', model: e.model || '?', fam: 'cursor',
        bucket: this.autoModels.has(e.model) ? 'auto' : 'api', ...t, total, cost: (tu.totalCents ?? e.chargedCents ?? 0) / 100
      });
      S.addEvent('cursor:' + (e.usageEventId || ts), { ts, provider: 'cursor', project: mt.project, text: `${mt.title || 'request'} · ${e.model}`, tok: total, cr: t.cr, kind: 'tool' }, sid);
    }
    for (const [id, mt] of this.meta) {
      const s = S.sessions.get('cursor:' + id);
      if (!s) continue;
      s.project = mt.project; s.lastAction = mt.title; s.ctx = mt.ctx; s.ctxMax = mt.ctxMax;
    }
    this.st.fetchedAt = Date.now();
    this.st.error = null;
  }

  start(onUpdate) {
    const loop = async () => {
      if (this.enabled) { try { await this.poll(); } catch (e) { this.st.error = e.message; } }
      onUpdate();
      if (!this.off) this.timer = setTimeout(loop, POLL_MS); // switched off meanwhile: main restarts it
    };
    this.onUpdate = onUpdate;
    loop();
  }

  refresh() { clearTimeout(this.timer); this.start(this.onUpdate); }

  status() { return { id: 'cursor', label: 'cursor', plan: this.st.plan, error: this.st.error, fetchedAt: this.st.fetchedAt }; }

  limits() {
    const { cycleStart, cycleEnd } = this.st;
    if (!cycleEnd) return [];
    const base = { provider: 'cursor', kind: 'monthly', resetsAt: cycleEnd, windowSec: (cycleEnd - cycleStart) / 1000, integer: false, fetchedAt: this.st.fetchedAt };
    const out = [];
    if (this.st.auto != null) out.push({ ...base, key: 'cursor:auto', name: 'auto + composer', percent: this.st.auto, match: r => r.provider === 'cursor' && r.bucket === 'auto' });
    if (this.st.api != null) out.push({ ...base, key: 'cursor:api', name: 'api models', percent: this.st.api, match: r => r.provider === 'cursor' && r.bucket === 'api' });
    return out;
  }
}

module.exports = { CursorSource };
