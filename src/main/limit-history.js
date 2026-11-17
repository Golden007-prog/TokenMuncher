// Recorded limit readings over time, kept in limit-history.jsonl (one JSON
// array per line: [t, key, percent, estimate, resetsAt, kind]; kind since
// 0.9.2). Readings are added when the server value changes and at least every
// 5 minutes, appended to the file in batches, and dropped after 8 weeks, or
// MONTHLY_KEEP_MS for monthly limits so a whole previous billing cycle stays
// (on load and every few hours).
// Values the app made up itself (a window that rolled over before the next
// fetch) are not recorded: only what a source actually reported.
const fs = require('fs');
const fsp = fs.promises;

const KEEP_MS = 56 * 86400e3;
const MONTHLY_KEEP_MS = 100 * 86400e3;
const EVERY_MS = 5 * 60e3;
const PRUNE_EVERY_MS = 6 * 3600e3;
const round2 = n => Math.round(n * 100) / 100;

// First index in a time-sorted list with t >= from.
function lowerBound(list, from) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < from) lo = mid + 1; else hi = mid; }
  return lo;
}

class LimitHistory {
  constructor(file, { keepMs = KEEP_MS, monthlyKeepMs = MONTHLY_KEEP_MS, everyMs = EVERY_MS } = {}) {
    this.file = file;
    this.keepMs = keepMs;
    this.monthlyKeepMs = monthlyKeepMs;
    this.kinds = new Map();   // key -> limit kind, from the lines that carry it
    this.everyMs = everyMs;
    this.byKey = new Map();   // key -> [{ t, p, e, r }] oldest first
    this.pending = [];        // lines not yet written
    this.inflight = null;     // lines a running async append is writing
    this.lastPrune = null;    // set on load / first flush
    this.gen = 0;             // numbers full rewrites; an older one never replaces a newer file
    this.rewriting = false;
  }

  // Reads the file (async: history isn't needed to show the dashboard).
  // Bad lines and repeats are skipped; the file is rewritten when much was dropped.
  async load(now = Date.now()) {
    let text = '';
    try { text = await fsp.readFile(this.file, 'utf8'); } catch { return; }
    const seen = new Set();
    let total = 0, kept = 0;
    // First the kinds (any line of a key may carry it), then what to keep.
    const rows = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      total++;
      let a;
      try { a = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(a) || typeof a[0] !== 'number' || typeof a[1] !== 'string' || typeof a[2] !== 'number') continue;
      if (typeof a[5] === 'string') this.kinds.set(a[1], a[5]);
      rows.push(a);
    }
    for (const a of rows) {
      if (a[0] < now - this.keepFor(a[1])) continue;
      const id = a[0] + '|' + a[1];
      if (seen.has(id)) continue; // a line written twice (quit during a flush)
      seen.add(id);
      this.add(a);
      kept++;
    }
    for (const list of this.byKey.values()) list.sort((x, y) => x.t - y.t);
    this.lastPrune = now;
    if (total - kept > 500 || (total > 0 && (total - kept) / total > 0.2)) await this.rewrite(now);
  }

  // Retention for one limit: monthly ones keep a whole previous cycle.
  keepFor(key) { return this.kinds.get(key) === 'monthly' ? this.monthlyKeepMs : this.keepMs; }

  add([t, key, p, e, r]) {
    let list = this.byKey.get(key);
    if (!list) this.byKey.set(key, (list = []));
    list.push({ t, p, e: typeof e === 'number' ? e : null, r: r || 0 });
  }

  // Called with the snapshot limits; adds a reading where it is due.
  record(limits, now = Date.now()) {
    for (const l of limits) {
      if (l.synthetic) continue;
      const list = this.byKey.get(l.key);
      const last = list && list[list.length - 1];
      if (last && now - last.t < this.everyMs && last.p === round2(l.percent)) continue;
      if (l.kind) this.kinds.set(l.key, l.kind);
      const a = [now, l.key, round2(l.percent), l.est != null ? round2(l.est) : null, l.resetsAt || 0, l.kind || null];
      this.add(a);
      this.pending.push(JSON.stringify(a));
    }
  }

  samples(key, from = 0, to = Infinity) {
    const list = this.byKey.get(key) || [];
    const out = [];
    for (let i = lowerBound(list, from); i < list.length && list[i].t < to; i++) out.push(list[i]);
    return out;
  }

  async flush(now = Date.now()) {
    if (this.lastPrune == null) this.lastPrune = now;
    else if (now - this.lastPrune > PRUNE_EVERY_MS) { this.lastPrune = now; await this.rewrite(now); return; }
    if (this.inflight || !this.pending.length) return;
    this.inflight = this.pending;
    this.pending = [];
    try {
      await fsp.appendFile(this.file, this.inflight.join('\n') + '\n');
    } catch (e) {
      this.pending = this.inflight.concat(this.pending); // try again next time
      console.error('limit history', e.message);
    } finally { this.inflight = null; }
  }

  // On quit. Also writes what a running async append holds: that append may
  // not finish before the process exits, and a line written twice is skipped
  // on load.
  flushSync() {
    if (this.rewriting) { this.rewriteSync(); return; } // the running rewrite would replace an appended line
    const lines = (this.inflight || []).concat(this.pending);
    if (!lines.length) return;
    try { fs.appendFileSync(this.file, lines.join('\n') + '\n'); this.pending = []; } catch (e) { console.error('limit history', e.message); }
  }

  // Everything in memory as file text, after dropping readings older than the
  // retention window.
  snapshotText(now) {
    const lines = [];
    for (const [key, list] of this.byKey) {
      const keep = list.slice(lowerBound(list, now - this.keepFor(key)));
      this.byKey.set(key, keep);
      const kind = this.kinds.get(key) || null;
      for (const s of keep) lines.push(JSON.stringify([s.t, key, s.p, s.e, s.r || 0, kind]));
    }
    this.pending = []; // everything in memory goes into the rewritten file
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  // Drop old readings from memory and the file.
  async rewrite(now = Date.now()) {
    const gen = ++this.gen;
    const text = this.snapshotText(now);
    const tmp = `${this.file}.${gen}.tmp`;
    this.rewriting = true;
    try {
      await fsp.writeFile(tmp, text);
      if (gen === this.gen) await fsp.rename(tmp, this.file);
      else await fsp.rm(tmp, { force: true }); // a newer rewrite (on quit) already replaced the file
    } catch (e) {
      console.error('limit history', e.message);
    } finally {
      if (gen === this.gen) this.rewriting = false;
    }
  }

  // On quit while a rewrite runs: write the whole history now; the slower
  // rewrite then sees it is outdated and leaves the file alone.
  rewriteSync(now = Date.now()) {
    const gen = ++this.gen;
    const tmp = `${this.file}.${gen}.tmp`;
    try { fs.writeFileSync(tmp, this.snapshotText(now)); fs.renameSync(tmp, this.file); } catch (e) { console.error('limit history', e.message); }
    this.rewriting = false;
  }
}

module.exports = { LimitHistory, KEEP_MS, MONTHLY_KEEP_MS, EVERY_MS };
