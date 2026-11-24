/* Builds the Cloudflare Workers deployment artifact:
   1. copies the static site into build/public (the asset binding directory)
   2. bundles worker/*.js into a single ESM file at dist/index.js
   The pair (dist/index.js + build/public) is what deploy.json ships. */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const publicDir = path.join(root, 'build', 'public');
const distDir = path.join(root, 'dist');

fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(publicDir, { recursive: true });

fs.copyFileSync(path.join(root, 'index.html'), path.join(publicDir, 'index.html'));
for (const extra of ['favicon.ico', 'robots.txt']) {
  const from = path.join(root, extra);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(publicDir, extra));
}

execFileSync(
  'npx',
  ['wrangler', 'deploy', '--dry-run', '--outdir', 'dist', '--config', 'wrangler.jsonc'],
  { stdio: 'inherit', cwd: root }
);

for (const extra of ['index.js.map', 'README.md']) {
  fs.rmSync(path.join(distDir, extra), { force: true });
}

const bundle = path.join(distDir, 'index.js');
if (!fs.existsSync(bundle)) {
  console.error('Build failed: expected bundle at', bundle);
  process.exit(1);
}
console.log(`\nBuilt ${path.relative(root, bundle)} (${(fs.statSync(bundle).size / 1024).toFixed(1)} KB)`);
console.log(`Static assets: ${path.relative(root, publicDir)} (${fs.readdirSync(publicDir).join(', ')})`);
