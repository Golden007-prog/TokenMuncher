const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { samePath, entryExe, versionLess, oldCopies, isInstalledExe, shouldHandOver } = require('../src/main/install-lib');

test('samePath ignores case and normalizes, keeps non-ASCII', () => {
  assert.ok(samePath('C:\\Users\\Bartłomiej\\App\\TokenMuncher.exe', 'c:\\users\\BARTŁOMIEJ\\app\\.\\TokenMuncher.exe'));
  assert.ok(!samePath('C:\\a\\TokenMuncher.exe', 'C:\\b\\TokenMuncher.exe'));
  assert.ok(!samePath(null, 'C:\\a.exe'));
});

test('entryExe reads quoted and unquoted Run commands', () => {
  assert.equal(entryExe('"D:\\Dev\\TokenMuncher\\release\\TokenMuncher 0.4.0.exe" --hidden'), 'D:\\Dev\\TokenMuncher\\release\\TokenMuncher 0.4.0.exe');
  assert.equal(entryExe('D:\\Apps\\TokenMuncher\\TokenMuncher.exe --hidden'), 'D:\\Apps\\TokenMuncher\\TokenMuncher.exe');
  assert.equal(entryExe(''), null);
  assert.equal(entryExe(null), null);
});

test('versionLess compares numerically with missing parts as 0', () => {
  assert.ok(versionLess('0.8.0', '0.9.0'));
  assert.ok(versionLess('0.10.0', '0.11.0'));
  assert.ok(!versionLess('0.10.0', '0.9.0'));
  assert.ok(!versionLess('0.9.0.0', '0.9.0'));
  assert.ok(!versionLess('0.9.0', '0.9.0'));
});

test('oldCopies keeps only pre-0.9 copies from another exe', () => {
  const self = { pid: 1, exe: 'C:\\Programs\\tokenmuncher\\TokenMuncher.exe' };
  const list = [
    { Id: 1, Path: self.exe, FileVersion: '0.9.0' },                                       // this process
    { Id: 2, Path: 'C:\\PROGRAMS\\tokenmuncher\\TokenMuncher.exe', FileVersion: '0.8.0' }, // same exe, other case
    { Id: 3, Path: 'C:\\Temp\\x\\TokenMuncher.exe', FileVersion: '0.8.0' },                // old portable
    { Id: 4, Path: 'F:\\release\\win-unpacked\\TokenMuncher.exe', FileVersion: '0.9.0' },  // newer test build
    { Id: 5, Path: null, FileVersion: '0.5.0' },                                           // no access
    null
  ];
  assert.deepEqual(oldCopies(list, self).map(p => p.Id), [3]);
  assert.deepEqual(oldCopies(undefined, self), []);
});

test('only the installed copy has the uninstaller next to it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-inst-'));
  const exe = path.join(dir, 'TokenMuncher.exe');
  assert.ok(!isInstalledExe(exe));
  fs.writeFileSync(path.join(dir, 'Uninstall TokenMuncher.exe'), '');
  assert.ok(isInstalledExe(exe));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a running copy hands over only to the installation, never the other way', () => {
  const inst = 'C:\\Programs\\tokenmuncher\\TokenMuncher.exe';
  const build = 'F:\\release\\win-unpacked\\TokenMuncher.exe';
  const installed = exe => exe === inst;
  assert.ok(shouldHandOver(build, inst, installed));      // test build running, installed app started
  assert.ok(!shouldHandOver(inst, build, installed));     // installed running, test build started
  assert.ok(!shouldHandOver(inst, inst, installed));      // same copy started again
  assert.ok(!shouldHandOver(build, undefined, installed)); // second start without data
  assert.ok(!shouldHandOver(build, 'G:\\other\\TokenMuncher.exe', installed));
});
