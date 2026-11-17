// Pure helpers for install.js (no Electron), tested in tests/install.test.js.
const fs = require('fs');
const path = require('path');

// Windows paths compare case-insensitively.
const samePath = (a, b) => !!a && !!b && path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

// Exe of a Run entry command line: `"C:\a b\x.exe" --hidden` or `C:\x.exe --hidden`.
function entryExe(cmd) {
  const m = /^\s*(?:"([^"]+)"|(\S+))/.exec(cmd || '');
  return m ? m[1] || m[2] : null;
}

// a < b for dotted versions ("0.8.0", "0.9.0.0"); missing parts count as 0.
function versionLess(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

// Versions from here on write the instance marker and hand over by themselves.
const MARKER_SINCE = '0.9.0';

// From a Get-Process list ({ Id, Path, FileVersion }): TokenMuncher copies older
// than MARKER_SINCE started from another exe. Newer copies are never in it.
function oldCopies(list, self) {
  return (list || []).filter(p => p && p.Id !== self.pid && p.Path && !samePath(p.Path, self.exe) &&
    p.FileVersion && versionLess(p.FileVersion, MARKER_SINCE));
}

// The copy the installer put down has its uninstaller next to it; test builds
// (release\win-unpacked) and portable copies don't.
const isInstalledExe = exe => !!exe && fs.existsSync(path.join(path.dirname(exe), 'Uninstall TokenMuncher.exe'));

// The running copy (`self`) gets a second start from `other`: it quits in favour
// of the other one when that one is the installation and it isn't itself.
const shouldHandOver = (self, other, installed = isInstalledExe) =>
  !!other && !samePath(self, other) && installed(other) && !installed(self);

module.exports = { samePath, entryExe, versionLess, oldCopies, isInstalledExe, shouldHandOver, MARKER_SINCE };
