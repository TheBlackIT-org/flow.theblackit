/**
 * End-to-end check of the shared workspace.
 *
 *   node tools/check-supabase.mjs
 *
 * Exercises the real Supabase project exactly as the browser does: the schema
 * is present, the anon key can read and write, task keys are reserved
 * atomically, RLS allows the anon role, and Realtime is broadcasting.
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

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

const db = createClient(url, key, { auth: { persistSession: false } });
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`\nSupabase project: ${url}\n`);

// 1. Schema present
const tables = ['workspaces', 'members', 'projects', 'tasks', 'subtasks', 'activity'];
console.log('Schema');
for (const table of tables) {
  const { error } = await db.from(table).select('*').limit(1);
  check(`table ${table}`, !error, error?.message);
}

if (failures) {
  console.log('\nThe migration has not been applied yet.');
  console.log('Run supabase/migrations/0001_init.sql in the SQL Editor, then retry.\n');
  process.exit(1);
}

// 2. Writable by the anon role
console.log('\nWrites (the anon key is the only credential)');
const wsId = crypto.randomUUID();
const { error: wsErr } = await db.from('workspaces').insert({ id: wsId, name: 'check', mode: 'live' });
check('insert a workspace', !wsErr, wsErr?.message);

const projectId = crypto.randomUUID();
const { error: pErr } = await db
  .from('projects')
  .insert({ id: projectId, workspace_id: wsId, key: 'CHK', name: 'Check project' });
check('insert a project', !pErr, pErr?.message);

// 3. Atomic key reservation, including under concurrency
if (!pErr) {
  const { data: k1, error: kErr } = await db.rpc('next_task_key', { p_project_id: projectId });
  check('next_task_key() returns a key', !kErr && k1 === 'CHK-1', `${k1 ?? kErr?.message}`);

  const parallel = await Promise.all(
    Array.from({ length: 8 }, () => db.rpc('next_task_key', { p_project_id: projectId })),
  );
  const keys = parallel.map((r) => r.data).filter(Boolean);
  check('8 concurrent calls are all distinct', new Set(keys).size === keys.length, keys.join(','));

  // The self-healing guarantee: a key that already exists must never be
  // returned again, whatever the stored counter says.
  await db.from('projects').update({ task_counter: 0 }).eq('id', projectId);
  const taken = (keys[0] ?? 'CHK-1');
  await db.from('tasks').insert({ project_id: projectId, key: taken, title: 'occupier', position: 90 });
  const { data: healed } = await db.rpc('next_task_key', { p_project_id: projectId });
  check(
    'counter reset to 0 does not re-issue an existing key',
    Boolean(healed) && healed !== taken,
    `asked again -> ${healed}`,
  );
  await db.from('tasks').delete().eq('project_id', projectId).eq('key', taken);

  const { data: rows, error: insErr } = await db
    .from('tasks')
    .insert({ project_id: projectId, key: k1 ?? 'CHK-1', title: 'Realtime probe', position: 0 })
    .select()
    .single();
  check('insert a task', !insErr, insErr?.message);

  // 4. updated_at trigger
  if (rows && !insErr) {
    const before = rows.updated_at;
    await new Promise((r) => setTimeout(r, 20));
    const { data: updated } = await db
      .from('tasks')
      .update({ status: 'PROG' })
      .eq('id', rows.id)
      .select()
      .single();
    check('updated_at is maintained by the trigger', updated && updated.updated_at !== before);

    // 5. Realtime delivery
    console.log('\nRealtime');
    const startedAt = Date.now();
    const seen = await new Promise((resolve) => {
      // A generous window: Realtime can take several seconds to attach a
      // channel on a cold project, and the broadcast is asynchronous.
      // Realtime is asynchronous and can be slow to warm on a cold project:
      // measured ~1-2s from write to delivery, but a first connection on a
      // sleeping project can take much longer, so this window is generous.
      const timer = setTimeout(() => resolve([]), 30_000);
      const channel = db
        .channel('check')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => {
          clearTimeout(timer);
          resolve([payload]);
        })
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return;
          // Let the subscription finish attaching server-side before writing.
          // Writing inside this callback races the subscription setup and the
          // event can be missed — the same trap the app avoids by resyncing on
          // connect.
          setTimeout(async () => {
            const { error } = await db.from('tasks').update({ status: 'REVIEW' }).eq('id', rows.id);
            if (error) console.log('    update failed:', error.message);
          }, 1500);
        });
      void channel;
    });
    check(
      'a task change is broadcast',
      seen.length > 0,
      seen.length ? `received in ${Date.now() - startedAt}ms` : 'timed out after 30s',
    );
  }

  // Clean up the probe data.
  await db.from('tasks').delete().eq('project_id', projectId);
  await db.from('projects').delete().eq('id', projectId);
}
await db.from('workspaces').delete().eq('id', wsId);

console.log(
  failures === 0
    ? '\nAll checks passed — the shared workspace is live.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
