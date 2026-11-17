// Helpers for scripts/dist.mjs: which CPU a Windows binary is built for, and
// the check that a packaged app holds only binaries for its installer's CPU.
const fs = require('fs');
const path = require('path');

const ARCHES = ['x64', 'arm64'];
const MACHINE = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };

// CPU of a Windows PE file (exe, dll, .node), from its header only.
function peArch(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const dos = Buffer.alloc(0x40);
    if (fs.readSync(fd, dos, 0, 0x40, 0) < 0x40 || dos.toString('latin1', 0, 2) !== 'MZ') throw new Error(`${file}: not a PE file`);
    const at = dos.readUInt32LE(0x3c);
    const nt = Buffer.alloc(6);
    if (fs.readSync(fd, nt, 0, 6, at) < 6 || nt.toString('latin1', 0, 4) !== 'PE\0\0') throw new Error(`${file}: not a PE file`);
    return MACHINE[nt.readUInt16LE(4)] || 'unknown';
  } finally { fs.closeSync(fd); }
}

// Every .exe, .dll and .node under dir that isn't built for `arch`, as
// "relative/path: cpu" lines; also how many were checked.
// elevate.exe: electron-builder's 32-bit helper for admin rights, the same in
// every build (runs emulated on ARM); this per-user app never uses it.
// "Uninstall …" is the installer's own (x86) uninstaller.
function wrongArch(dir, arch, root = dir) {
  const bad = [];
  let checked = 0;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(exe|dll|node)$/i.test(e.name) && !/^Uninstall /.test(e.name) && e.name !== 'elevate.exe') {
        checked++;
        const a = peArch(p);
        if (a !== arch) bad.push(`${path.relative(root, p)}: ${a}`);
      }
    }
  };
  walk(dir);
  return { bad, checked };
}

module.exports = { ARCHES, peArch, wrongArch };
