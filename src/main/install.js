// Housekeeping for the installed app (per-user NSIS installer): autostart,
// the Start Menu shortcut, and other copies (e.g. a portable exe from before
// the installer, or a test build) that are still around.
const { app, shell, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { samePath, entryExe, oldCopies, isInstalledExe, shouldHandOver } = require('./install-lib');

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const exePath = () => process.execPath;
// Only the installed copy claims autostart and the shortcut; test runs with
// their own profile (TM_PROFILE) leave the user's alone.
const installed = () => app.isPackaged && process.platform === 'win32' && !process.env.TM_PROFILE && isInstalledExe(exePath());
// Electron writes the Run entry as `path args` without quoting; quote paths with spaces.
const quote = s => (/\s/.test(s) ? `"${s}"` : s);
const loginItem = () => ({ path: quote(exePath()), args: (app.isPackaged ? [] : [quote(path.resolve(app.getAppPath()))]).concat('--hidden') });

function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: !!on, ...loginItem() });
}
function autostartEnabled() {
  return app.getLoginItemSettings(loginItem()).openAtLogin;
}

// PowerShell with UTF-8 output: piped output would otherwise be in the OEM code
// page and mangle non-ASCII paths (C:\Users\Bartłomiej\...).
const ps = cmd => new Promise(resolve => {
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${cmd}`],
    { windowsHide: true, timeout: 10e3 }, (err, out) => resolve(err ? null : String(out).trim()));
});

// Autostart set up by an older copy (another path) moves to the installed one,
// so the old exe stops launching at login. Keeps the entry disabled if the user
// turned it off in Task Manager. Returns true when it moved.
async function migrateAutostart(appId) {
  if (!installed()) return false;
  const old = entryExe(await ps(`(Get-ItemProperty -LiteralPath '${RUN_KEY}' -Name '${appId}' -ErrorAction SilentlyContinue).'${appId}'`));
  if (!old || samePath(old, exePath())) return false;
  const item = app.getLoginItemSettings({ path: old }).launchItems.find(i => i.name === appId);
  app.setLoginItemSettings({ openAtLogin: true, enabled: item ? item.enabled : true, ...loginItem() });
  return true;
}

// Toasts need a Start Menu shortcut with the app id. The installer makes one;
// an older portable copy may have pointed it at itself, so put it back.
function ensureStartMenuShortcut(appId) {
  if (!installed()) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TokenMuncher.lnk');
  try {
    const exists = fs.existsSync(lnk);
    if (exists && samePath(shell.readShortcutLink(lnk).target, exePath())) return;
    shell.writeShortcutLink(lnk, exists ? 'replace' : 'create', {
      target: exePath(), cwd: path.dirname(exePath()), icon: exePath(), iconIndex: 0, appUserModelId: appId, description: 'TokenMuncher'
    });
  } catch (e) { console.error('shortcut', e.message); }
}

// Single instance. The copy holding the lock writes a marker (pid, exe) next to
// its data, so a second start knows who it is without listing processes.
const markerFile = () => path.join(app.getPath('userData'), 'instance.json');
const lockData = () => ({ exe: exePath() }); // passed to requestSingleInstanceLock
function markInstance() {
  try { fs.mkdirSync(path.dirname(markerFile()), { recursive: true }); fs.writeFileSync(markerFile(), JSON.stringify({ pid: process.pid, exe: exePath(), version: app.getVersion() })); } catch { /* best effort */ }
}
function readMarker() {
  try { const m = JSON.parse(fs.readFileSync(markerFile(), 'utf8')); return m && alive(m.pid) ? m : null; } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function waitGone(pids, ms = 10e3) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!pids.some(alive)) return true;
    await new Promise(res => setTimeout(res, 100));
  }
  return false;
}
function relaunch() { app.relaunch(); app.exit(0); }

// In the running copy: someone started TokenMuncher again. If that is the
// installation and this copy isn't (a test build, an old location), quit
// normally (saving data) so the installed one can take over; otherwise show
// the window as before.
function onSecondInstance(data, show) {
  if (shouldHandOver(exePath(), data && data.exe)) app.quit();
  else show();
}

// In a second start that didn't get the lock.
async function handleLockTaken() {
  const holder = readMarker();
  if (holder) {
    // 0.9.0 or newer: it either shows its window or quits for us (onSecondInstance).
    if (shouldHandOver(holder.exe, exePath()) && await waitGone([holder.pid])) return relaunch();
    return app.quit();
  }
  // No marker: the lock holder is older than 0.9.0, which can't be asked to
  // quit. Find it by its version and offer to close it.
  let list = [];
  if (app.isPackaged) {
    try { list = [].concat(JSON.parse(await ps('Get-Process TokenMuncher -ErrorAction SilentlyContinue | Select-Object Id, Path, FileVersion | ConvertTo-Json -Compress') || '[]') || []); } catch { /* none */ }
  }
  const others = oldCopies(list, { pid: process.pid, exe: exePath() });
  if (!others.length) return app.quit();
  // TM_LOCK_ANSWER=yes|no answers the question without showing it (tests).
  const preset = process.env.TM_LOCK_ANSWER;
  const r = preset ? { response: preset === 'yes' ? 0 : 1 } : await dialog.showMessageBox({
    type: 'question', title: 'TokenMuncher', buttons: ['Close it and start', 'Cancel'], defaultId: 0, cancelId: 1,
    message: 'An older TokenMuncher is still running.',
    detail: `Version ${others[0].FileVersion}, started from:\n${others[0].Path}\n\nClose it and start this version (${app.getVersion()})?`
  });
  if (r.response !== 0) return app.quit();
  // Old versions only quit from their tray menu, so this ends them without
  // their quit handlers: the next start rebuilds the usage cache from the logs.
  for (const o of others) { try { process.kill(o.Id); } catch { /* already gone */ } }
  await waitGone(others.map(o => o.Id));
  relaunch();
}

module.exports = { setAutostart, autostartEnabled, migrateAutostart, ensureStartMenuShortcut, lockData, markInstance, onSecondInstance, handleLockTaken };
