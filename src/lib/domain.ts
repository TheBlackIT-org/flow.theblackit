/**
 * BlackIT Flow — pure domain layer.
 *
 * `FlowDomain` owns the workspace value and every mutation rule. It never
 * touches the DOM and never touches `localStorage`, so it is fully unit
 * testable in Node. The DOM adapter (`app.ts`) reads `domain.workspace` to
 * render and calls these methods in response to events.
 */

import { CYCLE, DEFAULT_TYPES, PALETTE, PRIO, STATUS, STORAGE_KEY } from './constants';
import { dropIndex } from './reorder';
import type {
  ChatMessage,
  Member,
  ParsedTask,
  PriorityId,
  ProgressCounts,
  Project,
  StatusId,
  StatusDef,
  Subtask,
  Task,
  TaskType,
  Workspace,
} from './types';

/* --------------------------------- utils -------------------------------- */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape untrusted text before it goes anywhere near `innerHTML`. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (m) => ENTITIES[m] as string);
}

/**
 * Identifier for a newly created row.
 *
 * Must be a real UUID: these ids go straight into Postgres columns typed
 * `uuid`, and a readable string like `m1x9f2` is rejected — which silently
 * failed every member, task and project created through the UI. The prefix is
 * ignored now; it is kept so call sites read the same as before.
 */
export function uid(_prefix = ''): string {
  void _prefix;
  return uuid();
}

/**
 * A UUID derived from a namespace and a key — the same inputs always produce
 * the same id. Used for seeded rows so re-seeding is idempotent rather than
 * duplicating everything under fresh ids.
 *
 * Built on SHA-256 (RFC 4122 §4.3 name-based, simplified): the version and
 * variant nibbles are set so the value is a well-formed v4-shaped UUID that
 * Postgres accepts.
 */
export function namespacedId(namespace: string, key: string): string {
  const input = `${namespace}:${key}`;
  // Any 32 hex characters will do; a cheap deterministic hash avoids making
  // this asynchronous by needing SubtleCrypto.
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  let h3 = 0x811c9dc5;
  let h4 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ (c + i + 1), 16777619) >>> 0;
    h3 = Math.imul(h3 ^ (c * 31 + i), 16777619) >>> 0;
    h4 = Math.imul(h4 ^ (c ^ (i * 2654435761)), 16777619) >>> 0;
  }
  const hex =
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    h3.toString(16).padStart(8, '0') +
    h4.toString(16).padStart(8, '0');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * A real UUID v4. Used wherever an id has to satisfy Postgres's `uuid` type —
 * the browser-local workspace can get away with short readable ids, the shared
 * one cannot.
 */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for environments without WebCrypto.
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += hex[(Math.random() * 4) | 8];
    else out += hex[(Math.random() * 16) | 0];
  }
  return out;
}

export function statusOf(id: string): StatusDef {
  return STATUS.find((s) => s.id === id) ?? (STATUS[4] as StatusDef);
}

export function prioOf(id: string) {
  return PRIO.find((p) => p.id === id) ?? PRIO[1]!;
}

export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
}

export function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

export function relDays(ms: number, now: number = Date.now()): string {
  const d = Math.round((ms - now) / 86_400_000);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d}d` : `${Math.abs(d)}d late`;
}

export function relAgo(ms: number, now: number = Date.now()): string {
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

export function counts(list: Task[]): ProgressCounts {
  const c: ProgressCounts = { DONE: 0, PROG: 0, REVIEW: 0, BLOCK: 0, TODO: 0 };
  list.forEach((t) => {
    c[t.status] = (c[t.status] ?? 0) + 1;
  });
  return c;
}

export function percentDone(list: Task[]): number {
  if (!list.length) return 0;
  return Math.round((counts(list).DONE / list.length) * 100);
}

/**
 * Marks a composer anchor that should insert *below* the named task rather
 * than above it. Used by the rail `+` handle between two cards.
 */
export const AFTER_PREFIX = '__after:__';

/** Wrap a task id so the next created task lands below it. */
export function after(id: string): string {
  return AFTER_PREFIX + id;
}

/**
 * Project key derivation, mirroring the prototype's `keyFrom()` exactly
 * (workflow-chain.html line 1141): non-letters are dropped, multi-word names
 * become initials, a single word keeps its first four letters, and the result
 * is capped at four characters.
 *
 *   "Mobile app v1"                -> "MAV"
 *   "Natil Evidayaa · Mobile App"  -> "NEMA"
 *   "Redesign"                      -> "REDE"
 *   "theblackit.com Redesign"       -> "TR"
 */
export function keyFrom(name: string): string {
  const parts = String(name ?? '')
    .replace(/[^A-Za-z ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const k = parts.length > 1 ? parts.map((w) => w[0] ?? '').join('') : (parts[0] ?? '');
  return k.toUpperCase().slice(0, 4) || 'PRJ';
}

/**
 * Key used when the New-project dialog is submitted with the Key field empty.
 * The prototype's `openProjectModal()` derived initials from every word, which
 * differs from `keyFrom()` only for single-word names:
 *
 *   "Mobile app v1" -> "MAV"   (same as keyFrom)
 *   "Redesign"      -> "R"     (keyFrom gives "REDE")
 */
export function projectKeyFallback(name: string): string {
  const derived = String(name ?? '')
    // The prototype drops non-letters here too, so "theblackit.com" stays one
    // word and contributes a single letter.
    .replace(/[^A-Za-z ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 4);
  return derived || 'PRJ';
}

/* --------------------------------- seed --------------------------------- */

export function defaultTypes(): TaskType[] {
  return DEFAULT_TYPES.map((t) => ({ ...t }));
}

/**
 * A brand-new workspace with UUID keys.
 *
 * The demo seed uses short ids (`m1`, `t1`) because it never leaves the
 * browser. A *shared* workspace is stored in Postgres, whose keys are `uuid`, so
 * seeding one with the demo data fails at the first member write. This builds
 * the same starter content with real UUIDs.
 *
 * Pass an `id` factory to keep the mapping deterministic in tests.
 */
export function initialWorkspace(now: number = Date.now(), newId?: (prefix: string) => string): Workspace {
  // Postgres keys these rows with `uuid`, so a random base36 string is not
  // enough — it must be a real UUID or the first write is rejected.
  // Namespaced, deterministic UUIDs: running the seed again updates the same
  // rows instead of creating duplicates under fresh random ids.
  const make = newId ?? ((prefix: string) => namespacedId('blackit-flow/v1', prefix));
  const demo = seed(now);
  const map = new Map<string, string>();
  const remap = (old: string | null): string | null => {
    if (!old) return null;
    let next = map.get(old);
    if (!next) {
      // The whole seed id is the key: using a prefix collapsed every project
      // onto one UUID.
      next = make(old);
      map.set(old, next);
    }
    return next;
  };

  // Register every id before rewriting, so cross-references resolve.
  demo.members.forEach((m) => remap(m.id));
  demo.projects.forEach((p) => remap(p.id));
  demo.tasks.forEach((t) => {
    remap(t.id);
    remap(t.projectId);
    t.assigneeIds.forEach((id) => remap(id));
    remap(t.claimedBy);
    remap(t.createdBy);
    t.subs.forEach((s) => remap(s.id));
  });

  const ws = emptyWorkspace();
  ws.mode = 'live';
  ws.setup = true;
  ws.members = demo.members.map((m) => ({ ...m, id: remap(m.id)! }));
  ws.projects = demo.projects.map((p) => ({
    ...p,
    id: remap(p.id)!,
    // The shared sequence starts after the tasks this project is seeded with.
    taskCounter: demo.tasks.filter((t) => t.projectId === p.id).length,
  }));
  ws.tasks = demo.tasks.map((t, i) => ({
    ...t,
    id: remap(t.id)!,
    projectId: remap(t.projectId)!,
    assigneeIds: t.assigneeIds.map((id) => remap(id)!),
    claimedBy: remap(t.claimedBy),
    createdBy: remap(t.createdBy),
    position: i,
    subs: t.subs.map((sub) => ({ ...sub, id: remap(sub.id)! })),
  }));
  ws.me = remap(demo.me);
  ws.projectId = remap(demo.projectId);
  return ws;
}

export function emptyWorkspace(): Workspace {
  return {
    mode: 'fresh',
    setup: false,
    me: null,
    projectId: null,
    q: '',
    fMember: 'all',
    fStatus: 'all',
    composer: null,
    composerAnchor: null,
    enter: null,
    members: [],
    types: defaultTypes(),
    projects: [],
    tasks: [],
  };
}

/**
 * The demo workspace: 4 projects, 6 members, 32 tasks. Dates are relative to
 * `now` so the "overdue" and "due soon" states always have something to show.
 */
export function seed(now: number = Date.now() - 86_400_000): Workspace {
  const D = (n: number) => now - n * 86_400_000;

  const members: Member[] = [
    { id: 'm1', name: 'Arjun Menon', role: 'owner', title: 'Founder · Product & Engineering' },
    { id: 'm2', name: 'Nithin Raj', role: 'lead', title: 'Product Designer' },
    { id: 'm3', name: 'Sneha Thomas', role: 'member', title: 'Frontend Engineer' },
    { id: 'm4', name: 'Rahul Krishnan', role: 'member', title: 'Backend Engineer' },
    { id: 'm5', name: 'Meera Suresh', role: 'member', title: 'QA & Operations' },
    { id: 'm7', name: 'Flow Agent', role: 'member', title: 'AI agent', agent: true },
  ];

  const projects: Project[] = [
    { id: 'p1', key: 'NE', name: 'Natil Evidayaa · Mobile App', product: 'Natil Evidayaa' },
    { id: 'p2', key: 'NLM', name: 'Launch & Marketing', product: 'Natil Evidayaa' },
    { id: 'p3', key: 'WEB', name: 'theblackit.com Redesign', product: 'TheBlackIT' },
    { id: 'p4', key: 'FLOW', name: 'Flow · internal tool', product: 'TheBlackIT' },
  ];

  type Extra = { desc?: string; claimedBy?: string; claimedAt?: number };
  type Row = [
    string,
    string,
    string,
    string,
    string,
    StatusId,
    string | null,
    PriorityId,
    number,
    number,
    string[],
    Extra?,
  ];

  const rows: Row[] = [
    ['t1','p1','Chat with nearby Keralites · message list','tt1','Develop','PROG','m3','high',5,3,[],{claimedBy:'m3',claimedAt:D(5),desc:'Realtime list of nearby users with last-seen and distance. Reuse the existing socket room.'}],
    ['t2','p1','Emergency support button end-to-end flow','tt1','Develop','PROG','m7','urgent',8,4,[],{claimedBy:'m7',claimedAt:D(2),desc:'One tap alerts trusted contacts and the nearest volunteers.'}],
    ['t3','p1','Fix crash when location permission is denied','tt2','Test','BLOCK','m5','urgent',3,2,['t13'],{desc:'Reproduced on Android 12 only. Needs the matching API before the edge cases can be retested.'}],
    ['t4','p1','Onboarding walkthrough screens','tt1','Design','TODO',null,'normal',5,9,[],{desc:'Three screens: find people, chat, emergency help.'}],
    ['t5','p1','Diaspora map clustering at low zoom','tt1','Develop','TODO',null,'normal',8,12,[],{}],
    ['t6','p1','Push notification for “Keralite near you”','tt1','Discovery','TODO',null,'low',5,16,[],{}],
    ['t7','p1','Profile screen redesign','tt1','Design','REVIEW','m2','normal',3,1,[],{claimedBy:'m2',claimedAt:D(1)}],
    ['t8','p1','Localise the app to Malayalam','tt1','Discovery','TODO','m1','normal',13,20,[],{}],
    ['t9','p1','Signup OTP via SMS gateway','tt1','Develop','DONE','m4','high',5,-6,[],{}],
    ['t10','p1','App icon and splash screen','tt3','Design','DONE','m2','normal',2,-9,[],{}],
    ['t11','p1','Set up crash reporting','tt6','Test','DONE','m7','normal',2,-4,[],{}],
    ['t13','p1','Backend · user matching API','tt1','Develop','PROG','m4','high',8,5,[],{}],
    ['t14','p1','QA regression pass before beta','tt3','Test','TODO','m5','high',5,6,['t2','t13'],{}],
    ['t15','p1','Deploy beta build to Play Store internal track','tt3','Deploy','TODO','m1','high',2,7,['t3','t14'],{}],
    ['t12','p1','Live location sharing with family','tt1','Discovery','TODO',null,'low',8,24,[],{}],
    ['t16','p2','Landing page copy · Malayalam + English','tt3','Create','PROG','m2','high',3,2,[],{claimedBy:'m2',claimedAt:D(3)}],
    ['t17','p2','Press release for launch','tt3','Plan','TODO',null,'normal',3,8,[],{}],
    ['t18','p2','Product demo video (60 seconds)','tt3','Create','TODO',null,'high',5,10,[],{}],
    ['t19','p2','Instagram launch campaign calendar','tt3','Review','TODO','m5','normal',3,5,[],{}],
    ['t20','p2','Beta tester recruitment form','tt3','Publish','DONE','m1','normal',1,-3,[],{}],
    ['t21','p2','Launch day checklist','tt3','Plan','DONE','m5','normal',2,-2,[],{}],
    ['t22','p3','Sitemap and page inventory','tt3','Research','DONE','m2','normal',2,-8,[],{}],
    ['t23','p3','New brand visual direction (2 options)','tt3','Design','PROG','m2','high',5,3,[],{claimedBy:'m2',claimedAt:D(4),desc:'Rooted-in-Kerala warmth versus sharp product-company minimal.'}],
    ['t24','p3','Homepage hero + product showcase','tt3','Design','TODO',null,'high',5,6,[],{}],
    ['t25','p3','Products page · Natil Evidayaa detail','tt3','Design','TODO',null,'normal',3,9,[],{}],
    ['t26','p3','Blog / ideas section layout','tt3','Build','TODO','m1','low',3,14,[],{}],
    ['t27','p3','Performance budget + Lighthouse pass','tt3','QA','TODO','m3','low',3,12,[],{}],
    ['t29','p4','Define task status model','tt1','Develop','DONE','m1','high',5,-5,[],{}],
    ['t30','p4','Open task pool with claim action','tt1','Develop','PROG','m3','high',5,2,[],{claimedBy:'m3',claimedAt:D(3),desc:'Any member can take an unassigned task. Store who took it and when.'}],
    ['t31','p4','Project progress breakdown widget','tt1','Develop','PROG','m4','high',3,3,[],{}],
    ['t32','p4','Team workload view','tt1','Design','TODO',null,'normal',5,7,[],{}],
    ['t33','p4','Workflow template editor','tt1','Develop','TODO','m7','high',8,10,[],{}],
  ];

  const SUBS: Record<string, [string, boolean][]> = {
    t1: [['Message list renders nearby users', true], ['Distance rounding to 500m', true], ['Empty state when nobody is near', false], ['Pull to refresh', false]],
    t2: [['Alert reaches trusted contacts', true], ['Fallback SMS if the app is offline', true], ['Volunteer handoff screen', false], ['Works with no location permission', false]],
    t3: [['Capture device logs', true], ['Add permission rationale screen', true], ['Retest on Android 12', false]],
    t13: [['Distance query under 300ms', true], ['Rate limiting per user', true], ['Blocked-user filtering', false]],
    t14: [['Smoke test the chat flow', false], ['Test on low-end devices', false], ['Sign-off from Meera', false]],
    t15: [['Bump version and changelog', false], ['Upload signed AAB', false], ['Invite beta testers', false]],
    t16: [['Hero copy', true], ['Feature section copy', false], ['Malayalam proofread', false]],
    t23: [['Moodboard', true], ['Direction A screens', true], ['Direction B screens', false], ['Pick one with the team', false]],
    t30: [['Claim button on cards', true], ['Store claimedBy + claimedAt', true], ['Recently claimed list', false]],
    t31: [['Percent done calculation', true], ['Status breakdown bar', true], ['Per-stage counters', false]],
  };

  const seq: Record<string, number> = {};
  const tasks: Task[] = rows.map((r) => {
    const p = projects.find((x) => x.id === r[1]) as Project;
    seq[r[1]] = (seq[r[1]] ?? 0) + 1;
    const ex: Extra = r[11] ?? {};
    const num = parseInt(r[0].slice(1), 10);
    return {
      id: r[0],
      projectId: r[1],
      key: `${p.key}-${seq[r[1]]}`,
      title: r[2],
      typeId: r[3],
      stage: r[4],
      status: r[5],
      // The demo seed names one owner per task; the model holds a list.
      assigneeIds: r[6] ? [r[6]] : [],
      priority: r[7],
      estimate: r[8],
      dueAt: r[9] === null ? null : now + r[9] * 86_400_000,
      dependsOn: r[10] || [],
      description: ex.desc || '',
      createdAt: D(3 + (num % 16)),
      createdBy: 'm1',
      claimedBy: ex.claimedBy ?? null,
      claimedAt: ex.claimedAt ?? null,
      completedAt: r[5] === 'DONE' ? D(1 + (num % 5)) : null,
      subs: (SUBS[r[0]] ?? []).map((s) => ({ id: uid('s'), t: s[0], done: s[1] })),
      open: false,
    };
  });

  return {
    mode: 'demo',
    setup: true,
    me: 'm1',
    projectId: 'p1',
    q: '',
    fMember: 'all',
    fStatus: 'all',
    composer: null,
    composerAnchor: null,
    enter: null,
    members,
    types: defaultTypes(),
    projects,
    tasks,
  };
}

/** Coerce anything read back from storage into a valid workspace. */
export function normalise(raw: unknown): Workspace | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<Workspace>;
  if (!Array.isArray(d.tasks) || !Array.isArray(d.members)) return null;
  const ws: Workspace = { ...emptyWorkspace(), ...d } as Workspace;
  if (d.mode === undefined) ws.mode = d.projects && d.projects.length ? 'demo' : 'fresh';
  if (d.setup === undefined) ws.setup = true;
  if (!ws.types || !ws.types.length) ws.types = defaultTypes();
  ws.tasks = ws.tasks.map((t) => {
    // Older payloads carry a single `assigneeId` (tasks gained a full assignee
    // list later), and a hand-edited localStorage blob may carry neither.
    const legacy = (t as { assigneeId?: string | null }).assigneeId;
    return {
      ...t,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
      assigneeIds: Array.isArray(t.assigneeIds) ? t.assigneeIds : legacy ? [legacy] : [],
      subs: (Array.isArray(t.subs) ? t.subs : []).map((s) => ({
        ...s,
        id: s.id ?? uid('s'),
        done: Boolean(s.done),
      })),
    };
  });
  return ws;
}

/* -------------------------------- domain -------------------------------- */

/** What happened, for the audit trail and presence feed. */
export interface MutationEvent {
  action:
    | 'task.created'
    | 'task.deleted'
    | 'task.status'
    | 'task.claimed'
    | 'task.assigned'
    | 'task.reordered'
    | 'subtask.added'
    | 'project.created'
    | 'member.added'
    | 'member.removed'
    | 'workspace.reset';
  taskKey?: string;
  summary: string;
}

/** Resolves the next task key. Async when a shared backend owns the sequence. */
export type NextKeyFn = (projectId: string, fallback: () => string) => string | Promise<string>;

export interface DomainOptions {
  /** Injectable for tests; defaults to `globalThis.localStorage`. */
  storage?: Storage | null;
  now?: number;
  /** Overrides client-side key counting, e.g. `next_task_key()` in Postgres. */
  nextKey?: NextKeyFn;
  /** Observes mutations so they can be written to the audit trail. */
  onEvent?: (event: MutationEvent) => void;
  /**
   * Called after every mutation. The app debounces this into a backend write;
   * tests and the browser-local mode leave it unset and rely on `storage`.
   */
  persist?: (workspace: Workspace, options: { urgent?: boolean }) => void;
}

export class FlowDomain {
  workspace: Workspace;
  readonly storage: Storage | null;

  private readonly nextKeyFn: NextKeyFn | null;
  private readonly onEvent: ((event: MutationEvent) => void) | null;
  private readonly persistFn: ((workspace: Workspace, options: { urgent?: boolean }) => void) | null;

  constructor(workspace: Workspace, opts: DomainOptions = {}) {
    this.workspace = workspace;
    this.storage =
      opts.storage !== undefined ? opts.storage : typeof localStorage === 'undefined' ? null : localStorage;
    this.nextKeyFn = opts.nextKey ?? null;
    this.onEvent = opts.onEvent ?? null;
    this.persistFn = opts.persist ?? null;
  }

  /**
   * Replace the workspace wholesale — used when a remote snapshot arrives, when
   * a workspace is loaded from the backend, or when the user switches between
   * the demo and the live data. View-only preferences (which project is open,
   * filters, expanded cards) survive when the replacement still contains them,
   * so a resync never yanks the UI out from under someone.
   */
  adopt(next: Workspace, options: { keepView?: boolean } = {}): void {
    const keepView = options.keepView !== false;
    const previous = this.workspace;

    if (keepView && previous) {
      const projectStillExists = next.projects.some((p) => p.id === previous.projectId);
      next.projectId = projectStillExists ? previous.projectId : next.projectId;
      next.me = previous.me;
      next.fMember = previous.fMember;
      next.fStatus = previous.fStatus;
      next.composer = previous.composer;
      next.composerAnchor = previous.composerAnchor;
      const open = new Set(previous.tasks.filter((t) => t.open).map((t) => t.id));
      next.tasks.forEach((t) => {
        t.open = open.has(t.id);
      });
      const saved = new Map(previous.tasks.map((t) => [t.id, t.subs]));
      next.tasks.forEach((t) => {
        if (!t.subs.length && saved.has(t.id)) t.subs = saved.get(t.id) ?? [];
      });
    }

    next.enter = null;
    this.workspace = normalise(next) ?? next;
    // Fresh server positions invalidate the applier's idea of the previous order.
    void 0;
  }

  /** Private channel for the audit trail; never throws into a mutation. */
  private emit(event: MutationEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* an audit failure must not break the action */
    }
  }

  /** Reserve a key, awaiting the backend when one owns the sequence. */
  private async reserveKey(projectId: string): Promise<string> {
    const fallback = () => this.nextKey(projectId);
    return this.nextKeyFn ? this.nextKeyFn(projectId, fallback) : fallback();
  }

  /** Read from storage, falling back to an empty workspace. */
  static hydrate(opts: DomainOptions = {}): FlowDomain {
    const storage =
      opts.storage !== undefined ? opts.storage : typeof localStorage === 'undefined' ? null : localStorage;
    let ws: Workspace = emptyWorkspace();
    if (storage) {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) ws = normalise(JSON.parse(raw)) ?? ws;
      } catch {
        /* corrupt payload — start clean rather than crash */
      }
    }
    return new FlowDomain(ws, opts);
  }

  static demo(opts: DomainOptions = {}): FlowDomain {
    return new FlowDomain(seed(opts.now), opts);
  }

  static blank(opts: DomainOptions = {}): FlowDomain {
    return new FlowDomain(emptyWorkspace(), opts);
  }

  /**
   * Persist after a mutation. Always writes the browser-local copy (cheap, and
   * the offline fallback), then hands off to the backend hook when one is
   * installed. The backend write is deliberately not awaited: the in-memory
   * workspace is the optimistic copy, so the UI never waits on the network.
   */
  save(options: { urgent?: boolean } = {}): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.workspace));
    } catch {
      /* private mode / quota — the session still works in memory */
    }
    this.persistFn?.(this.workspace, options);
  }

  /* -------- lookups -------- */

  get db(): Workspace {
    return this.workspace;
  }

  member(id: string | null | undefined): Member | null {
    if (!id) return null;
    return this.workspace.members.find((m) => m.id === id) ?? null;
  }

  project(id: string | null | undefined): Project | null {
    if (!id) return this.workspace.projects[0] ?? null;
    return this.workspace.projects.find((p) => p.id === id) ?? this.workspace.projects[0] ?? null;
  }

  typeName(id: string): string {
    // A custom type is stored as its own text, so an unknown id is treated as
    // the label itself rather than collapsing to "Task".
    if (!id) return 'Task';
    return this.workspace.types.find((t) => t.id === id)?.name ?? id;
  }

  get me(): Member | null {
    return this.member(this.workspace.me) ?? this.workspace.members[0] ?? null;
  }

  get currentProject(): Project | null {
    return this.workspace.projects.find((p) => p.id === this.workspace.projectId) ?? this.workspace.projects[0] ?? null;
  }

  projectTasks(): Task[] {
    if (!this.workspace.projectId) return [];
    return this.workspace.tasks.filter((t) => t.projectId === this.workspace.projectId);
  }

  findTask(id: string): Task | null {
    return this.workspace.tasks.find((t) => t.id === id) ?? null;
  }

  /**
   * Everyone on a task, as prose. The assistant and toasts read better with
   * names than with ids, and the join is the same one the card renders.
   */
  assigneeNames(t: Task): string {
    return t.assigneeIds.map((id) => this.member(id)?.name ?? 'someone').join(', ');
  }

  /** The members of the rail node's outgoing connector colour. */
  colorFor(id: string | null): string {
    const i = this.workspace.members.findIndex((m) => m.id === id);
    return PALETTE[(i < 0 ? 0 : i) % PALETTE.length] as string;
  }

  visibleTasks(): Task[] {
    const { fMember, fStatus } = this.workspace;
    return this.projectTasks().filter((t) => {
      if (fMember === 'none') {
        if (t.assigneeIds.length) return false;
      } else if (fMember !== 'all' && !t.assigneeIds.includes(fMember)) {
        return false;
      }
      if (fStatus !== 'all' && t.status !== fStatus) return false;
      return true;
    });
  }

  progress(): { counts: ProgressCounts; total: number; pct: number } {
    const list = this.projectTasks();
    const c = counts(list);
    return { counts: c, total: list.length, pct: list.length ? Math.round((c.DONE / list.length) * 100) : 0 };
  }

  /* -------- mutations -------- */

  setStatus(id: string, status: StatusId): Task | null {
    const t = this.findTask(id);
    if (!t) return null;
    t.status = status;
    if (status === 'DONE' && !t.completedAt) t.completedAt = Date.now();
    if (status !== 'DONE') t.completedAt = null;
    this.save();
    this.emit({
      action: 'task.status',
      taskKey: t.key,
      summary: statusOf(status).label,
    });
    return t;
  }

  cycleStatus(id: string): Task | null {
    const t = this.findTask(id);
    if (!t) return null;
    const i = (CYCLE as readonly string[]).indexOf(t.status);
    return this.setStatus(id, CYCLE[(i + 1) % CYCLE.length] as StatusId);
  }

  /** Any member can take an unowned task; records who and when. */
  claim(id: string): { ok: boolean; message: string; task: Task | null } {
    const t = this.findTask(id);
    if (!t) return { ok: false, message: 'Task not found', task: null };
    if (!this.workspace.me) return { ok: false, message: 'Add yourself in Team first', task: t };
    const me = this.member(this.workspace.me);
    if (t.assigneeIds.includes(this.workspace.me)) {
      return { ok: false, message: `Already on ${t.key}`, task: t };
    }
    // The pool is only empty when nobody is on it; taking a task somebody else
    // already holds is a normal joint assignment, not a claim.
    const fromPool = t.assigneeIds.length === 0;
    t.assigneeIds.push(this.workspace.me);
    if (fromPool) {
      t.claimedBy = this.workspace.me;
      t.claimedAt = Date.now();
    }
    if (t.status === 'TODO') t.status = 'PROG';
    this.save();
    this.emit({
      action: 'task.claimed',
      taskKey: t.key,
      summary: fromPool ? (me?.name ?? 'Someone') : `${me?.name ?? 'Someone'} joined`,
    });
    return {
      ok: true,
      message: fromPool
        ? `You took ${t.key} · moved to In Progress`
        : `You are on ${t.key} too`,
      task: t,
    };
  }

  /**
   * Add one person to a task, without disturbing anybody already on it.
   *
   * Status follows the same rule as claiming: joining a task nobody has
   * started moves it to In Progress, because somebody is now working on it.
   */
  addAssignee(id: string, memberId: string): { message: string; task: Task | null } {
    const t = this.findTask(id);
    if (!t) return { message: 'Task not found', task: null };
    const m = this.member(memberId);
    if (!m) return { message: 'Member not found', task: t };
    if (t.assigneeIds.includes(memberId)) {
      return { message: `${m.name} is already on ${t.key}`, task: t };
    }
    const fromPool = t.assigneeIds.length === 0;
    t.assigneeIds.push(memberId);
    if (fromPool) {
      t.claimedBy = memberId;
      t.claimedAt = Date.now();
    }
    if (t.status === 'TODO') t.status = 'PROG';
    this.save();
    this.emit({
      action: 'task.assigned',
      taskKey: t.key,
      summary: fromPool ? m.name : `${m.name} joined`,
    });
    return { message: `${t.key} assigned to ${m.name}`, task: t };
  }

  /** Remove one person. The task drops back to the open pool once empty. */
  removeAssignee(id: string, memberId: string): { message: string; task: Task | null } {
    const t = this.findTask(id);
    if (!t) return { message: 'Task not found', task: null };
    if (!t.assigneeIds.includes(memberId)) return { message: 'Not on this task', task: t };
    const m = this.member(memberId);
    t.assigneeIds = t.assigneeIds.filter((x) => x !== memberId);
    // The "took it" record only survives while the person who took it is still
    // on the task; otherwise the card would credit somebody who has left.
    if (t.claimedBy === memberId) {
      const next = t.assigneeIds[0] ?? null;
      t.claimedBy = next;
      t.claimedAt = next ? t.claimedAt : null;
    }
    this.save();
    return {
      message: t.assigneeIds.length
        ? `${m?.name ?? 'Member'} removed from ${t.key}`
        : `${t.key} is back in the open pool`,
      task: t,
    };
  }

  /**
   * Replace the whole assignee list.
   *
   * `reassign` is the blunt instrument the ⋯ menu and the assistant use when
   * somebody says "put this on X": it means *X owns this now*, not "add X".
   * Use `addAssignee` for the additive case — they are different intentions and
   * conflating them loses work silently.
   */
  reassign(id: string, memberId: string | null): { message: string; task: Task | null } {
    const t = this.findTask(id);
    if (!t) return { message: 'Task not found', task: null };
    if (!memberId) {
      t.assigneeIds = [];
      t.claimedBy = null;
      t.claimedAt = null;
      this.save();
      return { message: `${t.key} is back in the open pool`, task: t };
    }
    const m = this.member(memberId);
    if (!m) return { message: 'Member not found', task: t };
    const fromPool = t.assigneeIds.length === 0;
    t.assigneeIds = [memberId];
    if (fromPool) {
      t.claimedBy = memberId;
      t.claimedAt = Date.now();
    } else if (t.claimedBy === null) {
      t.claimedBy = memberId;
    }
    if (t.status === 'TODO') t.status = 'PROG';
    this.save();
    this.emit({ action: 'task.assigned', taskKey: t.key, summary: m.name });
    return { message: `${t.key} assigned to ${m.name}`, task: t };
  }

  /** Set the assignee list wholesale, from the multi-select modal. */
  setAssignees(id: string, memberIds: string[]): { message: string; task: Task | null } {
    const t = this.findTask(id);
    if (!t) return { message: 'Task not found', task: null };
    const clean = [...new Set(memberIds)].filter((mid) => Boolean(this.member(mid)));
    const added = clean.filter((mid) => !t.assigneeIds.includes(mid));
    const removed = t.assigneeIds.filter((mid) => !clean.includes(mid));
    if (!added.length && !removed.length) return { message: 'No change', task: t };

    if (!clean.length) {
      t.assigneeIds = [];
      t.claimedBy = null;
      t.claimedAt = null;
      this.save();
      this.emit({ action: 'task.assigned', taskKey: t.key, summary: 'nobody' });
      return { message: `${t.key} is back in the open pool`, task: t };
    }

    const fromPool = t.assigneeIds.length === 0;
    t.assigneeIds = clean;
    if (fromPool || !t.claimedBy || !clean.includes(t.claimedBy)) {
      t.claimedBy = clean[0]!;
      t.claimedAt = t.claimedAt ?? Date.now();
    }
    if (t.status === 'TODO') t.status = 'PROG';
    this.save();
    const names = added.map((mid) => this.member(mid)?.name ?? 'member').join(', ');
    const left = removed.map((mid) => this.member(mid)?.name ?? 'member').join(', ');
    this.emit({
      action: 'task.assigned',
      taskKey: t.key,
      summary: [names && `+${names}`, left && `−${left}`].filter(Boolean).join(' ') || 'nobody',
    });
    const parts = [
      names ? `${names} added` : '',
      left ? `${left} removed` : '',
    ].filter(Boolean);
    return { message: `${t.key} · ${parts.join(', ')}`, task: t };
  }

  deleteTask(id: string): Task | null {
    const t = this.findTask(id);
    if (!t) return null;
    this.workspace.tasks = this.workspace.tasks.filter((x) => x.id !== id);
    this.save();
    this.emit({ action: 'task.deleted', taskKey: t.key, summary: t.title });
    return t;
  }

  toggleSub(taskId: string, index: number): void {
    const t = this.findTask(taskId);
    const sub = t?.subs[index];
    if (!t || !sub) return;
    sub.done = !sub.done;
    this.save();
  }

  addSub(taskId: string, text: string): Subtask | null {
    const t = this.findTask(taskId);
    const v = text.trim();
    if (!t || !v) return null;
    const sub: Subtask = { id: uid('s'), t: v, done: false };
    t.subs.push(sub);
    t.open = true;
    this.save();
    this.emit({ action: 'subtask.added', taskKey: t.key, summary: v });
    return sub;
  }

  removeSub(taskId: string, index: number): void {
    const t = this.findTask(taskId);
    if (!t) return;
    t.subs.splice(index, 1);
    this.save();
  }

  toggleSubtasks(taskId: string): void {
    const t = this.findTask(taskId);
    if (!t) return;
    t.open = !t.open;
    this.save();
  }

  updateTask(id: string, patch: Partial<Task>): Task | null {
    const t = this.findTask(id);
    if (!t) return null;
    Object.assign(t, patch);
    this.save();
    return t;
  }

  /** Replace the subtask list from a textarea, preserving done flags by text. */
  replaceSubs(id: string, lines: string[]): void {
    const t = this.findTask(id);
    if (!t) return;
    const old = t.subs;
    t.subs = lines.map((line, ix) => {
      const prev = old.find((o) => o.t === line) ?? old[ix];
      // Keep the existing row id when the text still matches, so an edit is an
      // UPDATE rather than a delete + insert.
      return { id: prev?.id ?? uid('s'), t: line, done: prev ? !!prev.done : false };
    });
    this.save();
  }

  nextKey(projectId: string): string {
    const p = this.project(projectId);
    if (!p) return 'TASK-1';
    const n = this.workspace.tasks.filter((t) => t.projectId === p.id).length + 1;
    return `${p.key}-${n}`;
  }

  /**
   * Insert relative to `anchorId`:
   *  - `null`            → append to the end of the chain
   *  - `AFTER:<taskId>`  → directly below that task (the rail `+` handle)
   *  - `<taskId>`        → directly above that task
   * Falls back to appending when the anchor no longer exists.
   */
  insertTask(task: Task, anchorId: string | null): void {
    if (anchorId) {
      const after = anchorId.startsWith(AFTER_PREFIX);
      const target = after ? anchorId.slice(AFTER_PREFIX.length) : anchorId;
      const gi = this.workspace.tasks.findIndex((t) => t.id === target);
      if (gi >= 0) {
        this.workspace.tasks.splice(after ? gi + 1 : gi, 0, task);
        return;
      }
    }
    this.workspace.tasks.push(task);
  }

  async createTask(input: {
    title: string;
    typeId: string;
    /** The composer offers one owner; more can be added from the card. */
    assigneeId: string | null;
    due: string | null;
    priority: PriorityId;
    desc?: string;
  }): Promise<Task | null> {
    const p = this.currentProject;
    if (!p) return null;
    const anchor = this.workspace.composerAnchor;
    // Reserved before the row is built: the shared sequence is authoritative.
    const key = await this.reserveKey(p.id);
    const t: Task = {
      id: uid('t'),
      projectId: p.id,
      key,
      title: input.title,
      typeId: input.typeId,
      stage: 'New',
      status: input.assigneeId ? 'PROG' : 'TODO',
      assigneeIds: input.assigneeId ? [input.assigneeId] : [],
      priority: input.priority,
      estimate: 3,
      dueAt: input.due ? new Date(`${input.due}T12:00:00`).getTime() : null,
      dependsOn: [],
      description: input.desc ?? '',
      createdAt: Date.now(),
      createdBy: this.workspace.me,
      claimedBy: input.assigneeId,
      claimedAt: input.assigneeId ? Date.now() : null,
      completedAt: null,
      subs: [],
      open: false,
    };
    this.insertTask(t, anchor);
    this.workspace.enter = t.id;
    this.workspace.composer = null;
    this.workspace.composerAnchor = null;
    // Urgent: the moment right after adding a task is when someone is most
    // likely to refresh or close the tab.
    this.save({ urgent: true });
    this.emit({ action: 'task.created', taskKey: t.key, summary: t.title });
    return t;
  }

  async addAssistantTask(p: ParsedTask): Promise<Task | null> {
    const pid = p.projectId ?? this.workspace.projectId;
    if (!pid) return null;
    const key = await this.reserveKey(pid);
    const t: Task = {
      id: uid('t'),
      projectId: pid,
      key,
      title: p.title,
      typeId: 'tt3',
      stage: 'New',
      status: p.owner ? 'PROG' : 'TODO',
      assigneeIds: p.owner ? [p.owner.id] : [],
      priority: p.prio,
      estimate: 3,
      dueAt: p.due ? new Date(`${p.due}T12:00:00`).getTime() : null,
      dependsOn: [],
      description: '',
      createdAt: Date.now(),
      createdBy: this.workspace.me,
      claimedBy: p.owner ? p.owner.id : null,
      claimedAt: p.owner ? Date.now() : null,
      completedAt: null,
      subs: [],
      open: false,
    };
    this.workspace.tasks.push(t);
    this.workspace.enter = t.id;
    this.save();
    this.emit({ action: 'task.created', taskKey: t.key, summary: t.title });
    return t;
  }

  /**
   * Reorder within the current project by dropping `id` onto `anchorId`
   * (`'__end__'` appends). Returns the new 1-based position, or null when the
   * move was a no-op. Order is cosmetic: no status is ever touched.
   */
  moveTask(id: string, anchorId: string): number | null {
    const ids = this.projectTasks().map((t) => t.id);
    const from = ids.indexOf(id);
    const to = dropIndex(from, anchorId, ids, ids.length);
    if (to === null) return null;
    const arr = this.workspace.tasks.slice();
    const [moved] = arr.splice(arr.findIndex((t) => t.id === id), 1);
    if (!moved) return null;
    if (anchorId === '__end__') arr.push(moved);
    else arr.splice(arr.findIndex((t) => t.id === anchorId), 0, moved);
    this.workspace.tasks = arr;
    this.workspace.enter = id;
    this.save();
    const position = this.projectTasks().findIndex((t) => t.id === id) + 1;
    this.emit({
      action: 'task.reordered',
      taskKey: moved.key,
      summary: `position ${position}`,
    });
    return position;
  }

  /**
   * Add somebody to the workspace.
   *
   * `account` carries the sign-in identity when there is one: an email is an
   * invitation (the first account to sign in with it claims this row), and a
   * user id binds it immediately. The domain treats both as plain data — it
   * never asks who is signed in, which is what keeps it testable in Node.
   */
  addMember(
    name: string,
    title = '',
    role: Member['role'] = 'member',
    account?: { email?: string | null; userId?: string | null },
  ): Member {
    const m: Member = { id: uid('m'), name: name.trim(), role, title: title.trim() };
    const email = (account?.email ?? '').trim();
    if (email) m.email = email;
    if (account?.userId) m.userId = account.userId;
    this.workspace.members.push(m);
    if (!this.workspace.me) this.workspace.me = m.id;
    this.save();
    this.emit({ action: 'member.added', summary: m.name });
    return m;
  }

  removeMember(id: string): { ok: boolean; message: string; owned: number } {
    const m = this.member(id);
    if (!m) return { ok: false, message: 'Member not found', owned: 0 };
    if (this.workspace.members.length <= 1) {
      return { ok: false, message: 'Keep at least one member', owned: 0 };
    }
    const owned = this.workspace.tasks.filter((t) => t.assigneeIds.includes(id)).length;
    this.workspace.tasks.forEach((t) => {
      if (t.assigneeIds.includes(id)) {
        t.assigneeIds = t.assigneeIds.filter((x) => x !== id);
      }
      if (t.claimedBy === id) {
        t.claimedBy = t.assigneeIds[0] ?? null;
        t.claimedAt = t.claimedBy ? t.claimedAt : null;
      }
    });
    this.workspace.members = this.workspace.members.filter((x) => x.id !== id);
    if (this.workspace.me === id) this.workspace.me = this.workspace.members[0]?.id ?? null;
    this.save();
    this.emit({ action: 'member.removed', summary: m.name });
    return { ok: true, message: `${m.name} removed`, owned };
  }

  createProject(name: string, key: string, product: string): Project {
    // Only reached when the Key field is empty. Mirrors the prototype's
    // openProjectModal() fallback, which differs from keyFrom() for single-word
    // names ("Redesign" -> "R" here, "REDE" in the wizard preview).
    const finalKey =
      (key || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5) ||
      projectKeyFallback(name);
    const p: Project = {
      id: uid('p'),
      key: finalKey,
      name: name.trim(),
      // Fall back to the project name, and ignore a whitespace-only product.
      product: product.trim() || name.trim() || 'My workspace',
    };
    this.workspace.projects.push(p);
    this.workspace.projectId = p.id;
    this.workspace.fMember = 'all';
    this.workspace.fStatus = 'all';
    this.workspace.composer = 1;
    this.workspace.composerAnchor = null;
    // Creating the first project is what ends "first run". `setup` was only
    // ever set on load, so a workspace created in this session kept showing the
    // welcome screen until it was reloaded.
    this.workspace.setup = true;
    this.save({ urgent: true });
    this.emit({ action: 'project.created', summary: p.name });
    return p;
  }

  clearFilters(): void {
    this.workspace.fMember = 'all';
    this.workspace.fStatus = 'all';
    this.save();
  }

  /* -------- assistant -------- */

  findMemberIn(text: string): Member | null {
    const s = text.toLowerCase();
    return (
      this.workspace.members.find(
        (m) => s.includes(m.name.toLowerCase()) || s.includes((m.name.split(' ')[0] ?? '').toLowerCase()),
      ) ?? null
    );
  }

  parseTask(query: string): ParsedTask {
    let t = query.replace(/\s+/g, ' ').trim();
    t = t.replace(
      /^(please\s+)?(can you\s+)?(add|create|make|new|schedule)\s+(a\s+|an\s+|the\s+)?(task|todo|to-do|item|step)?\s*[:\-]?\s*/i,
      '',
    );
    const lower = t.toLowerCase();
    const prio: PriorityId = /\burgent\b/.test(lower)
      ? 'urgent'
      : /\bhigh\b/.test(lower)
        ? 'high'
        : /\blow\b/.test(lower)
          ? 'low'
          : 'normal';
    const owner = this.findMemberIn(lower);
    const now = new Date();
    const mk = (d: number) => {
      const x = new Date(now);
      x.setDate(x.getDate() + d);
      return x.toISOString().slice(0, 10);
    };
    let due: string | null = null;
    if (/\btoday\b/i.test(t)) due = mk(0);
    else if (/\btomorrow\b/i.test(t)) due = mk(1);
    else if (/\bnext week\b/i.test(t)) due = mk(7);
    else {
      const n = t.match(/\bin\s+(\d+)\s+days?\b/i);
      if (n) due = mk(Number(n[1]));
      else {
        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const wd = days.findIndex((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));
        if (wd >= 0) {
          let diff = (wd - now.getDay() + 7) % 7;
          if (diff === 0) diff = 7;
          due = mk(diff);
        }
      }
    }
    let title = t
      .replace(/\bdue\b[\s\S]*$/i, '')
      .replace(
        /\bby\s+(the\s+)?(end of\s+)?(today|tomorrow|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
        '',
      )
      .replace(/\bin\s+\d+\s+days?\b/i, '')
      .replace(/\b(urgent|high|low|normal)\s+priority\b/i, '')
      .replace(/\b(urgent|high|low)\b/gi, '')
      .replace(/\b(for|to|assign(?:ed)? to)\s+[A-Z][a-z]+(\s+[A-Z][a-z]+)?/g, '')
      .replace(/[\s,.]+$/, '')
      .trim();
    if (owner) {
      title = title
        .replace(new RegExp(`\\b${owner.name.split(' ')[0]}\\b`, 'ig'), '')
        .replace(/[\s,.]+$/, '')
        .trim();
    }
    title = title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Untitled task';
    return { title, owner, prio, due, projectId: this.workspace.projectId };
  }

  /**
   * Answer a free-text question, or draft a task. Returns rendered HTML plus
   * an optional pending task awaiting "Add to the chain".
   */
  reply(question: string): { html: string; pending: ParsedTask | null; mutated: boolean } {
    const s = question.toLowerCase();
    const list = this.projectTasks();
    const { counts: c, total, pct } = this.progress();
    const P = this.currentProject;
    if (!P) {
      return {
        html: 'There is no project yet. Use <b>+ Project</b> in the header, then I can add tasks and answer questions about the chain.',
        pending: null,
        mutated: false,
      };
    }
    const km = question.match(/\b([A-Za-z]{2,5}-\d+)\b/);
    const hit = km ? this.workspace.tasks.find((t) => t.key.toLowerCase() === km[1]!.toLowerCase()) : null;

    if (hit && /\b(assign|reassign|give)\b/.test(s)) {
      const m = this.findMemberIn(s);
      if (m) {
        this.reassign(hit.id, m.id);
        return { html: `<b>${esc(hit.key)}</b> is now with ${esc(m.name)}.`, pending: null, mutated: true };
      }
      return {
        html: `Who should take <b>${esc(hit.key)}</b>? Names: ${this.workspace.members.map((m) => esc(m.name)).join(', ')}.`,
        pending: null,
        mutated: false,
      };
    }
    if (hit && /\b(done|complete|completed|finish|finished)\b/.test(s)) {
      this.setStatus(hit.id, 'DONE');
      return { html: `<b>${esc(hit.key)}</b> marked as Done. The chain recoloured.`, pending: null, mutated: true };
    }
    if (hit && /\b(start|begin|working|progress)\b/.test(s)) {
      this.setStatus(hit.id, 'PROG');
      return { html: `<b>${esc(hit.key)}</b> is now In Progress.`, pending: null, mutated: true };
    }
    if (hit && /\b(block|blocked|stuck)\b/.test(s)) {
      this.setStatus(hit.id, 'BLOCK');
      return { html: `<b>${esc(hit.key)}</b> marked as Blocked.`, pending: null, mutated: true };
    }
    if (hit && /\b(take|claim|join)\b/.test(s) && !hit.assigneeIds.includes(this.workspace.me ?? '')) {
      this.claim(hit.id);
      return { html: `You took <b>${esc(hit.key)}</b>.`, pending: null, mutated: true };
    }

    if (/\b(add|create|new|make|schedule)\b/.test(s) && !/^(how|what|who|why|where)/.test(s)) {
      return { html: 'Here is what I understood. Add it?', pending: this.parseTask(question), mutated: false };
    }
    if (/block/.test(s)) {
      const b = list.filter((t) => t.status === 'BLOCK');
      return {
        html: b.length
          ? `Blocked in <b>${esc(P.name)}</b>:<br>${b
              .map(
                (t) =>
                  `<span class="k">${esc(t.key)}</span> ${esc(t.title)}${
                    t.assigneeIds.length ? ` · ${esc(this.assigneeNames(t))}` : ' · no owner'
                  }`,
              )
              .join('<br>')}`
          : 'Nothing is blocked in this project right now.',
        pending: null,
        mutated: false,
      };
    }
    if (/due|deadline|week|overdue|late/.test(s)) {
      const soon = list
        .filter((t) => t.dueAt && t.status !== 'DONE')
        .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0))
        .slice(0, 6);
      if (!soon.length) {
        return { html: 'No open task in this project has a due date.', pending: null, mutated: false };
      }
      return {
        html:
          'Coming up:<br>' +
          soon
            .map(
              (t) =>
                `<span class="k">${esc(t.key)}</span> ${esc(t.title)} · ${
                  (t.dueAt ?? 0) < Date.now() ? '<b>overdue</b>' : shortDate(t.dueAt ?? 0)
                } · ${t.assigneeIds.length ? esc(this.assigneeNames(t)) : 'not taken'}`,
            )
            .join('<br>'),
        pending: null,
        mutated: false,
      };
    }
    if (/who|workload|busy|capacity|load|team/.test(s)) {
      const rows = this.workspace.members
        .map((m) => ({
          m,
          n: this.workspace.tasks.filter((t) => t.assigneeIds.includes(m.id) && t.status !== 'DONE').length,
        }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 4);
      return {
        html: `Busiest right now:<br>${rows.map((r) => `${esc(r.m.name)} · <b>${r.n}</b> active`).join('<br>')}`,
        pending: null,
        mutated: false,
      };
    }
    if (/not taken|unassigned|pool|no owner|available|claim/.test(s)) {
      const p = this.workspace.tasks.filter((t) => !t.assigneeIds.length && t.status !== 'DONE');
      return {
        html: p.length
          ? `${p.length} tasks have no owner:<br>${p
              .slice(0, 6)
              .map((t) => `<span class="k">${esc(t.key)}</span> ${esc(t.title)}`)
              .join('<br>')}`
          : 'Every task has an owner right now.',
        pending: null,
        mutated: false,
      };
    }
    if (/progress|how far|percent|percentage|done|status/.test(s)) {
      return {
        html: `<b>${esc(P.name)}</b> is <b>${pct}%</b> done. Done ${c.DONE} · In progress ${c.PROG} · In review ${c.REVIEW} · Blocked ${c.BLOCK} · Not taken ${c.TODO}.`,
        pending: null,
        mutated: false,
      };
    }
    if (/reorder|drag|move|order|position|sort/.test(s)) {
      return {
        html: 'Drag the grip handle on a card (or drag the card itself with a mouse) and a teal line shows exactly where it will land. Reordering never changes any status.',
        pending: null,
        mutated: false,
      };
    }
    if (/subtask|checklist|step/.test(s)) {
      return {
        html: 'Open the Subtasks row on any card. Anyone can tick, add or delete steps there, and the progress chip updates straight away.',
        pending: null,
        mutated: false,
      };
    }
    if (/insert|add between|composer/.test(s)) {
      return {
        html: 'Hover the line between two nodes and press <b>+</b> to insert a task at that exact spot, or use “Add task at the end of the chain”.',
        pending: null,
        mutated: false,
      };
    }
    if (/take|claim|assign|owner/.test(s)) {
      return {
        html: 'Unowned cards show a <b>Take this task</b> button. Any member can claim one, and it records who took it and when. Or use Reassign owner in the ⋯ menu.',
        pending: null,
        mutated: false,
      };
    }
    if (/^(hi|hello|hey|yo)\b/.test(s)) {
      return {
        html: 'Hello. Ask me what is blocked, what is due, who is busiest, or say “add task …” and I will draft it.',
        pending: null,
        mutated: false,
      };
    }
    void total;
    return {
      html: 'I can help with progress, blocked tasks, what is due, who is busiest, unowned tasks, plus creating and reassigning work. Try <b>add task Invite 50 beta testers for Meera due friday</b>.',
      pending: null,
      mutated: false,
    };
  }
}

export type { ChatMessage };
