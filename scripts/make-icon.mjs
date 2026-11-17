// Writes assets/icon.ico (exe, window, shortcut), assets/icon.png and the
// installer sidebar (assets/installer-sidebar.bmp) from the
// critter pixel map. Run `npm run icon` after changing the critter; the files
// are committed and a test checks they match the code.
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildAppIcon, buildInstallerSidebar, ICON_SIZES } = require('./icon-lib.js');

const assets = new URL('../assets/', import.meta.url); // repo root, whatever the cwd
const { ico, png } = buildAppIcon();
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(new URL('icon.ico', assets), ico);
fs.writeFileSync(new URL('icon.png', assets), png);
fs.writeFileSync(new URL('installer-sidebar.bmp', assets), buildInstallerSidebar());
console.log(`assets/icon.ico (${ICON_SIZES.join(', ')} px), assets/icon.png, assets/installer-sidebar.bmp`);
