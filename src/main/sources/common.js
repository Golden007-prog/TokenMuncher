const path = require('path');
const { execFile } = require('child_process');

// Worktrees (e.g. <repo>/.claude/worktrees/wf_123) count toward their repo.
function projectOf(cwd) {
  if (!cwd) return '?';
  const norm = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const m = /^(.*?)\/\.(?:claude|codex)\/worktrees\//.exec(norm);
  return path.posix.basename(m ? m[1] : norm) || norm;
}

// Path relative to cwd when inside it, else the last two segments.
function relPath(p, cwd) {
  if (!p) return '';
  p = String(p).replace(/\\/g, '/');
  const base = (cwd || '').replace(/\\/g, '/');
  if (base && p.toLowerCase().startsWith(base.toLowerCase() + '/')) return p.slice(base.length + 1);
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// Plain fetch with timeout that never throws; returns { status, json, retryAfter, error }.
async function getJson(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15e3) });
    let json = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
  } catch (e) {
    return { status: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

// GitHub token of the GitHub CLI login (or GH_TOKEN / GITHUB_TOKEN), or null.
// Only ever sent to api.github.com.
function ghToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return Promise.resolve(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  return new Promise(resolve => {
    execFile('gh', ['auth', 'token'], { timeout: 10e3, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null));
  });
}

module.exports = { projectOf, relPath, getJson, ghToken };
