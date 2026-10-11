/**
 * Live two-client check.
 *
 *   node tools/check-two-clients.mjs
 *
 * Two independent Supabase clients against the real project:
 *
 *   A  loads the shared workspace, changes a task, writes it back
 *   B  is subscribed to Realtime and must receive that change as a push
 *
 * This is the objective's final claim — "a change by one user appears for
 * another without a refresh" — exercised against real Postgres and the real
 * Realtime service, not a simulation.
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

const make = () =>
  createClient(env.PUBLIC_SUPABASE_URL, env.PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

const a = make();
const b = make();

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const { data: workspaces, error: wsError } = await a
  .from('workspaces')
  .select('id')
  .order('created_at', { ascending: true })
  .limit(1);
if (wsError || !workspaces?.length) {
  console.error('No shared workspace found. Open the app once to create it.', wsError?.message ?? '');
  process.exit(1);
}
const wsId = workspaces[0].id;
console.log(`\nWorkspace ${wsId}\n`);

const { data: tasks } = await a
  .from('tasks')
  .select('id, key, status, title')
  .order('position', { ascending: true })
  .limit(1);
if (!tasks?.length) {
  console.error('No tasks in the workspace; nothing to change.');
  process.exit(1);
}
const target = tasks[0];
const originalStatus = target.status;
const newStatus = originalStatus === 'REVIEW' ? 'PROG' : 'REVIEW';

console.log('Realtime');
// B subscribes first, then waits. A writes only once B is attached — writing
// before the subscription settles races the attach and the event is missed.
const received = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 30_000);
  const channel = b
    .channel('two-client-check')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'tasks', filter: `id=eq.${target.id}` },
      (payload) => {
        clearTimeout(timer);
        resolve(payload);
      },
    )
    .subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      setTimeout(async () => {
        const { error } = await a
          .from('tasks')
          .update({ status: newStatus, mutation_id: 'two-client-check' })
          .eq('id', target.id);
        if (error) console.log('  client A write failed:', error.message);
      }, 1500);
    });
  void channel;
});

check(
  `B received A's change to ${target.key}`,
  received !== null,
  received ? `status -> ${received.new?.status}` : 'timed out after 30s',
);
if (received) {
  check('the pushed row carries the new value', received.new?.status === newStatus, String(received.new?.status));
  check(
    'the push can be attributed to the writer',
    received.new?.mutation_id === 'two-client-check',
    String(received.new?.mutation_id),
  );
}

// Restore, so the check leaves no trace.
await a.from('tasks').update({ status: originalStatus }).eq('id', target.id);
const { data: restored } = await a.from('tasks').select('status').eq('id', target.id).single();
check('left the task as it was found', restored?.status === originalStatus, String(restored?.status));

await a.removeAllChannels();
await b.removeAllChannels();

console.log(
  failures === 0
    ? '\nTwo-client sync works: a change by one client is pushed to another.\n'
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
