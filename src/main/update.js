// Update check against the project's GitHub releases, and download of the
// installer (in the background when asked to, resumable, checksum-verified).
// No Electron here: main passes in what it needs, so the logic is unit-tested
// with a fake fetch.
//
// GitHub is asked without a login. Only when it refuses (the anonymous rate
// limit, or a repository that is not public) is the request repeated with the
// GitHub CLI token, when there is one. The token goes only to api.github.com;
// the download's redirect to GitHub's file storage never carries it.
//
// Statuses: idle · checking · current · error · available (a newer release,
// not downloaded) · downloading · ready (the installer is downloaded and
// verified, waiting to be started).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { versionLess } = require('./install-lib');
const { ghToken } = require('./sources/common');

const REPO = 'bartoszclapinski/TokenMuncher';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 20e3;
const EVERY_MS = 6 * 3600e3;
const IDLE_MS = 60e3;      // a download with no data for this long is given up
const PROGRESS_MS = 400;   // how often progress is reported
const SPEED_MS = 5000;     // the speed is the average over this long
// Anonymous answers worth a second try with a login: the rate limit, and 404,
// which is also what GitHub says about a repository that is not public.
const REFUSED = [403, 404, 429];
const INSTALLER = /^TokenMuncher-Setup-(\d+(?:\.\d+)*)(-arm64)?\.exe(\.part)?$/;

// Installer file name for a version and CPU (arm64 gets its own installer).
const assetName = (version, arch) => `TokenMuncher-Setup-${version}${arch === 'arm64' ? '-arm64' : ''}.exe`;

// From a releases/latest response: { version, page, asset } when it is newer
// than `current` and has an installer for `arch`, else null. asset.sha256 is
// the file's checksum when GitHub reports one.
function newerRelease(json, current, arch) {
  if (!json || typeof json.tag_name !== 'string' || json.draft || json.prerelease) return null;
  const version = json.tag_name.replace(/^v/, '');
  if (!/^\d+(\.\d+)*$/.test(version) || !versionLess(current, version)) return null;
  const a = (json.assets || []).find(x => x && x.name === assetName(version, arch));
  if (!a) return null;
  const sha256 = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : null;
  return { version, page: json.html_url || null, asset: { name: a.name, url: a.url, size: a.size, sha256 } };
}

// Bytes per second from [{ t, got }] samples (oldest first): the average over
// the last SPEED_MS before `now`. 0 until there is something to measure.
function speedOf(samples, now) {
  const from = samples.find(s => now - s.t <= SPEED_MS) || samples[samples.length - 1];
  const last = samples[samples.length - 1];
  if (!from || !last || last.t <= from.t) return 0;
  return Math.max(0, Math.round((last.got - from.got) / (last.t - from.t) * 1000));
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

class Updater {
  // opts: current (app version), arch, tmpDir, enabled: () => bool,
  //       auto: () => bool (download a found update without being asked),
  //       onChange(state, { progressOnly }), onFound(version), onReady(version),
  //       onFailed(version) (a download ended with an error),
  //       cancelled: () => version, setCancelled(version | null) (the version
  //       whose download the user stopped; kept by the caller across runs),
  //       fetch, token: () => Promise<string|null>
  constructor(opts) {
    let stopped = null; // without a caller that keeps it: for this run only
    this.o = { fetch: (...a) => fetch(...a), token: ghToken, idleMs: IDLE_MS, auto: () => false, cancelled: () => stopped, setCancelled: v => { stopped = v; }, ...opts };
    this.st = { status: 'idle', latest: null, page: null, checkedAt: 0, error: null, progress: 0, got: 0, size: 0, speed: 0 };
    this.release = null;
    this.checking = null;     // the running check, if any
    this.downloading = null;  // the running download, if any
    this.ctl = null;          // its AbortController
    this.readyFile = null;    // name of the downloaded, verified installer
    this.userCancel = false;  // the running download was stopped by the user (not an error)
    this.timers = [];
  }

  state() { return { ...this.st }; }
  set(patch, progressOnly = false) { Object.assign(this.st, patch); this.o.onChange && this.o.onChange(this.state(), { progressOnly }); }

  start() {
    this.cleanup();
    this.timers.push(setTimeout(() => this.check(), FIRST_CHECK_MS));
    this.timers.push(setInterval(() => this.check(), EVERY_MS));
  }
  stop() { this.timers.forEach(t => clearTimeout(t)); this.timers = []; }

  // Removes installers (whole or partial) that are of no use any more: once a
  // release is known, everything but its installer; before that, the ones that
  // are not newer than this version (the installer has finished by the time
  // the new version starts). Errors are ignored: a file may still be in use.
  cleanup() {
    try {
      for (const f of fs.readdirSync(this.o.tmpDir)) {
        const m = INSTALLER.exec(f);
        if (!m) continue;
        const keep = this.release ? f.replace(/\.part$/, '') === this.release.asset.name : versionLess(this.o.current, m[1]);
        if (!keep) { try { fs.rmSync(path.join(this.o.tmpDir, f), { force: true }); } catch { /* in use */ } }
      }
    } catch { /* no temp folder */ }
  }

  // A request to api.github.com: without a login first, with the GitHub CLI
  // token only after GitHub refused and when there is one. Once the token was
  // needed, later requests start with it. When the token does not help either,
  // the anonymous answer is the one reported (a stale login must not hide a
  // rate limit behind a login error).
  //   opts(): the fetch options for one attempt (a fresh timeout for each)
  async ask(url, accept, extra = {}, opts = () => ({})) {
    const headers = { Accept: accept, 'User-Agent': 'tokenmuncher', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    const send = token => this.o.fetch(url, { ...opts(), headers: token ? { ...headers, Authorization: 'Bearer ' + token } : headers });
    const refused = r => r.status === 401 || REFUSED.includes(r.status);
    const drop = async r => { try { if (r && r.body && r.body.cancel) await r.body.cancel(); } catch { /* already closed */ } };
    const first = this.login ? await this.o.token() : null;
    if (first) {
      const res = await send(first);
      if (!refused(res)) return res;
      await drop(res);
    }
    this.login = false;
    const res = await send(null);
    if (first || !REFUSED.includes(res.status)) return res;
    const token = await this.o.token();
    if (!token) return res;
    const again = await send(token);
    if (refused(again)) { await drop(again); return res; }
    await drop(res);
    this.login = true;
    return again;
  }

  // The status when nothing is running: ready or available for a known
  // release, else `none`.
  rest(none) { return this.release ? (this.readyFile === this.release.asset.name ? 'ready' : 'available') : none; }

  // force: a check asked for in the settings panel, also when checks are off.
  // Never runs during a download or next to another check. A downloaded
  // installer stays ready unless a newer release replaces it.
  check(force = false) {
    if (this.checking) return this.checking;
    if ((!force && !this.o.enabled()) || this.downloading) return Promise.resolve(this.state());
    this.checking = this.runCheck().finally(() => { this.checking = null; this.autoStart(); });
    return this.checking;
  }

  async runCheck() {
    this.set({ status: 'checking', error: null });
    try {
      const res = await this.ask(API, 'application/vnd.github+json', {}, () => ({ signal: AbortSignal.timeout(15e3) }));
      if (res.status === 404) throw new Error('no published release found, or no access to the repository');
      if (res.status === 401) throw new Error('GitHub rejected the login (gh auth login?)');
      if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit, trying again later');
      if (res.status !== 200) throw new Error('GitHub HTTP ' + res.status);
      const found = newerRelease(await res.json(), this.o.current, this.o.arch);
      const isNew = found && found.version !== this.st.latest;
      this.release = found;
      if (found) this.cleanup(); // installers of other versions
      this.set({ status: this.rest('current'), latest: found ? found.version : null, page: found ? found.page : null, checkedAt: Date.now() });
      if (isNew && this.o.onFound) this.o.onFound(found.version);
    } catch (e) {
      // An update found earlier stays installable when a later check fails.
      this.set({ status: this.rest('error'), error: e.name === 'TimeoutError' ? 'timeout' : e.message, checkedAt: Date.now() });
    }
    return this.state();
  }

  // Background download: starts when there is an update, it is allowed, and
  // the user did not stop this version's download. Failures show in the state.
  autoStart() {
    if (!this.release || this.downloading || this.st.status !== 'available' || !this.o.auto() || this.o.cancelled() === this.release.version) return;
    this.download().catch(() => {});
  }

  // Downloads the installer into tmpDir; resolves to its path. Waits for a
  // running check and joins a running download. An installer that is ready is
  // verified again (it may have waited in the temp folder for days) and
  // downloaded again when it changed. `version`: the one the caller means;
  // refuses when the release is another one by now.
  async download(version) {
    if (this.checking) await this.checking;
    const rel = this.release;
    if (!rel) throw new Error('no update to download');
    if (version && rel.version !== version) throw new Error(`version ${version} was replaced by ${rel.version}`);
    if (this.downloading) return this.downloading;
    const file = path.join(this.o.tmpDir, rel.asset.name);
    if (this.o.cancelled()) this.o.setCancelled(null); // asked for by hand
    this.downloading = this.run(rel, file).finally(() => { this.downloading = null; });
    return this.downloading;
  }

  // Stops the running download; what was received stays for a later resume.
  // remember: this version is not downloaded again without being asked.
  cancel(remember = true) {
    if (!this.ctl) return;
    if (remember && this.release) this.o.setCancelled(this.release.version);
    this.userCancel = true;
    this.ctl.abort();
  }

  // The file is the whole installer: right size, and right checksum when known.
  async verified(file, asset) {
    try {
      if (fs.statSync(file).size !== asset.size) return false;
      return !asset.sha256 || (await sha256Of(file)) === asset.sha256;
    } catch { return false; }
  }

  async run(rel, file) {
    const { asset } = rel;
    const part = file + '.part';
    // The installer is there already: ours from this run (verified again
    // before it is started), or one from an earlier run. Without a checksum
    // from GitHub only our own counts: a file is not trusted by its size alone.
    const ours = this.readyFile === asset.name;
    this.userCancel = false;
    if ((ours || asset.sha256) && (await this.verified(file, asset))) {
      if (!ours) {
        this.readyFile = asset.name;
        this.set({ status: 'ready', progress: 100, got: asset.size, size: asset.size, speed: 0, error: null });
        if (this.o.onReady) this.o.onReady(rel.version);
      }
      return file;
    }
    this.readyFile = null;
    let have = 0;
    try { have = fs.statSync(part).size; } catch { /* nothing yet */ }
    if (have > asset.size) { try { fs.rmSync(part, { force: true }); } catch { /* in use */ } have = 0; }
    // what is on disk already counts from the first moment
    this.set({ status: 'downloading', progress: Math.min(99, Math.floor(have / asset.size * 100)), got: have, size: asset.size, speed: 0, error: null });
    // Gives up after IDLE_MS without data, however long the whole download takes.
    const ctl = this.ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(), this.o.idleMs);
    const alive = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), this.o.idleMs); };
    const stopHere = () => { if (ctl.signal.aborted) throw new Error('aborted'); }; // cancel also between the steps
    try {
      if (have < asset.size) await this.fetchInto(part, asset, have, ctl, alive);
      stopHere();
      const got = fs.statSync(part).size;
      if (got !== asset.size) {
        if (got > asset.size) fs.rmSync(part, { force: true }); // a shorter one can be resumed
        throw new Error(`download incomplete (${got} of ${asset.size} bytes)`);
      }
      if (asset.sha256 && (await sha256Of(part)) !== asset.sha256) {
        fs.rmSync(part, { force: true });
        throw new Error('download damaged (checksum does not match), try again');
      }
      stopHere();
      fs.renameSync(part, file);
      this.readyFile = asset.name;
      this.set({ status: 'ready', progress: 100, got: asset.size, speed: 0 });
      if (this.o.onReady) this.o.onReady(rel.version);
      return file;
    } catch (e) {
      const stopped = this.userCancel;
      this.set({ status: 'available', speed: 0, error: stopped ? null : ctl.signal.aborted ? `download stalled (no data for ${Math.round(this.o.idleMs / 1000)} s)` : e.message });
      if (!stopped && this.o.onFailed) this.o.onFailed(rel.version);
      throw e;
    } finally { clearTimeout(idle); this.ctl = null; this.userCancel = false; }
  }

  // Appends the rest of the installer to `part` (which holds `have` bytes), or
  // writes it from the start when the server does not resume.
  async fetchInto(part, asset, have, ctl, alive) {
    const range = have ? { Range: `bytes=${have}-` } : {};
    // The API answers with a redirect to signed file storage; follow it by
    // hand so a token is never sent there.
    let res = await this.ask(asset.url, 'application/octet-stream', range, () => { alive(); return { redirect: 'manual', signal: ctl.signal }; });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      alive();
      res = await this.o.fetch(res.headers.get('location'), { headers: { 'User-Agent': 'tokenmuncher', ...range }, signal: ctl.signal });
    }
    if (res.status === 206 && have) {
      const cr = res.headers.get('content-range');
      if (cr && !cr.startsWith(`bytes ${have}-`)) { fs.rmSync(part, { force: true }); throw new Error('download could not be resumed, try again'); }
    } else if (res.status === 200) have = 0; // no resume: from the start
    else throw new Error('download HTTP ' + res.status);
    if (!res.body) throw new Error('download HTTP ' + res.status);
    let got = have, lastSent = 0;
    const samples = [{ t: Date.now(), got }];
    const self = this;
    async function* counted(body) {
      for await (const chunk of body) {
        if (ctl.signal.aborted) throw new Error('aborted');
        alive();
        got += chunk.length;
        const now = Date.now();
        if (now - lastSent > PROGRESS_MS) {
          lastSent = now;
          samples.push({ t: now, got });
          while (samples.length > 2 && now - samples[1].t > SPEED_MS) samples.shift();
          self.set({ progress: Math.min(99, Math.floor(got / asset.size * 100)), got, speed: speedOf(samples, now) }, true);
        }
        yield chunk;
      }
    }
    // pipeline reports write errors (disk full, file locked) as a rejection.
    await pipeline(counted(res.body), fs.createWriteStream(part, { flags: have ? 'a' : 'w' }), { signal: ctl.signal });
  }

  // The installer could not be started: the reason shows next to the update.
  failed(message) { this.set({ status: this.rest('error'), error: message }); }
}

module.exports = { Updater, newerRelease, assetName, speedOf, REPO, IDLE_MS };
