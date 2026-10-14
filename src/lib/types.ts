/**
 * BlackIT Flow — shared data model.
 *
 * This is the contract between the pure domain layer (`domain.ts`), the DOM
 * adapter (`app.ts` / `actions.ts`) and the Astro components. Everything here
 * is plain, serialisable data: the whole workspace round-trips through
 * `JSON.stringify` into localStorage under `blackit_flow_v1`.
 */

export type StatusId = 'DONE' | 'PROG' | 'REVIEW' | 'BLOCK' | 'TODO';
export type PriorityId = 'low' | 'normal' | 'high' | 'urgent';
export type RoleId = 'owner' | 'lead' | 'member';

export interface StatusDef {
  id: StatusId;
  label: string;
  /** CSS modifier suffix used on `.node`, `.card`, `.seg`. */
  cls: string;
  /** CSS colour token for the legend bar. */
  color: string;
  /** Segment class on the rail connector. */
  line: string;
}

export interface PriorityDef {
  id: PriorityId;
  label: string;
  color: string;
}

export interface Member {
  id: string;
  name: string;
  role: RoleId;
  title: string;
  /** AI agents get the violet avatar and the `AI` chip. */
  agent?: boolean;
  /**
   * The address an invite is addressed to. A teammate can be added before
   * they have ever signed in; the first account to sign in with this email
   * claims the row.
   */
  email?: string | null;
  /**
   * The `auth.users` id behind this member, once the invite has been claimed.
   *
   * Read from the backend but never written by the sync layer: binding is a
   * deliberate one-off claim, and a diff-flush that carried this column would
   * let an ordinary member edit overwrite it.
   */
  userId?: string | null;
}

/**
 * A signed-in account, as the app needs to know it.
 *
 * Deliberately not the provider's user object: the domain and the renderer
 * only ever need a name, an email and a face, and keeping this shape narrow is
 * what lets the sign-in screen be tested without an auth service.
 */
export interface AuthUser {
  id: string;
  email: string | null;
  name: string;
  avatarUrl: string | null;
}

export interface TaskType {
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  /** Prefix for task keys: `NE-1`, `NE-2`, … */
  key: string;
  name: string;
  product: string;
  /**
   * Server-side key sequence. Kept in step when a project is created and when
   * its tasks are seeded, so a freshly bootstrapped project does not start
   * handing out `NE-1` again.
   */
  taskCounter?: number;
}

export interface Subtask {
  /**
   * Stable id so subtasks can sync as individual rows. Older payloads may not
   * have one; `normalise()` backfills it.
   */
  id: string;
  t: string;
  done: boolean;
}

export interface Task {
  id: string;
  projectId: string;
  key: string;
  /**
   * Server-side ordering within the project. Optional because the demo/seed
   * workspace relies on array order alone; the Supabase repository keeps it in
   * step so a drag is a position rewrite rather than a whole-list rewrite.
   */
  position?: number;
  title: string;
  typeId: string;
  stage: string;
  status: StatusId;
  /**
   * Everyone on this task, in display order. An empty list is the open pool.
   *
   * Deliberately not "one owner plus helpers": every assignee is equal, so a
   * task can be shared without anybody being demoted to a watcher.
   */
  assigneeIds: string[];
  priority: PriorityId;
  /** Story points / days — kept for parity with the prototype. */
  estimate: number;
  /** Epoch ms, or null for "no due date". */
  dueAt: number | null;
  /** Advisory only: dependencies are shown, never enforced. */
  dependsOn: string[];
  description: string;
  createdAt: number;
  createdBy: string | null;
  /**
   * Who first pulled this out of the open pool, and when. Historical: it stays
   * true after other people are added, and is what "took it 3d ago" means.
   */
  claimedBy: string | null;
  claimedAt: number | null;
  completedAt: number | null;
  subs: Subtask[];
  /** Subtask list expanded in the UI. */
  open: boolean;
}

/** demo = sample data, fresh = blank, live = backed by the shared database. */
export type WorkspaceMode = 'demo' | 'fresh' | 'live';

export interface Workspace {
  mode: WorkspaceMode;
  /** Backend row id. Null for the browser-local/demo workspace. */
  workspaceId?: string | null;
  /** False while the first-run welcome screen is showing. */
  setup: boolean;
  me: string | null;
  projectId: string | null;
  q: string;
  fMember: string;
  fStatus: string;
  /** Non-null while the inline composer is open. */
  composer: number | null;
  /** Task id to insert before; null means "append to the end". */
  composerAnchor: string | null;
  /** Task id to run the entrance animation on for the next render. */
  enter: string | null;
  members: Member[];
  types: TaskType[];
  projects: Project[];
  tasks: Task[];
}

export interface ChatMessage {
  who: 'bot' | 'user';
  html: string;
}

export interface ParsedTask {
  title: string;
  owner: Member | null;
  prio: PriorityId;
  due: string | null;
  projectId: string | null;
}

export interface ProgressCounts {
  DONE: number;
  PROG: number;
  REVIEW: number;
  BLOCK: number;
  TODO: number;
}
