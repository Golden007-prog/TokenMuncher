const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Updater, newerRelease, assetName, speedOf } = require('../src/main/update');
const { downloadText } = require('../src/shared/download');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

const release = (tag, names = [assetName(tag.replace(/^v/, ''), 'x64')], extra = {}) => ({
  tag_name: tag, html_url: `https://github.com/x/y/releases/tag/${tag}`, draft: false, prerelease: false,
  assets: names.map((name, i) => ({ name, url: `https://api.github.com/assets/${i}`, size: 6 })), ...extra
});

test('asset names: x64 keeps the old name, arm64 gets a suffix', () => {
  assert.equal(assetName('0.9.3', 'x64'), 'TokenMuncher-Setup-0.9.3.exe');
  assert.equal(assetName('0.9.3', 'arm64'), 'TokenMuncher-Setup-0.9.3-arm64.exe');
});

test('newerRelease: only newer, published releases with an installer for this CPU', () => {
  assert.equal(newerRelease(release('v0.9.3'), '0.9.2', 'x64').version, '0.9.3');
  assert.equal(newerRelease(release('v0.10.0'), '0.9.2', 'x64').version, '0.10.0');
  assert.equal(newerRelease(release('v0.9.2'), '0.9.2', 'x64'), null, 'same version');
  assert.equal(newerRelease(release('v0.9.1'), '0.9.2', 'x64'), null, 'older');
  assert.equal(newerRelease(release('v0.9.3'), '0.9.2', 'arm64'), null, 'no arm64 installer');
  assert.equal(newerRelease(release('v0.9.3', undefined, { prerelease: true }), '0.9.2', 'x64'), null);
  assert.equal(newerRelease(release('nightly'), '0.9.2', 'x64'), null);
  assert.equal(newerRelease(null, '0.9.2', 'x64'), null);
});

// Fake fetch: answers by URL and records every request's headers.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {}, redirect: opts.redirect });
    const r = typeof routes[url] === 'function' ? routes[url](opts) : routes[url];
    if (!r) return { status: 404, headers: { get: () => null }, json: async () => ({}) };
    return { status: r.status || 200, headers: { get: h => (r.headers || {})[h.toLowerCase()] || null }, json: async () => r.json, body: typeof r.body === 'function' ? r.body(opts.signal) : r.body };
  };
  fn.calls = calls;
  return fn;
}
const API = 'https://api.github.com/repos/bartoszclapinski/TokenMuncher/releases/latest';

function updater(routes, extra = {}) {
  const found = [];
  const fetch = fakeFetch(routes);
  const u = new Updater({ current: '0.9.2', arch: 'x64', tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upd-')), enabled: () => true, onFound: v => found.push(v), fetch, token: async () => 'TOKEN', ...extra });
  return { u, found, fetch };
}

test('check: a newer release is reported once', async () => {
  const { u, found, fetch } = updater({ [API]: { json: release('v0.9.3') } });
  assert.equal((await u.check()).status, 'available');
  assert.equal(u.state().latest, '0.9.3');
  await u.check();
  assert.deepEqual(found, ['0.9.3'], 'onFound only for a version not seen before');
  assert.ok(fetch.calls.every(c => c.headers.Authorization === undefined), 'no login sent when GitHub answers without one');
});

test('check: the GitHub CLI token is used only after GitHub refused', async () => {
  for (const status of [404, 403, 429]) {
    const { u, fetch } = updater({ [API]: o => (o.headers.Authorization === 'Bearer TOKEN' ? { json: release('v0.9.3') } : { status }) });
    assert.equal((await u.check()).status, 'available', 'HTTP ' + status);
    assert.deepEqual(fetch.calls.map(c => c.headers.Authorization), [undefined, 'Bearer TOKEN']);
  }
  const none = updater({ [API]: { status: 404 } }, { token: async () => null });
  assert.equal((await none.u.check()).status, 'error');
  assert.equal(none.fetch.calls.length, 1, 'no second try without a token');
});

test('check: a login that does not help leaves the anonymous answer', async () => {
  const stale = updater({ [API]: o => ({ status: o.headers.Authorization ? 401 : 403 }) });
  assert.match((await stale.u.check()).error, /rate limit/, 'not a login error');
  const blocked = updater({ [API]: o => ({ status: o.headers.Authorization ? 403 : 404 }) });
  assert.match((await blocked.u.check()).error, /no published release/);
});

test('check: once the token was needed, later requests start with it', async () => {
  let ok = true;
  const { u, fetch } = updater({ [API]: o => (o.headers.Authorization && ok ? { json: release('v0.9.3') } : o.headers.Authorization ? { status: 401 } : { status: 404 }) });
  await u.check();
  await u.check();
  assert.deepEqual(fetch.calls.map(c => c.headers.Authorization), [undefined, 'Bearer TOKEN', 'Bearer TOKEN']);
  ok = false; // the login stopped working: back to asking without it
  await u.check();
  assert.deepEqual(fetch.calls.slice(3).map(c => c.headers.Authorization), ['Bearer TOKEN', undefined]);
  await u.check();
  assert.deepEqual(fetch.calls.slice(5).map(c => c.headers.Authorization), [undefined, 'Bearer TOKEN']);
});

test('check: every attempt gets its own timeout', async () => {
  const signals = [];
  const { u } = updater({ [API]: o => { signals.push(o.signal); return o.headers.Authorization ? { json: release('v0.9.3') } : { status: 404 }; } });
  await u.check();
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
});

test('download: a private asset is fetched with the token, the storage without', async () => {
  const S3 = 'https://objects.example/signed';
  const { u, fetch } = updater({
    [API]: { json: release('v0.9.3') },
    'https://api.github.com/assets/0': o => (o.headers.Authorization ? { status: 302, headers: { location: S3 } } : { status: 404 }),
    [S3]: { body: [Buffer.from('abcdef')] }
  });
  await u.check();
  assert.equal(fs.readFileSync(await u.download(), 'utf8'), 'abcdef');
  const [anon, withToken, storage] = fetch.calls.slice(1);
  assert.equal(anon.headers.Authorization, undefined);
  assert.equal(withToken.headers.Authorization, 'Bearer TOKEN');
  assert.equal(withToken.redirect, 'manual');
  assert.equal(storage.headers.Authorization, undefined, 'token never sent to file storage');
});

test('check: up to date, no access, switched off', async () => {
  assert.equal((await updater({ [API]: { json: release('v0.9.2') } }).u.check()).status, 'current');
  const denied = await updater({}).u.check();
  assert.equal(denied.status, 'error');
  assert.match(denied.error, /no access/);
  const off = updater({ [API]: { json: release('v0.9.3') } }, { enabled: () => false });
  assert.equal((await off.u.check()).status, 'idle');
  assert.equal(off.fetch.calls.length, 0);
  assert.equal((await off.u.check(true)).status, 'available', '"check now" works even when checks are off');
});

test('download: follows the redirect without the token and checks the size', async () => {
  const S3 = 'https://objects.example/signed';
  const { u, fetch } = updater({
    [API]: { json: release('v0.9.3') },
    'https://api.github.com/assets/0': { status: 302, headers: { location: S3 } },
    [S3]: { body: [Buffer.from('abc'), Buffer.from('def')] }
  });
  await u.check();
  const file = await u.download();
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
  assert.equal(u.state().status, 'ready');
  const [asset, storage] = fetch.calls.slice(1);
  assert.equal(asset.redirect, 'manual');
  assert.equal(asset.headers.Authorization, undefined, 'a public download needs no login');
  assert.equal(storage.url, S3);
  assert.equal(storage.headers.Authorization, undefined, 'token never sent to file storage');
});

test('download: a short file is rejected and removed', async () => {
  const { u } = updater({ [API]: { json: release('v0.9.3') }, 'https://api.github.com/assets/0': { body: [Buffer.from('abc')] } });
  await u.check();
  await assert.rejects(u.download(), /incomplete/);
  assert.equal(u.state().status, 'available');
  assert.match(u.state().error, /incomplete/);
  assert.ok(!fs.existsSync(path.join(u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe')));
});

test('check: clearer messages for a bad login and the rate limit', async () => {
  const msg = async status => (await updater({ [API]: { status } }).u.check()).error;
  assert.match(await msg(401), /rejected the login/);
  assert.match(await msg(403), /rate limit/);
  assert.match(await msg(404), /no published release/);
});

test('a failed check keeps an update found earlier installable', async () => {
  const routes = { [API]: { json: release('v0.9.3') } };
  const { u } = updater(routes);
  await u.check();
  routes[API] = { status: 500 };
  const st = await u.check();
  assert.equal(st.status, 'available');
  assert.equal(st.latest, '0.9.3');
  assert.match(st.error, /500/);
});

test('one check at a time, none during a download; download waits for a running check', async () => {
  let release1;
  const gate = new Promise(r => { release1 = r; });
  const { u, fetch } = updater({ [API]: { json: release('v0.9.3') }, 'https://api.github.com/assets/0': { body: [Buffer.from('abcdef')] } });
  const slowFetch = async (url, o) => { if (url === API) await gate; return fetch(url, o); };
  u.o.fetch = slowFetch;
  const a = u.check(), b = u.check(true);
  assert.equal(a, b, 'the second call joins the running check');
  const dl = u.download(); // starts while the check is still running
  release1();
  await a;
  const file = await dl;
  assert.ok(fs.existsSync(file));
  assert.equal(u.state().status, 'ready');
  assert.equal(await u.download(), file, 'a second call answers with the same file');
  assert.equal(fetch.calls.filter(c => c.url === 'https://api.github.com/assets/0').length, 1, 'and downloads nothing again');
  assert.equal(fetch.calls.filter(c => c.url === API).length, 1);
  await assert.rejects(updater({}).u.download(), /no update/, 'nothing found: nothing to download');
});

test('download: a write error is reported, not thrown at the process', async () => {
  const { u } = updater({ [API]: { json: release('v0.9.3') }, 'https://api.github.com/assets/0': { body: [Buffer.from('abcdef')] } });
  await u.check();
  u.o.tmpDir = path.join(u.o.tmpDir, 'missing', 'folder'); // createWriteStream fails with ENOENT
  await assert.rejects(u.download(), /ENOENT/);
  assert.equal(u.state().status, 'available');
  assert.match(u.state().error, /ENOENT/);
});

test('download: gives up when no data arrives for a while', async () => {
  const stall = signal => (async function* () {
    yield Buffer.from('ab');
    await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  })();
  const { u } = updater({ [API]: { json: release('v0.9.3') }, 'https://api.github.com/assets/0': { body: stall } }, { idleMs: 50 });
  await u.check();
  await assert.rejects(u.download());
  assert.match(u.state().error, /stalled/);
  assert.equal(u.state().status, 'available');
});

test('cleanup removes installers of no use, keeps a newer one and its partial download', async () => {
  const { u } = updater({ [API]: { json: release('v0.9.4') } });
  const dir = u.o.tmpDir;
  const put = names => names.forEach(f => fs.writeFileSync(path.join(dir, f), ''));
  put(['TokenMuncher-Setup-0.9.1.exe', 'TokenMuncher-Setup-0.9.2.exe.part', 'TokenMuncher-Setup-0.9.3.exe', 'TokenMuncher-Setup-0.9.4.exe.part', 'other.exe', 'TokenMuncher-Setup-notes.txt']);
  u.cleanup(); // at the start: this version (0.9.2) and older go
  assert.deepEqual(fs.readdirSync(dir).sort(), ['TokenMuncher-Setup-0.9.3.exe', 'TokenMuncher-Setup-0.9.4.exe.part', 'TokenMuncher-Setup-notes.txt', 'other.exe']);
  await u.check(); // 0.9.4 is the release: only its files stay
  assert.deepEqual(fs.readdirSync(dir).sort(), ['TokenMuncher-Setup-0.9.4.exe.part', 'TokenMuncher-Setup-notes.txt', 'other.exe']);
});

// ── background download, resume, checksum ──
const ASSET = 'https://api.github.com/assets/0';
const withSha = (tag, text) => { const r = release(tag); r.assets[0].digest = 'sha256:' + sha(text); return r; };
const settled = u => (u.downloading || Promise.resolve()).catch(() => {});

test('newerRelease reads the checksum GitHub reports', () => {
  assert.equal(newerRelease(withSha('v0.9.3', 'abcdef'), '0.9.2', 'x64').asset.sha256, sha('abcdef'));
  assert.equal(newerRelease(release('v0.9.3'), '0.9.2', 'x64').asset.sha256, null);
  const odd = release('v0.9.3'); odd.assets[0].digest = 'md5:abc';
  assert.equal(newerRelease(odd, '0.9.2', 'x64').asset.sha256, null);
});

test('background: a found update is downloaded without being asked, and announced once ready', async () => {
  const ready = [];
  const { u, found } = updater({ [API]: { json: withSha('v0.9.3', 'abcdef') }, [ASSET]: { body: [Buffer.from('abc'), Buffer.from('def')] } }, { auto: () => true, onReady: v => ready.push(v) });
  await u.check();
  assert.equal(u.state().status, 'downloading');
  await settled(u);
  assert.equal(u.state().status, 'ready');
  assert.deepEqual([found, ready], [['0.9.3'], ['0.9.3']]);
  assert.equal(fs.readFileSync(await u.download(), 'utf8'), 'abcdef');
  assert.deepEqual(fs.readdirSync(u.o.tmpDir), ['TokenMuncher-Setup-0.9.3.exe'], 'no partial file left');
  assert.equal((await u.check()).status, 'ready', 'a later check keeps it ready');
});

test('background: off by default, and not for a download the user stopped', async () => {
  const off = updater({ [API]: { json: release('v0.9.3') }, [ASSET]: { body: [Buffer.from('abcdef')] } });
  await off.u.check();
  assert.equal(off.u.state().status, 'available');
  assert.equal(off.fetch.calls.length, 1);

  const stall = signal => (async function* () {
    yield Buffer.from('ab');
    await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  })();
  const { u, fetch } = updater({ [API]: { json: release('v0.9.3') }, [ASSET]: { body: stall } }, { auto: () => true });
  await u.check();
  await new Promise(r => setTimeout(r, 30));
  u.cancel();
  await settled(u);
  assert.equal(u.state().status, 'available');
  assert.equal(u.state().error, null, 'stopping is not an error');
  const before = fetch.calls.filter(c => c.url === ASSET).length;
  await u.check();
  await settled(u);
  assert.equal(fetch.calls.filter(c => c.url === ASSET).length, before, 'the next check does not restart it');
  assert.equal(fs.readFileSync(path.join(u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe.part'), 'utf8'), 'ab', 'what arrived is kept');
});

test('resume: asks for the rest and appends it; a server that does not resume starts over', async () => {
  const S3 = 'https://objects.example/signed';
  const routes = {
    [API]: { json: withSha('v0.9.3', 'abcdef') },
    [ASSET]: { status: 302, headers: { location: S3 } },
    [S3]: o => (o.headers.Range === 'bytes=2-' ? { status: 206, headers: { 'content-range': 'bytes 2-5/6' }, body: [Buffer.from('cdef')] } : { body: [Buffer.from('abcdef')] })
  };
  const a = updater(routes);
  await a.u.check();
  fs.writeFileSync(path.join(a.u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe.part'), 'ab');
  assert.equal(fs.readFileSync(await a.u.download(), 'utf8'), 'abcdef');
  const storage = a.fetch.calls.find(c => c.url === S3);
  assert.equal(storage.headers.Range, 'bytes=2-');
  assert.equal(storage.headers.Authorization, undefined, 'token never sent to file storage');

  routes[S3] = { body: [Buffer.from('abcdef')] }; // ignores Range, sends everything
  const b = updater(routes);
  await b.u.check();
  fs.writeFileSync(path.join(b.u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe.part'), 'xx');
  assert.equal(fs.readFileSync(await b.u.download(), 'utf8'), 'abcdef');

  routes[S3] = { status: 206, headers: { 'content-range': 'bytes 0-5/6' }, body: [Buffer.from('abcdef')] }; // resumes from the wrong place
  const c = updater(routes);
  await c.u.check();
  fs.writeFileSync(path.join(c.u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe.part'), 'ab');
  await assert.rejects(c.u.download(), /could not be resumed/);
  assert.deepEqual(fs.readdirSync(c.u.o.tmpDir), [], 'the partial file is dropped, the next try starts over');
});

test('checksum: a damaged download is removed and reported', async () => {
  const { u } = updater({ [API]: { json: withSha('v0.9.3', 'abcdef') }, [ASSET]: { body: [Buffer.from('abcdeX')] } });
  await u.check();
  await assert.rejects(u.download(), /checksum/);
  assert.equal(u.state().status, 'available');
  assert.match(u.state().error, /checksum/);
  assert.deepEqual(fs.readdirSync(u.o.tmpDir), []);
});

test('an installer downloaded in an earlier run is recognised, a damaged one is downloaded again', async () => {
  const routes = { [API]: { json: withSha('v0.9.3', 'abcdef') }, [ASSET]: { body: [Buffer.from('abcdef')] } };
  const a = updater(routes, { auto: () => true });
  fs.writeFileSync(path.join(a.u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe'), 'abcdef');
  await a.u.check();
  await settled(a.u);
  assert.equal(a.u.state().status, 'ready');
  assert.equal(a.fetch.calls.filter(c => c.url === ASSET).length, 0, 'nothing downloaded');

  const b = updater(routes, { auto: () => true });
  fs.writeFileSync(path.join(b.u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe'), 'abcdeX');
  await b.u.check();
  await settled(b.u);
  assert.equal(b.u.state().status, 'ready');
  assert.equal(fs.readFileSync(path.join(b.u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe'), 'utf8'), 'abcdef');
});

test('a newer release replaces a downloaded one', async () => {
  const routes = { [API]: { json: withSha('v0.9.3', 'abcdef') }, [ASSET]: { body: [Buffer.from('abcdef')] } };
  const { u } = updater(routes, { auto: () => true });
  await u.check();
  await settled(u);
  assert.equal(u.state().status, 'ready');
  routes[API] = { json: withSha('v0.9.4', 'ghijkl') };
  routes[ASSET] = { body: [Buffer.from('ghijkl')] };
  await u.check();
  await settled(u);
  assert.deepEqual([u.state().status, u.state().latest], ['ready', '0.9.4']);
  assert.deepEqual(fs.readdirSync(u.o.tmpDir), ['TokenMuncher-Setup-0.9.4.exe']);
});

test('a failed check keeps a downloaded installer ready; a failed start says why', async () => {
  const routes = { [API]: { json: release('v0.9.3') }, [ASSET]: { body: [Buffer.from('abcdef')] } };
  const { u } = updater(routes);
  await u.check();
  await u.download();
  routes[API] = { status: 500 };
  assert.equal((await u.check()).status, 'ready');
  u.failed('could not start the installer: blocked');
  assert.deepEqual([u.state().status, u.state().error], ['ready', 'could not start the installer: blocked']);
});

test('download progress: bytes, size and speed are reported', async () => {
  const seen = [];
  const slow = () => (async function* () { for (const c of ['ab', 'cd', 'ef']) { await new Promise(r => setTimeout(r, 450)); yield Buffer.from(c); } })();
  const { u } = updater({ [API]: { json: release('v0.9.3') }, [ASSET]: { body: slow } }, { onChange: (st, { progressOnly }) => { if (progressOnly) seen.push(st); } });
  await u.check();
  await u.download();
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(st => st.size === 6 && st.got > 0 && st.got <= 6 && st.status === 'downloading'));
  assert.ok(seen[seen.length - 1].speed > 0);
  assert.deepEqual([u.state().got, u.state().speed, u.state().progress], [6, 0, 100]);
});

test('speedOf: the average over the last five seconds', () => {
  assert.equal(speedOf([], 0), 0);
  assert.equal(speedOf([{ t: 0, got: 0 }], 0), 0);
  assert.equal(speedOf([{ t: 0, got: 0 }, { t: 2000, got: 400000 }], 2000), 200000);
  // the early burst is outside the window
  assert.equal(speedOf([{ t: 0, got: 0 }, { t: 1000, got: 9000000 }, { t: 6000, got: 9500000 }, { t: 8000, got: 9700000 }], 8000), 100000);
  assert.equal(speedOf([{ t: 0, got: 500 }, { t: 1000, got: 400 }], 1000), 0, 'never negative');
});

test('downloadText: megabytes, speed and time left', () => {
  assert.deepEqual(downloadText({ got: 27800000, size: 81600212, speed: 180000 }), { mb: '27.8 / 81.6 MB', speed: '180 KB/s', left: '5 min left' });
  assert.deepEqual(downloadText({ got: 0, size: 81600212, speed: 0 }), { mb: '0.0 / 81.6 MB', speed: null, left: null });
  assert.equal(downloadText({ got: 80e6, size: 81.6e6, speed: 2.5e6 }).speed, '2.5 MB/s');
  assert.equal(downloadText({ got: 80e6, size: 81.6e6, speed: 2.5e6 }).left, 'under a minute left');
  assert.equal(downloadText({ got: 0, size: 81.6e6, speed: 10000 }).left, '2 h 16 min left');
  assert.equal(downloadText({ got: 0, size: 1e6, speed: 200 }).speed, '1 KB/s');
  // rounded to whole minutes before splitting: never "60 min"
  assert.equal(downloadText({ got: 0, size: 3585, speed: 1 }).left, '1 h 0 min left');
  assert.equal(downloadText({ got: 0, size: 7185, speed: 1 }).left, '2 h 0 min left');
  assert.equal(downloadText({ got: 0, size: 3540, speed: 1 }).left, '59 min left');
});

test('a ready installer is verified again before it is handed out', async () => {
  const routes = { [API]: { json: withSha('v0.9.3', 'abcdef') }, [ASSET]: { body: [Buffer.from('abcdef')] } };
  const { u, fetch } = updater(routes);
  await u.check();
  const file = await u.download();
  fs.writeFileSync(file, 'abcdeX'); // changed while it waited in the temp folder
  assert.equal(await u.download(), file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef', 'downloaded again');
  assert.equal(fetch.calls.filter(c => c.url === ASSET).length, 2);
  assert.equal(u.state().status, 'ready');
});

test('without a checksum from GitHub, a file found in the temp folder is not taken for the installer', async () => {
  const { u, fetch } = updater({ [API]: { json: release('v0.9.3') }, [ASSET]: { body: [Buffer.from('abcdef')] } }, { auto: () => true });
  fs.writeFileSync(path.join(u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe'), 'XXXXXX'); // right size, not ours
  await u.check();
  await settled(u);
  assert.equal(fetch.calls.filter(c => c.url === ASSET).length, 1);
  assert.equal(fs.readFileSync(await u.download(), 'utf8'), 'abcdef');
});

test('download(version) refuses when the release is another one by now', async () => {
  const routes = { [API]: { json: release('v0.9.3') }, [ASSET]: { body: [Buffer.from('abcdef')] } };
  const { u, fetch } = updater(routes);
  await u.check();
  routes[API] = { json: release('v0.9.4') };
  await u.check();
  await assert.rejects(u.download('0.9.3'), /replaced by 0\.9\.4/);
  assert.equal(fetch.calls.filter(c => c.url === ASSET).length, 0);
  assert.ok(fs.existsSync(await u.download('0.9.4')));
});

const stalling = signal => (async function* () {
  yield Buffer.from('ab');
  await new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
})();

test('a stopped download: remembered by the caller, no failure reported; a real failure is', async () => {
  const kept = { v: null }, failed = [];
  const routes = { [API]: { json: withSha('v0.9.3', 'abcdef') }, [ASSET]: { body: stalling } };
  const opts = { auto: () => true, cancelled: () => kept.v, setCancelled: v => { kept.v = v; }, onFailed: v => failed.push(v) };
  const a = updater(routes, opts);
  await a.u.check();
  await new Promise(r => setTimeout(r, 30));
  a.u.cancel();
  await settled(a.u);
  assert.deepEqual([kept.v, failed], ['0.9.3', []]);

  // "after a restart": a new updater with what the caller kept does not start it
  const b = updater(routes, opts);
  await b.u.check();
  await settled(b.u);
  assert.equal(b.u.state().status, 'available');
  assert.equal(b.fetch.calls.filter(c => c.url === ASSET).length, 0);

  // asked for by hand: forgotten, and an error after an earlier stop is shown
  routes[ASSET] = { body: [Buffer.from('abcdeX')] };
  await assert.rejects(b.u.download(), /checksum/);
  assert.equal(kept.v, null);
  assert.match(b.u.state().error, /checksum/);
  assert.deepEqual(failed, ['0.9.3']);
});

test('cancel(false) stops without remembering (the option was switched off)', async () => {
  const { u } = updater({ [API]: { json: release('v0.9.3') }, [ASSET]: { body: stalling } }, { auto: () => true });
  await u.check();
  await new Promise(r => setTimeout(r, 30));
  u.cancel(false);
  await settled(u);
  assert.deepEqual([u.state().status, u.state().error, u.o.cancelled()], ['available', null, null]);
});

test('a resumed download counts what is on disk from the start', async () => {
  const seen = [];
  const routes = { [API]: { json: release('v0.9.3') }, [ASSET]: o => (o.headers.Range ? { status: 206, body: [Buffer.from('ef')] } : { body: [Buffer.from('abcdef')] }) };
  const { u } = updater(routes, { onChange: st => seen.push([st.status, st.got, st.progress]) });
  await u.check();
  fs.writeFileSync(path.join(u.o.tmpDir, 'TokenMuncher-Setup-0.9.3.exe.part'), 'abcd');
  await u.download();
  assert.deepEqual(seen.find(x => x[0] === 'downloading'), ['downloading', 4, 66]);
});
