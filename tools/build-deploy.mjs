#!/usr/bin/env node
/**
 * Build the site and promote it to the repository root.
 *
 * Hostinger's hPanel Git deploy copies the whole repository into the
 * subdomain's document root, and Apache looks for `index.html` there. Astro
 * refuses to build straight into `./`, so this builds to `dist/` as usual and
 * then copies the result up one level.
 *
 * It also refuses to promote a build that has no Supabase config baked in:
 * that deploy would look perfectly healthy while silently saving nothing to
 * the shared database.
 *
 *   npm run build:deploy
 */
import { cpSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

/** Files produced by the build that belong at the document root. */
const PROMOTE = ['index.html', '_astro', 'favicon.svg', 'robots.txt', '_redirects', '.htaccess'];

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });

console.log('› building');
run('npx', ['astro', 'build']);

// ---- Guard: is the backend actually configured in this build? --------
const jsDir = join(DIST, '_astro');
const bundles = readdirSync(jsDir).filter((f) => f.endsWith('.js'));
const code = bundles.map((f) => readFileSync(join(jsDir, f), 'utf8')).join('');
let envFile = '';
try {
  envFile = readFileSync(join(ROOT, '.env'), 'utf8');
} catch {
  console.error(
    '\n✗ No .env file.\n' +
      '  PUBLIC_* values are inlined at build time, so without it this build\n' +
      '  would ship in browser-local mode. Copy .env.example to .env and fill\n' +
      '  in the Supabase URL and anon key.\n',
  );
  process.exit(1);
}
const env = Object.fromEntries(
  envFile
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const url = env.PUBLIC_SUPABASE_URL ?? '';
if (url && !code.includes(new URL(url).hostname)) {
  console.error(
    '\n✗ The built bundle has no Supabase URL in it.\n' +
      '  This deploy would run in browser-local mode: it would look fine and\n' +
      '  share nothing. Check that PUBLIC_SUPABASE_URL is set in .env.\n',
  );
  process.exit(1);
}
console.log(`› backend baked in: ${url ? new URL(url).hostname : 'none (local mode)'}`);

// ---- Promote --------------------------------------------------------
console.log('› promoting to the repository root');
for (const name of PROMOTE) {
  const from = join(DIST, name);
  let present = true;
  try {
    statSync(from);
  } catch {
    present = false;
  }
  if (!present) continue;
  rmSync(join(ROOT, name), { recursive: true, force: true });
  cpSync(from, join(ROOT, name), { recursive: true });
  console.log(`  ${name}`);
}

console.log('\n✓ build ready — commit the root files and deploy from hPanel');
