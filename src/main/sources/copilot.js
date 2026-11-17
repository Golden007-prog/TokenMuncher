// GitHub Copilot: monthly quotas from api.github.com/copilot_internal/user
// (unofficial). Uses the GitHub CLI login (`gh auth token`) or GH_TOKEN.
// No per-request data is available, so Copilot shows up only under limits.
const { getJson, ghToken } = require('./common');

const POLL_MS = 5 * 60e3;
const NAMES = { premium_interactions: 'premium requests', chat: 'chat messages', completions: 'completions' };

function planOf(j) {
  if (/free/.test(j.access_type_sku || '')) return { name: 'Free', price: 0 };
  const p = j.copilot_plan || '';
  if (/business/.test(p)) return { name: 'Business', price: 19 };
  if (/enterprise/.test(p)) return { name: 'Enterprise', price: 39 };
  if (/plus|pro_plus/.test(j.access_type_sku || '')) return { name: 'Pro+', price: 39 };
  return { name: 'Pro', price: 10 };
}

class CopilotSource {
  constructor() {
    this.id = 'copilot';
    this.st = { plan: null, error: null, fetchedAt: 0, quotas: [], resetsAt: null };
    this.hasAuth = false;
    this.timer = null;
  }

  get enabled() { return this.hasAuth; }
  diagnostics() { return { githubLogin: this.hasAuth }; }
  init() { return Promise.resolve(); }
  tick() { return Promise.resolve(); }

  async poll() {
    const token = await ghToken();
    this.hasAuth = !!token;
    if (!token) return;
    const r = await getJson('https://api.github.com/copilot_internal/user', {
      headers: { Authorization: 'token ' + token, Accept: 'application/json', 'User-Agent': 'tokenmuncher/0.2', 'Editor-Version': 'vscode/1.95.0' }
    });
    if (r.status === 404 || r.status === 401) { this.hasAuth = false; return; } // no Copilot on this account
    if (r.status !== 200 || !r.json) { this.st.error = r.error ? 'offline · ' + r.error : 'HTTP ' + r.status; return; }
    const j = r.json;
    const q = j.quota_snapshots || {};
    this.st.plan = planOf(j);
    this.st.resetsAt = j.quota_reset_date_utc ? Date.parse(j.quota_reset_date_utc) : j.quota_reset_date ? Date.parse(j.quota_reset_date) : null;
    this.st.quotas = Object.keys(NAMES)
      .filter(k => q[k] && !q[k].unlimited && q[k].entitlement > 0)
      .map(k => ({ key: k, name: NAMES[k], percent: Math.max(0, 100 - (q[k].percent_remaining ?? 100)) }));
    this.st.fetchedAt = Date.now();
    this.st.error = null;
  }

  start(onUpdate) {
    const loop = async () => {
      try { await this.poll(); } catch (e) { this.st.error = e.message; }
      onUpdate();
      if (!this.off) this.timer = setTimeout(loop, POLL_MS); // switched off meanwhile: main restarts it
    };
    this.onUpdate = onUpdate;
    loop();
  }

  refresh() { clearTimeout(this.timer); this.start(this.onUpdate); }

  status() { return { id: 'copilot', label: 'copilot', plan: this.st.plan, error: this.st.error, fetchedAt: this.st.fetchedAt }; }

  limits() {
    const reset = this.st.resetsAt;
    let windowSec = 30 * 86400;
    if (reset) { const d = new Date(reset); d.setUTCMonth(d.getUTCMonth() - 1); windowSec = (reset - d.getTime()) / 1000; }
    return this.st.quotas.map(q => ({
      key: 'copilot:' + q.key, provider: 'copilot', kind: 'monthly', name: q.name, percent: q.percent,
      resetsAt: reset, windowSec, integer: false, fetchedAt: this.st.fetchedAt, match: null
    }));
  }
}

module.exports = { CopilotSource };
