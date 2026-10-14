/**
 * A stand-in for the Supabase client that records every call.
 *
 * This is what makes `SupabaseRepository` testable without a database: the
 * repository's whole job is deciding *which* rows to write, so the test asserts
 * on the SQL calls it makes rather than on stored state.
 */
import type {
  SupabaseError,
  SupabaseLikeChannel,
  SupabaseLikeClient,
  SupabaseLikeQuery,
  SupabaseLikeResult,
} from '../../src/lib/repository/supabase';

export interface RecordedCall {
  table: string;
  method: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  payload?: unknown;
  filters: Array<{ op: string; column?: string; value?: unknown }>;
  columns?: string;
  single: boolean;
  /** Only resolves when the chain is awaited. */
  resolve: () => SupabaseLikeResult;
}

export interface FakeSupabaseOptions {
  /** Shared row storage, so two fakes can act as two clients of one database. */
  tables?: Record<string, unknown[]>;
  /** Called after a write commits, with the rows that changed. */
  onChange?: (change: {
    table: string;
    method: 'insert' | 'upsert' | 'update' | 'delete';
    rows: Array<Record<string, unknown>>;
  }) => void;
}

export interface FakeSupabase {
  client: SupabaseLikeClient;
  /** Override the clock used for created_at/updated_at defaults. */
  setClock(ms: number): void;
  /** Prefix-free UUID lookup helper for building realistic fixtures. */
  uuid(seed: string): string;
  calls: RecordedCall[];
  /** Rows returned by the next select, keyed by table. */
  tables: Record<string, unknown[]>;
  /** Set to fail the next call against a table. */
  failures: Map<string, string>;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  rpcResult: { data: unknown; error: SupabaseError | null };
  channels: Array<{ name: string; handlers: Array<{ type: string; table: string; cb: (p: unknown) => void }> }>;
  /** Push an event to every subscriber, as Realtime would. */
  emit(table: string, payload: unknown): void;
  /** Simulate the socket reporting a status change. */
  emitStatus(status: string): void;
  removedChannels: string[];
}

export function fakeSupabase(
  initialTables: Record<string, unknown[]> = {},
  options: FakeSupabaseOptions = {},
): FakeSupabase {
  // Two fakes can share storage to model two clients of one database.
  const tables: Record<string, unknown[]> = options.tables ?? initialTables;
  const calls: RecordedCall[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const failures = new Map<string, string>();
  const channels: FakeSupabase['channels'] = [];
  const removedChannels: string[] = [];
  const statusListeners: Array<(s: string) => void> = [];

  /** Apply the recorded filters, the way PostgREST would. */
  const applyFilters = (rows: unknown[], call: RecordedCall): unknown[] => {
    let out = rows;
    for (const filter of call.filters) {
      if (filter.op === 'eq') {
        out = out.filter((r) => (r as Record<string, unknown>)[filter.column!] === filter.value);
      } else if (filter.op === 'in') {
        const allowed = filter.value as unknown[];
        out = out.filter((r) => allowed.includes((r as Record<string, unknown>)[filter.column!]));
      } else if (filter.op === 'is') {
        const value = (r: unknown) => (r as Record<string, unknown>)[filter.column!];
        out = out.filter((r) => value(r) === filter.value || (filter.value === null && value(r) === undefined));
      } else if (filter.op === 'limit') {
        out = out.slice(0, Number(filter.value));
      }
      // 'order' is applied after filtering, in `result`, so it is skipped here.
    }
    return out;
  };

  /** Actually store a write, so a later read can see it. */
  const applyWrite = (call: RecordedCall): Array<Record<string, unknown>> => {
    if (call.method === 'insert' || call.method === 'upsert') {
      // Clone the incoming values: mutating them would corrupt the caller's
      // diff baseline, which is exactly the kind of bug this suite exists to
      // catch in the app.
      const incoming = (Array.isArray(call.payload) ? call.payload : [call.payload]).map((r) => ({
        ...(r as Record<string, unknown>),
      }));

      // Emulate the column defaults the real tables declare, otherwise an
      // INSERT ... select('id').single() would hand the app an undefined id.
      const insertion = call.method === 'insert';
      let clock = Math.max(Date.now(), clockFloor);
      const nextTimestamp = () => new Date(clock++).toISOString();
      incoming.forEach((row) => {
        if (insertion && row.id === undefined) row.id = crypto.randomUUID();
        if (row.created_at === undefined) row.created_at = nextTimestamp();
        if (call.table === 'tasks' && row.updated_at === undefined) {
          row.updated_at = nextTimestamp();
        }
      });
      const store = (tables[call.table] ??= []);
      const written = incoming.map((row) => {
        const index = store.findIndex((r) => (r as { id?: unknown }).id === row.id);
        if (index >= 0) {
          // Merge into the stored object so the reference stays stable.
          Object.assign(store[index] as Record<string, unknown>, row);
          return store[index] as Record<string, unknown>;
        }
        store.push(row);
        return row;
      });
      options.onChange?.({
        table: call.table,
        method: call.method === 'insert' ? 'insert' : 'upsert',
        rows: written,
      });
      return written;
    } else if (call.method === 'update') {
      // PostgREST updates every row the filters select. Merging in place keeps
      // the stored reference stable, so a later read sees the new values.
      const matching = applyFilters(tables[call.table] ?? [], call) as Array<Record<string, unknown>>;
      const patch = { ...(call.payload as Record<string, unknown>) };
      matching.forEach((row) => Object.assign(row, patch));
      options.onChange?.({ table: call.table, method: 'update', rows: matching });
      return matching;
    } else if (call.method === 'delete') {
      const store = (tables[call.table] ?? []) as Array<Record<string, unknown>>;
      const inFilter = call.filters.find((f) => f.op === 'in');
      const eqFilter = call.filters.find((f) => f.op === 'eq');
      let removed: Array<Record<string, unknown>> = [];
      if (inFilter) {
        const allowed = inFilter.value as unknown[];
        removed = store.filter((r) =>
          allowed.includes((r as Record<string, unknown>)[inFilter.column!]),
        );
        tables[call.table] = store.filter((r) => !removed.includes(r));
      } else if (eqFilter) {
        removed = store.filter(
          (r) => (r as Record<string, unknown>)[eqFilter.column!] === eqFilter.value,
        );
        tables[call.table] = store.filter((r) => !removed.includes(r));
      }
      options.onChange?.({ table: call.table, method: 'delete', rows: removed });
      return removed;
    }
    return [];
  };

  const result = (call: RecordedCall): SupabaseLikeResult => {
    const failure = failures.get(call.table);
    if (failure) return { data: null, error: { message: failure } };

    if (call.method === 'select') {
      let rows = applyFilters(tables[call.table] ?? [], call);
      // PostgREST order() desc is what the activity feed asks for.
      const order = call.filters.find((f) => f.op === 'order');
      if (order) {
        const desc = (order.value as { ascending?: boolean } | undefined)?.ascending === false;
        rows = [...rows].sort((a, b) => {
          const av = (a as Record<string, unknown>)[order.column!];
          const bv = (b as Record<string, unknown>)[order.column!];
          // Compare numerically when both sides are numbers. String comparison
          // would order "10" before "9" and silently scramble `position`.
          const cmp =
            typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : String(av ?? '').localeCompare(String(bv ?? ''));
          return desc ? -cmp : cmp;
        });
      }
      return { data: call.single ? (rows[0] ?? null) : rows, error: null };
    }

    const stored = applyWrite(call);
    return { data: call.single ? (stored[0] ?? null) : stored, error: null };
  };

  /**
   * A fresh builder per call. Real PostgREST builders are immutable-ish chains;
   * reusing one object would let a later `.select()` overwrite the `.insert()`
   * that came before it.
   */
  const makeQuery = (table: string): SupabaseLikeQuery => {
    const call: RecordedCall = {
      table,
      method: 'select',
      filters: [],
      single: false,
      resolve: () => result(call),
    };
    calls.push(call);

    const chain: SupabaseLikeQuery = {
      select(columns) {
        // Only meaningful before a write; after an insert it just asks for the
        // inserted row back. Keep the write method intact.
        if (call.method === 'select') call.columns = columns;
        return chain;
      },
      insert(values) {
        call.method = 'insert';
        call.payload = values;
        return chain;
      },
      upsert(values) {
        call.method = 'upsert';
        call.payload = values;
        return chain;
      },
      update(values) {
        call.method = 'update';
        call.payload = values;
        return chain;
      },
      delete() {
        call.method = 'delete';
        return chain;
      },
      eq(column, value) {
        call.filters.push({ op: 'eq', column, value });
        return chain;
      },
      in(column, values) {
        call.filters.push({ op: 'in', column, value: values });
        return chain;
      },
      is(column, value) {
        call.filters.push({ op: 'is', column, value });
        return chain;
      },
      order(column, opts) {
        call.filters.push({ op: 'order', column, value: opts });
        return chain;
      },
      limit(count) {
        call.filters.push({ op: 'limit', value: count });
        return chain;
      },
      single() {
        call.single = true;
        return chain;
      },
      then<TResult1 = SupabaseLikeResult, TResult2 = never>(
        onFulfilled?: ((value: SupabaseLikeResult) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): PromiseLike<TResult1 | TResult2> {
        // The signature has to mirror `PromiseLike` exactly, or the builder is
        // not assignable to `SupabaseLikeQuery` in the first place.
        return Promise.resolve(call.resolve()).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  const client: SupabaseLikeClient = {
    from: (table) => makeQuery(table),
    rpc: (fn, args) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResult);
    },
    channel: (name): SupabaseLikeChannel => {
      const entry = { name, handlers: [] as FakeSupabase['channels'][number]['handlers'] };
      channels.push(entry);
      const channel: SupabaseLikeChannel = {
        on(type, filter, cb) {
          const table = String((filter as { table?: string }).table ?? '');
          // Presence listeners carry no table; they are not row subscriptions.
          if (table) entry.handlers.push({ type, table, cb });
          return channel;
        },
        subscribe(cb) {
          if (typeof cb === 'function') statusListeners.push(cb);
          return channel;
        },
        track: () => Promise.resolve('ok'),
        presenceState: () => ({}),
      };
      return channel;
    },
    removeChannel: () => {
      removedChannels.push('channel');
      return Promise.resolve('ok');
    },
  };

  const rpcResult: { data: unknown; error: SupabaseError | null } = { data: null, error: null };

  let clockFloor = 0;

  return {
    client,
    uuid: (seed: string) => uuidFor(seed),
    setClock: (ms: number) => {
      clockFloor = ms;
    },
    calls,
    tables,
    failures,
    rpcCalls,
    rpcResult,
    channels,
    removedChannels,
    emit(table, payload) {
      channels.forEach((c) =>
        c.handlers
          .filter((h) => h.table === table)
          .forEach((h) => h.cb(payload)),
      );
    },
    emitStatus(status) {
      statusListeners.forEach((cb) => cb(status));
    },
  };
}

/**
 * Deterministic UUID for a seed id like 't1', so fixtures use the same id
 * space the real schema enforces.
 */
const uuidCache = new Map<string, string>();
export function uuidFor(seed: string): string {
  const cached = uuidCache.get(seed);
  if (cached) return cached;

  // Four independent FNV-1a passes give the 32 hex digits a UUID needs.
  const pass = (offset: number): string => {
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt((i + offset) % seed.length), 16777619) >>> 0;
    }
    h = Math.imul(h ^ offset, 16777619) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  const hex = pass(0) + pass(1) + pass(3) + pass(7);
  const uuid = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(12, 15)}`,
    `8${hex.slice(15, 18)}`,
    hex.slice(18, 30),
  ].join('-');

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error(`uuidFor produced a malformed UUID for "${seed}": ${uuid}`);
  }
  uuidCache.set(seed, uuid);
  return uuid;
}

/** Calls of one kind against one table, for readable assertions. */
export function writesTo(fake: FakeSupabase, table: string, method?: RecordedCall['method']): unknown[] {
  return fake.calls
    .filter((c) => c.table === table && (!method || c.method === method))
    .map((c) => c.payload)
    .filter((p) => p !== undefined);
}

/** Every call against a table, in order. */
export function callsTo(fake: FakeSupabase, table: string): RecordedCall[] {
  return fake.calls.filter((c) => c.table === table);
}
