// Week summaries: what a finished week cost, kept on disk so weeks can be
// compared after their records are gone (the store keeps this month plus
// 8 days). No Electron here; the functions are pure and the store is a small
// JSON file.
//
// A week is the window of Claude's main weekly limit, reset to reset
// (by: 'limit'). Without that limit it is the calendar week from Monday
// (by: 'calendar'). The two kinds are never compared with each other.
const fs = require('fs');
const { displayName } = require('./pricing');
const { startOfDay, startOfWeek, DAY } = require('./store');
const { fmtTok, change } = require('../shared/numbers');

const WEEK = 7 * DAY;
const KEEP = 12;            // summaries kept
const NEWS_MS = 3 * DAY;    // a week that ended longer ago is summed up without a notification
const SAME_MS = 12 * 3600e3; // reset times this close name the same week (they jitter; a planned change is hours)
const TOP = 5;              // projects and models listed

// The main weekly limit among a source's or the snapshot's limits.
const weeklyLimit = limits => (limits || []).find(l => l.provider === 'claude' && l.kind === 'weekly' && l.name === 'weekly' && l.resetsAt && l.windowSec === WEEK / 1000) || null;

// The calendar week (Monday midnight to Monday midnight) before the one that
// starts at `end`. Stepped by date, so a clock change does not shift it.
const calendarWeek = end => ({ start: startOfWeek(end - DAY), end, limitKey: null, by: 'calendar' });

// The last week that is over at `now`: { start, end, limitKey, by }. A reset
// time that already passed (no fresh reading yet) is that week's end.
function lastWeek(limits, now) {
  const l = weeklyLimit(limits);
  if (l) {
    const end = l.resetsAt - WEEK * Math.ceil((l.resetsAt - now) / WEEK);
    return { start: end - WEEK, end, limitKey: l.key, by: 'limit' };
  }
  return calendarWeek(startOfWeek(now));
}

// Sums up the records of [start, end). Token counts include cache reads; `cr`
// is their part, so a view can leave them out. Days are the 24 h slices from
// the week's start (a week has seven, wherever it starts).
//   hidden: provider ids to leave out · cutoff: where the records begin
function summarize(records, { start, end, by = 'limit', hidden, cutoff = 0 }) {
  const add = (o, r) => { o.tokens += r.total; o.cr += r.cr || 0; o.cost += r.cost; return o; };
  const zero = extra => ({ ...extra, tokens: 0, cr: 0, cost: 0 });
  const sum = zero({});
  const sids = new Set(), days = new Map(), projects = new Map(), models = new Map(), providers = {};
  const lastDay = Math.max(0, Math.ceil((end - start) / DAY) - 1);
  for (const r of records) {
    if (r.ts < start || r.ts >= end || (hidden && hidden.has(r.provider))) continue;
    add(sum, r);
    sids.add(r.sid);
    const day = start + Math.min(lastDay, Math.floor((r.ts - start) / DAY)) * DAY;
    add(days.get(day) || days.set(day, zero({ start: day })).get(day), r);
    add(projects.get(r.project) || projects.set(r.project, zero({ name: r.project })).get(r.project), r);
    const name = displayName(r.model);
    add(models.get(name) || models.set(name, zero({ name, fam: r.fam })).get(name), r);
    add(providers[r.provider] || (providers[r.provider] = zero({})), r);
  }
  const top = map => [...map.values()].sort((a, b) => b.tokens - a.tokens).slice(0, TOP);
  const busiest = [...days.values()].sort((a, b) => b.tokens - a.tokens)[0] || null;
  return {
    start, end, by, ...sum, sessions: sids.size, activeDays: days.size, busiest,
    projects: top(projects), models: top(models), providers,
    partial: start < cutoff, limit: null
  };
}

// The weeks to sum up now: the last one, and before it the earlier weeks whose
// records are all still there (so the first run has something to compare
// with). Newest first; weeks that already have a summary are left out.
//   cutoff: where the records of every source begin · has(week) -> bool
function weeksDue(limits, now, { cutoff, has, back = 5 }) {
  const out = [];
  let w = lastWeek(limits, now);
  for (let i = 0; i <= back; i++) {
    if (i > 0) w = w.by === 'calendar' ? calendarWeek(w.start) : { ...w, start: w.start - WEEK, end: w.end - WEEK };
    if (i > 0 && w.start < cutoff) break;
    if (!has(w)) out.push({ ...w, latest: i === 0 });
  }
  return out;
}

// The notification for a finished week (before: what the week before it had,
// or null when there is nothing to compare with).
function weekNews(s, before, { withCR = true } = {}) {
  const tok = x => (withCR ? x.tokens : x.tokens - x.cr);
  const title = s.limit && s.limit.pct != null ? `Last week: ${Math.round(s.limit.pct)}% of the ${s.limit.name} limit` : `Last week: ${fmtTok(tok(s))} tokens`;
  const parts = [`${fmtTok(tok(s))} tokens`, `$${s.cost.toFixed(2)}`, `${s.sessions} session${s.sessions === 1 ? '' : 's'}`];
  const delta = before ? change(s.cost, before.cost) : null;
  if (delta) parts.push(`${delta} vs the week before`);
  if (s.projects[0]) parts.push(`top: ${s.projects[0].name}`);
  return { id: `week:${s.end}`, kind: 'reset', title, body: parts.join(' · ') };
}

// A summary read from disk has every field the views use.
const num = Number.isFinite;
const part = x => !!x && typeof x === 'object' && num(x.tokens) && num(x.cr) && num(x.cost);
const named = x => part(x) && typeof x.name === 'string';
function valid(s) {
  return part(s) && num(s.start) && num(s.end) && s.end > s.start && num(s.sessions) && num(s.activeDays)
    && (s.by === 'limit' || s.by === 'calendar')
    && Array.isArray(s.projects) && s.projects.every(named) && Array.isArray(s.models) && s.models.every(named)
    && (s.busiest == null || (part(s.busiest) && num(s.busiest.start)))
    && (s.limit == null || (typeof s.limit === 'object' && typeof s.limit.name === 'string' && num(s.limit.pct)));
}

// Summaries on disk, newest first. file null: memory only (demo mode).
class WeekSummaries {
  constructor(file) { this.file = file; this.list = []; this.unsaved = false; }

  load() {
    if (!this.file) return this;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.list = (Array.isArray(j) ? j : []).filter(valid);
      this.sort();
    } catch { /* none yet, or unreadable: start empty */ }
    return this;
  }

  sort() { this.list.sort((a, b) => b.end - a.end); if (this.list.length > KEEP) this.list.length = KEEP; }

  // This week is summed up already (its reset time may have moved a little).
  has(w) { return this.list.some(s => s.by === w.by && Math.abs(s.end - w.end) < SAME_MS); }

  // Where a week really starts: at the end of the stored week it would overlap
  // (the limit was reset early, or its reset time moved), so no day is counted
  // twice and none is lost.
  startOf(w) {
    const prev = this.list.find(s => s.by === w.by && s.end > w.start + SAME_MS && s.end < w.end);
    return prev ? prev.end : w.start;
  }

  // What to compare `s` with: the week of the same kind right before it, when
  // it is complete. null otherwise (nothing stored, a gap, or a partial week).
  before(s) {
    const p = this.list.find(x => x !== s && x.by === s.by && Math.abs(x.end - s.start) < SAME_MS);
    return p && !p.partial ? p : null;
  }

  // For the views: each summary with what it is compared with.
  view() {
    return this.list.map(s => {
      const b = this.before(s);
      return { ...s, before: b ? { tokens: b.tokens, cr: b.cr, cost: b.cost, sessions: b.sessions, limit: b.limit } : null };
    });
  }

  // Adds a summary; one of the other kind that overlaps it goes (the week's
  // bounds became known, or were lost). Returns false when it is there already.
  add(summary) {
    if (this.has(summary)) return false;
    this.list = this.list.filter(s => s.by === summary.by || s.end <= summary.start || s.start >= summary.end);
    this.list.push(summary);
    this.sort();
    this.unsaved = true;
    this.save();
    return true;
  }

  // Writes the file; after a failure the next call tries again.
  save() {
    if (!this.file || !this.unsaved) return;
    try { fs.writeFileSync(this.file, JSON.stringify(this.list)); this.unsaved = false; } catch { /* next time */ }
  }
}

module.exports = { WeekSummaries, lastWeek, weeksDue, summarize, weekNews, weeklyLimit, WEEK, NEWS_MS, SAME_MS, KEEP };
