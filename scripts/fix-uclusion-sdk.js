/**
 * fix-uclusion-sdk.js — postinstall fixup for the uclusion_sdk git dependency.
 *
 * uclusion_sdk ships ES-module source, but with extensionless relative imports
 * and no "type": "module" in its package.json — a layout that only loads under
 * the old, unmaintained `esm` loader. Native ESM (Node 18+) rejects it.
 *
 * uclusion_sdk is shared with the main web app, so we do NOT modify that repo.
 * Instead we re-apply the two fixes to the *installed copy* after every install.
 * Because it runs each time, it tracks whatever the (unpinned) git dependency
 * currently is — new component files get fixed automatically.
 *
 * Wired via the "postinstall" script in package.json, so it runs after every
 * npm install / npm ci / yarn install, i.e. before any test run.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkgDir = 'node_modules/uclusion_sdk';

if (!existsSync(pkgDir)) {
  console.warn(`[fix-uclusion-sdk] ${pkgDir} not found — skipping.`);
  process.exit(0);
}

// 1. Flag the dependency as an ES module.
const pkgPath = join(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.type !== 'module') {
  pkg.type = 'module';
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('[fix-uclusion-sdk] set "type": "module" in package.json');
}

// 2. Add explicit .js extensions to extensionless relative imports/exports.
//    Native ESM, unlike the `esm` loader, will not resolve them otherwise.
let patched = 0;

function fixFile(file) {
  const before = readFileSync(file, 'utf8');
  const after = before.replace(
    /(\bfrom\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
    (match, pre, spec, post) => (/\.\w+$/.test(spec) ? match : `${pre}${spec}.js${post}`),
  );
  if (after !== before) {
    writeFileSync(file, after);
    patched++;
    console.log(`[fix-uclusion-sdk] added .js extensions in ${file}`);
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (entry.endsWith('.js')) fixFile(full);
  }
}

const srcDir = join(pkgDir, 'src');
if (existsSync(srcDir)) walk(srcDir);

console.log(`[fix-uclusion-sdk] done (${patched} file(s) updated).`);
