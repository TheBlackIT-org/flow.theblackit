/**
 * Watch for the shared schema and verify it the moment it appears.
 *
 *   node tools/watch-schema.mjs
 *
 * Polls the Supabase REST endpoint for the tables the migration creates. When
 * they show up it runs the full end-to-end check (`check-supabase.mjs`) and
 * prints the result, so applying the migration is enough to get a verdict.
 *
 * Exits 0 when the schema verifies, 1 if the checks fail, and keeps waiting
 * (up to the timeout) while the tables are still absent.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const POLL_MS = 15_000;
const TIMEOUT_MS = Number(process.env.WATCH_TIMEOUT_MS ?? 30 * 60_000);

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const url = env.PUBLIC_SUPABASE_URL;
const key = env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const TABLES = ['workspaces', 'members', 'projects', 'tasks', 'subtasks', 'activity'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function present() {
  const results = await Promise.all(
    TABLES.map(async (table) => {
      try {
        const res = await fetch(`${url}/rest/v1/${table}?select=id&limit=1`, {
          headers: { apikey: key, Authorization: `Bearer ${key}` },
        });
        return { table, ok: res.ok, status: res.status };
      } catch (error) {
        return { table, ok: false, status: `network: ${error.message}` };
      }
    }),
  );
  return results;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: new URL('..', import.meta.url) });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const started = Date.now();
console.log(`Watching ${url} for the shared schema (poll every ${POLL_MS / 1000}s).`);
console.log('Waiting for all six tables…\n');

while (Date.now() - started < TIMEOUT_MS) {
  const results = await present();
  const missing = results.filter((r) => !r.ok);
  const stamp = new Date().toISOString().slice(11, 19);

  if (missing.length === 0) {
    console.log(`[${stamp}] All ${TABLES.length} tables are present. Running the checks…\n`);
    const code = await run(process.execPath, ['tools/check-supabase.mjs']);
    process.exit(code);
  }

  const summary = missing.map((m) => `${m.table}(${m.status})`).join(' ');
  console.log(`[${stamp}] waiting — missing: ${summary}`);
  await sleep(POLL_MS);
}

console.log('\nTimed out waiting for the schema. Re-run this after applying the migration.');
process.exit(1);
