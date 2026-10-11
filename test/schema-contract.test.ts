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

/** Column names declared for a table in the migration. */
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
      const declared =
        columnsOf(table).has('mutation_id') ||
        // Later migrations may add it; both files count as the schema.
        LATER_SQL.some((sql) =>
          new RegExp(`alter table ${table}\\s+add column if not exists mutation_id`, 'i').test(sql),
        );
      expect(declared, `${table} is written with a mutation_id but has no column`).toBe(true);
    }
  });

  it('exposes the audit columns the activity feed reads', () => {
    const declared = columnsOf('activity');
    for (const column of ['actor_id', 'actor_name', 'action', 'task_key', 'summary', 'created_at']) {
      expect(declared.has(column), `activity.${column} missing`).toBe(true);
    }
  });
});
