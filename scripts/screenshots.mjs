// npm run screenshots: the README screenshots in docs/screenshots/, taken
// from the app in demo mode (TM_DEMO: made-up projects and limits, never real
// data). Builds the renderer first; takes about a minute.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'screenshots');
// the electron package exports the path of its executable: run it directly, no shell (paths with spaces)
const electron = createRequire(import.meta.url)('electron');

const SHOTS = [
  { file: 'live.png', env: { TM_W: 1280, TM_H: 900 } },
  { file: 'history.png', env: { TM_W: 1280, TM_H: 1360, TM_VIEW: '2' } },
  { file: 'settings.png', env: { TM_W: 1280, TM_H: 1500, TM_VIEW: '3' } },
  { file: 'session.png', env: { TM_W: 1280, TM_H: 1000, TM_SESSION: '1' } },
  { file: 'layout.png', env: { TM_W: 1280, TM_H: 820, TM_KEYS: 'e' } },
  { file: 'mini.png', env: { TM_MINI: '1' } },
  // the other skins (live.png is the default one)
  ...['codex', 'cursor', 'copilot', 'paper', 'dracula', 'tokyo-night', 'intellij', 'solarized-light', 'windows-light', 'macos-dark'].map(t => ({ file: `theme-${t}.png`, env: { TM_W: 1280, TM_H: 700, TM_THEME: t } })),
  { file: 'mini-paper.png', env: { TM_MINI: '1', TM_THEME: 'paper' } }
];

fs.mkdirSync(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // inherited from VS Code terminals
if (spawnSync('node', ['build.mjs'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
let failed = 0;
for (const s of SHOTS) {
  const file = path.join(out, s.file);
  const r = spawnSync(electron, ['.'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120e3, env: { ...env, TM_DEMO: '1', TM_SHOT: file, ...Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)])) } });
  const ok = r.status === 0 && fs.existsSync(file);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} docs/screenshots/${s.file}`);
  if (!ok) console.log(String(r.stderr || r.error || '').split('\n').filter(l => l && !/gpu|GPU/.test(l)).slice(-5).join('\n'));
}
process.exit(failed ? 1 : 0);
