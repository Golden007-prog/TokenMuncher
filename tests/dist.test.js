// The CPU check of scripts/dist.mjs (scripts/dist-lib.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { peArch, wrongArch } = require('../scripts/dist-lib');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-pe-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Minimal PE file: "MZ", e_lfanew at 0x3c, then "PE\0\0" and the machine type.
function pe(name, machine) {
  const b = Buffer.alloc(0x100);
  b.write('MZ', 0, 'latin1');
  b.writeUInt32LE(0x80, 0x3c);
  b.write('PE\0\0', 0x80, 'latin1');
  b.writeUInt16LE(machine, 0x84);
  const f = path.join(dir, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, b);
  return f;
}

test('peArch reads x64, arm64 and ia32 from the PE header', () => {
  assert.equal(peArch(pe('a.exe', 0x8664)), 'x64');
  assert.equal(peArch(pe('b.exe', 0xaa64)), 'arm64');
  assert.equal(peArch(pe('c.exe', 0x14c)), 'ia32');
  assert.equal(peArch(pe('d.exe', 0x1234)), 'unknown');
  const zeros = path.join(dir, 'zeros.bin');
  fs.writeFileSync(zeros, Buffer.alloc(0x100));
  assert.throws(() => peArch(zeros), /not a PE file/);
  const tiny = path.join(dir, 'tiny.bin');
  fs.writeFileSync(tiny, 'MZ');
  assert.throws(() => peArch(tiny), /not a PE file/, 'short file');
});

test('wrongArch checks exe, dll and .node, skipping elevate.exe and the uninstaller', () => {
  const app = path.join(dir, 'app');
  pe('app/TokenMuncher.exe', 0xaa64);
  pe('app/ffmpeg.dll', 0x8664);                      // wrong
  pe('app/resources/x/better_sqlite3.node', 0xaa64);
  pe('app/resources/elevate.exe', 0x14c);             // skipped
  pe('app/Uninstall TokenMuncher.exe', 0x14c);        // skipped
  fs.writeFileSync(path.join(app, 'notes.txt'), 'x');
  const r = wrongArch(app, 'arm64');
  assert.equal(r.checked, 3);
  assert.deepEqual(r.bad, [`ffmpeg.dll: x64`]);
});
