/**
 * Schema contract.
 *
 * The SQL migration and the TypeScript mappers must agree on table and column
 * names. Without a database in CI, that agreement is checked here by parsing
 * the migration and comparing it against the rows the mappers actually emit —
 * so a rename on one side fails the suite instead of failing at runtime.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { seed } from '../src/lib/domain';
import {
  memberToRow,
  projectToRow,
  subtaskToRow,
  taskToRow,
} from '../src/lib/repository/mappers';

const SQL = readFileSync(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8');

/** Every migration after the first, so incremental ALTERs also count. */
const LATER_SQL = readdirSync(new URL('../supabase/migrations', import.meta.url))
  .filter((f) => f.endsWith('.sql') && !f.startsWith('0001'))
  .sort()
  .map((f) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8'));

/**
 * Column names declared for a table.
 *
 * Reads `0001_init.sql` **and** every later migration: the schema a client
 * actually talks to is the sum of all of them, so a column added by an ALTER is
 * as declared as one in the original CREATE. Only counting the first file made
 * a legitimate new column — `members.email` — look like drift.
 */
function columnsOf(table: string): Set<string> {
  const match = SQL.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`table ${table} not found in the migration`);
  const columns = new Set<string>();
  for (const line of match[1]!.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) continue;
    const name = trimmed.split(/\s+/)[0];
    if (name && /^[a-z_]+$/.test(name)) columns.add(name);
  }
  for (const sql of LATER_SQL) {
    const added = new RegExp(`alter table ${table}\\s+add column if not exists ([a-z_]+)`, 'gi');
    for (const m of sql.matchAll(added)) columns.add(m[1]!);
  }
  return columns;
}

const WS_ID = '11111111-1111-1111-1111-111111111111';

describe('migration declares the tables the app writes to', () => {
  it.each(['workspaces', 'members', 'projects', 'tasks', 'subtasks', 'activity'])(
    '%s exists',
    (table) => {
      expect(SQL).toContain(`create table if not exists ${table}`);
    },
  );

  it('enables row level security on every table', () => {
    // The migration pads column names for readability, so allow whitespace.
    for (const table of ['workspaces', 'members', 'projects', 'tasks', 'subtasks', 'activity']) {
      expect(SQL).toMatch(
        new RegExp(`alter table ${table}\\s+enable row level security`),
      );
    }
  });

  it('adds every table to the realtime publication', () => {
    const publication = SQL.slice(SQL.indexOf('supabase_realtime add table') - 400);
    for (const table of ['tasks', 'subtasks', 'projects', 'members', 'activity']) {
      expect(publication).toContain(table);
    }
  });

  it('defines the atomic key function the repository calls', () => {
    expect(SQL).toContain('create or replace function next_task_key(p_project_id uuid)');
    expect(SQL).toContain('create trigger tasks_touch_updated_at');
  });
});

describe('mapper rows only use declared columns', () => {
  const ws = seed(Date.UTC(2026, 9, 10));
  ws.tasks.forEach((t, i) => {
    t.position = i;
  });
  const task = ws.tasks[0]!;
  task.subs = [{ id: 's-1', t: 'A step', done: false }];

  const cases: Array<[string, Record<string, unknown>]> = [
    ['members', memberToRow(ws.members[0]!, WS_ID)],
    ['projects', projectToRow(ws.projects[0]!, WS_ID)],
    ['tasks', taskToRow(task, 3)],
    ['subtasks', subtaskToRow(task.subs[0]!, task.id, 0)],
  ];

  it.each(cases)('%s row matches the declared columns', (table, row) => {
    const declared = columnsOf(table);
    const emitted = Object.keys(row);
    expect(emitted.length).toBeGreaterThan(0);
    const unknown = emitted.filter((c) => !declared.has(c));
    expect(unknown, `${table} emits columns the migration does not declare`).toEqual([]);
  });

  it('does not emit fields the schema dropped', () => {
    const declared = columnsOf('tasks');
    // These live in the domain model but are intentionally not persisted.
    expect(declared.has('subs')).toBe(false);
    expect(declared.has('open')).toBe(false);
    expect(declared.has('workspaceId')).toBe(false);
  });

  it('gives every synced table the mutation tag echo suppression needs', () => {
    // The client tags every row it writes with a mutation id. If a table lacks
    // the column, PostgREST rejects the whole upsert and the write is lost —
    // which is exactly what happened to `members` and `projects`.
    for (const table of ['tasks', 'subtasks', 'projects', 'members', 'activity']) {
      expect(columnsOf(table).has('mutation_id'), `${table} is written with a mutation_id but has no column`).toBe(
        true,
      );
    }
  });

  it('declares the identity columns sign-in binds against', () => {
    // `user_id` has been reserved since 0001; `email` is what an invite is
    // addressed to, and the claim in `linkAccount` matches on it.
    const members = columnsOf('members');
    expect(members.has('user_id'), 'members.user_id missing').toBe(true);
    expect(members.has('email'), 'members.email missing').toBe(true);
    // One account, one member row — the claim would be ambiguous otherwise.
    const identity = LATER_SQL.join('\n');
    expect(identity).toMatch(/unique index if not exists members_user_id_key/i);
    expect(identity).toMatch(/unique index if not exists members_workspace_email_key/i);
  });

  it('exposes the audit columns the activity feed reads', () => {
    const declared = columnsOf('activity');
    for (const column of ['actor_id', 'actor_name', 'action', 'task_key', 'summary', 'created_at']) {
      expect(declared.has(column), `activity.${column} missing`).toBe(true);
    }
  });
});

describe('the row-level-security cutover', () => {
  const tighten = LATER_SQL.find((sql) => /tighten Row Level Security/i.test(sql)) ?? '';

  it('ships a migration that stops trusting the anon key', () => {
    expect(tighten, 'no RLS-tightening migration found').not.toBe('');
    // The permissive policies from 0001 are dropped, not merely shadowed.
    expect(tighten).toMatch(/drop policy if exists %I on %I/);
    expect(tighten).toMatch(/revoke all on %I from anon/);
  });

  it('resolves membership through SECURITY DEFINER helpers', () => {
    // A policy on `members` that queried `members` would recurse; the helper is
    // what makes the policy expressible at all.
    for (const fn of ['is_workspace_member', 'is_project_member', 'is_task_member']) {
      expect(tighten).toContain(`create or replace function ${fn}`);
    }
    expect((tighten.match(/security definer/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('leaves a way to claim an invite without already being a member', () => {
    // Without this clause the first sign-in can never bind: the account is not
    // a member yet, so a pure membership check would reject its own claim.
    expect(tighten).toMatch(/user_id is null and email is not null and lower\(email\) = current_email\(\)/);
  });
});
