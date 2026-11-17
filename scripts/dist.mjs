// npm run dist: builds the renderer once, then the Windows installers for
// arm64 and x64, and checks that every packaged exe, dll and native module is
// built for the CPU its installer is for (from the PE header). An installer
// that fails the check is deleted.
//
// electron-builder rebuilds native modules (better-sqlite3, used for Cursor)
// in node_modules for the CPU it builds for, so afterwards they are always
// rebuilt for this machine again: `npm start` keeps working, also after a
// one-CPU or a failed run.
//   node scripts/dist.mjs            both
//   node scripts/dist.mjs x64        just one (x64 or arm64)
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { ARCHES, wrongArch } = require('./dist-lib.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const asked = process.argv.slice(2);
const bad = asked.filter(a => !ARCHES.includes(a));
if (bad.length) { console.error(`unknown CPU ${bad.join(', ')}; use ${ARCHES.join(' or ')}`); process.exit(2); }
const arches = asked.length ? asked : ['arm64', 'x64'];

const run = (args, env = {}) => spawnSync('npx', args, { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, ...env } }).status === 0;

delete process.env.ELECTRON_RUN_AS_NODE; // inherited from VS Code terminals; breaks the packaged-app steps
let ok = spawnSync('node', ['build.mjs'], { cwd: root, stdio: 'inherit' }).status === 0;
for (const arch of ok ? arches : []) {
  if (!run(['electron-builder', '--config', 'electron-builder.config.js', '--win', '--publish', 'never'], { TM_ARCH: arch })) { ok = false; break; }
  const unpacked = path.join(root, 'release', arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`);
  const { bad: wrong, checked } = wrongArch(unpacked, arch, root);
  if (!checked || wrong.length) {
    console.error(checked ? `wrong CPU in the ${arch} build:\n  ${wrong.join('\n  ')}` : `no binaries found in ${unpacked}`);
    const installer = path.join(root, 'release', `TokenMuncher-Setup-${version}${arch === 'x64' ? '' : '-' + arch}.exe`);
    for (const f of [installer, installer + '.blockmap']) fs.rmSync(f, { force: true });
    console.error(`removed ${path.relative(root, installer)}`);
    ok = false;
    break;
  }
  console.log(`${arch}: ${checked} exe/dll/.node files checked, all ${arch}`);
}

// Native modules back to this machine's CPU, whatever happened above (not on
// CI: that machine is thrown away).
const host = process.arch;
if (!process.env.CI && !run(['electron-builder', 'install-app-deps', `--arch=${host}`])) { console.error(`could not rebuild native modules for ${host}; run: npx electron-builder install-app-deps`); ok = false; }
process.exit(ok ? 0 : 1);
