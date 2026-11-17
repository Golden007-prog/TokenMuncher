import { build } from 'esbuild';
import fs from 'fs';

const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));

fs.mkdirSync('dist/fonts', { recursive: true });
await build({
  entryPoints: ['src/renderer/app.jsx'],
  bundle: true,
  minify: true,
  outfile: 'dist/app.js',
  jsx: 'automatic',
  target: 'chrome130',
  define: { 'process.env.NODE_ENV': '"production"', __APP_VERSION__: JSON.stringify(version) },
  logLevel: 'warning'
});
for (const f of ['index.html', 'styles.css', 'fonts.css']) fs.copyFileSync(`src/renderer/${f}`, `dist/${f}`);
for (const f of fs.readdirSync('src/renderer/fonts')) fs.copyFileSync(`src/renderer/fonts/${f}`, `dist/fonts/${f}`);
console.log('built dist/');
