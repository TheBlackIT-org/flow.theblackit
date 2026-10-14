/**
 * BlackIT Flow — render layer.
 *
 * Every function here turns domain state into an HTML string. The same
 * functions run on the server (Astro renders the shell into `dist/`) and in
 * the browser (client updates replace the shell in place), which is what
 * guarantees the static build and the live app can never visually drift.
 *
 * Untrusted text always passes through `esc()` before it reaches `innerHTML`.
 */

import {
  CHAT_CHIPS,
  GLYPH_BRAND,
  GLYPH_CHAIN,
  ICON,
  PRIO,
  STATUS,
} from './constants';
import {
  AFTER_PREFIX,
  after,
  esc,
  keyFrom,
  longDate,
  percentDone,
  prioOf,
  relAgo,
  relDays,
  shortDate,
  statusOf,
  type FlowDomain,
} from './domain';
import type { PresencePeer } from './repository/types';
import type { AuthUser, ChatMessage, ParsedTask, Task } from './types';

export interface ChatState {
  open: boolean;
  msg: ChatMessage[];
}

/** Element ids and hooks the adapter binds to. Kept in one place on purpose. */
export const HOOKS = {
  ctrls: '#ctrls',
  menu: '#wsmenu',
  sub: '#sub',
  chain: '#chain',
  dropmark: '#dropmark',
  welcome: '#welcome',
  modal: '#modal',
  scrim: '#scrim',
  fab: '#fab',
  chat: '#chat',
  toast: '#toast',
  headProgress: '#hp',
  live: '#live',
  activity: '#activity',
  setupBanner: '#setup-banner',
} as const;

/* ------------------------------- fragments ------------------------------ */

export function avatar(domain: FlowDomain, id: string | null, big = false): string {
  const m = domain.member(id);
  if (!m) return '';
  const bg = m.agent ? '#6d28d9' : domain.colorFor(id);
  const initials = m.name
    .split(' ')
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('');
  return `<span class="av${m.agent ? ' agent' : ''}" style="background:${bg}${
    big ? ';width:28px;height:28px;font-size:11px' : ''
  }" title="${esc(m.name)}">${esc(initials)}</span>`;
}

function statusIcon(status: string): string {
  if (status === 'DONE') return ICON.check;
  if (status === 'PROG') return ICON.play;
  if (status === 'REVIEW') return ICON.eye;
  if (status === 'BLOCK') return ICON.pause;
  return '';
}

/**
 * The face of a signed-in account, which is not a workspace member yet.
 *
 * `avatar()` reads a member out of the domain, so it has nothing to draw for
 * somebody signing in for the first time — before they are a member at all.
 */
export function accountAvatar(account: AuthUser, big = false): string {
  const initials = account.name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .slice(0, 2)
    .join('');
  return `<span class="av" style="background:#5b9bff${
    big ? ';width:28px;height:28px;font-size:11px' : ''
  }" title="${esc(account.email ?? account.name)}">${esc(initials)}</span>`;
}

/**
 * The ⋯ menu. Deliberately small: create work, manage people, wipe everything
 * back to a blank workspace, or take the data out. The demo workspace is only
 * offered on the first-run welcome screen.
 */
export function projectMenu(account?: AuthUser | null): string {
  return (
    '<div class="pop ws" data-pop="ws">' +
    '<div class="lbl">Project</div>' +
    '<button class="mi" data-act="new-project">New project</button>' +
    '<button class="mi" data-act="ws-task">Add a task</button>' +
    '<button class="mi" data-act="team">Manage team</button>' +
    '<div class="sep"></div>' +
    '<button class="mi" data-act="ws-export">Export data as JSON</button>' +
    '<button class="mi" data-act="ws-help">Ask the assistant</button>' +
    (account
      ? '<div class="sep"></div>' +
        `<div class="lbl">${esc(account.name)}${account.email ? ` · ${esc(account.email)}` : ''}</div>` +
        '<button class="mi" data-act="auth-signout">Sign out</button>'
      : '') +
    '<div class="sep"></div>' +
    '<button class="mi danger" data-act="ws-fresh">Reset everything</button>' +
    '</div>'
  );
}

/** Header control cluster: project picker, acting-as picker, workspace menu. */
/** The ⋯ button and its popover. Rendered into its own header slot so the
 *  controls column can be sized independently of it. */
export function renderMenuButton(account?: AuthUser | null): string {
  return (
    '<button class="btn sm" data-act="wsmenu" aria-label="Project menu" aria-haspopup="menu">' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' +
    `</button>${projectMenu(account)}`
  );
}

/**
 * The header controls.
 *
 * With a signed-in account the *Acting as* picker is gone: it let anyone
 * become anyone, which makes every owner, claim time and audit entry a
 * statement about a dropdown rather than a person. Without a backend there is
 * no account, and the picker is the only way to be somebody.
 */
export function renderControls(domain: FlowDomain, account?: AuthUser | null): string {
  const P = domain.currentProject;
  const db = domain.workspace;
  return (
    (P
      ? '<div class="fld"><span>Project</span><select data-act="project">' +
        db.projects
          .map(
            (p) =>
              `<option value="${esc(p.id)}" ${p.id === db.projectId ? 'selected' : ''}>${esc(p.name)}</option>`,
          )
          .join('') +
        '</select></div>'
      : '<div class="fld"><span>Project</span><select disabled><option>No project yet</option></select></div>') +
    (account
      ? '<div class="fld"><span>Signed in</span><div class="mchip">' +
        accountAvatar(account) +
        `<b>${esc(account.name)}</b></div></div>`
      : '<div class="fld"><span>Acting as</span><select data-act="me">' +
        (db.members.length
          ? db.members
              .map((m) => `<option value="${esc(m.id)}" ${m.id === db.me ? 'selected' : ''}>${esc(m.name)}</option>`)
              .join('')
          : '<option>Nobody yet</option>') +
        '</select></div>') +
    '<button class="btn sm" data-act="new-project">+ Project</button>' +
    `<button class="btn sm" data-act="team">Team${db.members.length ? ` (${db.members.length})` : ''}</button>`
  );
}

/** Progress bar + legend + member/status filters. */
export function renderSubBar(domain: FlowDomain): string {
  const P = domain.currentProject;
  const all = domain.projectTasks();
  const { counts: c, total: rawTotal, pct } = domain.progress();
  const total = rawTotal || 1;
  const segs = STATUS.filter((s) => c[s.id] > 0)
    .map((s) => `<i style="width:${(c[s.id] / total) * 100}%;background:${s.color}"></i>`)
    .join('');
  return (
    '<div class="progbox">' +
    `<div class="progtop"><div class="pct">${pct}%<small> done</small></div>` +
    `<div class="pct" style="font-size:13px;font-weight:400;color:var(--muted)">${c.DONE} of ${all.length} tasks${
      P ? ` · ${esc(P.name)}` : ''
    }</div></div>` +
    `<div class="bar">${segs}</div>` +
    '<div class="legend">' +
    STATUS.map((s) => `<span><i class="dot" style="background:${s.color}"></i>${s.label} ${c[s.id]}</span>`).join('') +
    '</div>' +
    '<div class="hint">Click a node to cycle its status. Drag the ⠿ grip to reorder the chain, or press + to add a task below. Order never blocks work: any task can be done first.</div>' +
    '</div>' +
    (P
      ? '<div class="filters">' +
        '<div class="fld"><span>Member</span><select data-act="fmember">' +
        `<option value="all"${domain.workspace.fMember === 'all' ? ' selected' : ''}>Everyone</option>` +
        domain.workspace.members
          .map(
            (m) =>
              `<option value="${esc(m.id)}"${domain.workspace.fMember === m.id ? ' selected' : ''}>${esc(m.name)}</option>`,
          )
          .join('') +
        `<option value="none"${domain.workspace.fMember === 'none' ? ' selected' : ''}>Not taken</option></select></div>` +
        '<div class="fld"><span>Status</span><div class="chips">' +
        `<button class="chip ${domain.workspace.fStatus === 'all' ? 'on' : ''}" data-act="fstatus" data-val="all">All</button>` +
        STATUS.map(
          (s) =>
            `<button class="chip ${domain.workspace.fStatus === s.id ? 'on' : ''}" data-act="fstatus" data-val="${esc(s.id)}"><i class="dot" style="background:${s.color}"></i>${s.label}</button>`,
        ).join('') +
        '</div></div></div>'
      : '<div class="hint" style="max-width:260px">Create a project to unlock the filters.</div>')
  );
}

/** The compact progress bar that slides into the sticky header on scroll. */
export function renderHeadProgress(domain: FlowDomain, scrolled = false): string {
  const all = domain.projectTasks();
  const { counts: c, total: rawTotal, pct } = domain.progress();
  const total = rawTotal || 1;
  const segs = STATUS.filter((s) => c[s.id] > 0)
    .map((s) => {
      const width = (c[s.id] / total) * 100;
      return `<i data-w="${width}" style="width:${scrolled ? width : 0}%;background:${s.color}"></i>`;
    })
    .join('');
  return (
    `<span class="hppct" id="hpPct">${pct}%</span>` +
    `<span class="hpbar" aria-hidden="true">${segs}</span>` +
    `<span class="hplbl">${c.DONE}/${all.length} done</span>`
  );
}

/* --------------------------------- cards -------------------------------- */

export function popMenu(t: Task): string {
  return (
    `<div class="pop" data-pop="${esc(t.id)}">` +
    '<div class="lbl">Change status</div><div class="st">' +
    STATUS.map(
      (s) =>
        `<button class="stbtn ${s.id === t.status ? 'on' : ''}" style="${
          s.id === t.status ? `color:${s.color}` : ''
        }" data-act="st" data-id="${esc(t.id)}" data-val="${esc(s.id)}">` +
        `<i class="dot" style="background:${s.color}"></i>${s.label}</button>`,
    ).join('') +
    '</div>' +
    '<div class="sep"></div>' +
    `<button class="mi" data-act="edit" data-id="${esc(t.id)}">Edit task</button>` +
    `<button class="mi" data-act="reassign" data-id="${esc(t.id)}">Reassign owner</button>` +
    (t.assigneeId ? `<button class="mi" data-act="unassign" data-id="${esc(t.id)}">Return to open pool</button>` : '') +
    '<div class="sep"></div>' +
    `<button class="mi danger" data-act="delete" data-id="${esc(t.id)}">Delete task</button>` +
    '</div>'
  );
}

export function taskRow(domain: FlowDomain, t: Task, next: Task | null): string {
  const now = Date.now();
  const st = statusOf(t.status);
  const m = domain.member(t.assigneeId);
  const ty = domain.typeName(t.typeId);
  const prio = prioOf(t.priority);
  const doneSubs = t.subs.filter((s) => s.done).length;
  const deps = t.dependsOn
    .map((d) => domain.findTask(d))
    .filter((x): x is Task => Boolean(x));
  const waiting = deps.filter((d) => d.status !== 'DONE');
  const late = Boolean(t.dueAt && t.dueAt < now && t.status !== 'DONE');
  const soon = Boolean(t.dueAt && !late && t.dueAt - now < 3 * 86_400_000 && t.status !== 'DONE');
  const label = t.status === 'DONE' && t.completedAt ? shortDate(t.completedAt) : t.dueAt ? shortDate(t.dueAt) : shortDate(t.createdAt);
  const sub =
    t.status === 'DONE' && t.completedAt
      ? `done ${relAgo(t.completedAt)}`
      : t.dueAt
        ? relDays(t.dueAt)
        : `created ${relAgo(t.createdAt)}`;
  const nextCls = statusOf(t.status).line;

  return (
    `<article class="row${t.id === domain.workspace.enter ? ' enter' : ''}" data-task="${esc(t.id)}">` +
    `<div class="date"><div class="d1">${label}</div><div class="d2 ${
      t.status === 'DONE' ? 'done' : late ? 'late' : ''
    }">${sub}</div></div>` +
    '<div class="rail">' +
    `<button class="node ${st.cls}" data-act="cycle" data-id="${esc(t.id)}" title="${esc(st.label)} · click to change status">` +
    statusIcon(t.status) +
    '</button>' +
    (next ? `<div class="seg ${nextCls}${t.id === domain.workspace.enter ? ' grow' : ''}"></div>` : '') +
    `<button class="plus" data-act="insert" data-anchor="${esc(after(t.id))}" title="Add a task below this one">+</button>` +
    '</div>' +
    `<div class="card ${st.cls}">` +
    `<button class="kebab" data-act="menu" data-id="${esc(t.id)}" aria-label="Task menu">` +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg></button>' +
    popMenu(t) +
    '<div class="chead"><button class="grip" data-grip="1" title="Drag to reorder" aria-label="Drag to reorder this task">' +
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg></button>' +
    `<span class="key">${esc(t.key)}</span>` +
    `<span class="tchip">${esc(ty)}</span><span class="tchip">${esc(t.stage)}</span>` +
    `<span class="tchip" style="color:${prio.color};border-color:color-mix(in srgb,${prio.color} 40%,transparent)">${prio.label}</span></div>` +
    `<h3>${esc(t.title)}</h3>` +
    (t.description ? `<div class="desc">${esc(t.description)}</div>` : '') +
    (waiting.length
      ? `<div class="deps${t.status === 'BLOCK' ? ' bad' : ''}">` +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>' +
        `Waiting on ${waiting.map((d) => esc(d.key)).join(', ')} · optional, not enforced</div>`
      : '') +
    '<div class="meta">' +
    (m
      ? `<span class="who">${avatar(domain, t.assigneeId)}${esc(m.name)}${m.agent ? ' <span class="tchip">AI</span>' : ''}</span>` +
        (t.claimedAt
          ? `<span class="taken">took it ${relAgo(t.claimedAt)}</span>`
          : '<span class="taken">assigned</span>')
      : '<span class="who" style="color:var(--muted)">No owner yet</span>') +
    `<span class="mchip ${late ? 'late' : soon ? 'soon' : ''}">` +
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 11h18"/></svg>' +
    (t.dueAt ? `${late ? 'Overdue · ' : 'Due '}${longDate(t.dueAt)}` : 'No due date') +
    '</span>' +
    `<span class="inline-date">${label} · ${sub}</span>` +
    '</div>' +
    `<button class="subtoggle${t.open ? ' on' : ''}" data-act="subs" data-id="${esc(t.id)}">` +
    `<span class="chev">▼</span> ${t.subs.length ? `${doneSubs}/${t.subs.length} subtasks` : 'Subtasks'}` +
    (t.subs.length ? `<span class="sbar"><i style="width:${(doneSubs / t.subs.length) * 100}%"></i></span>` : '') +
    '</button>' +
    `<div class="subs${t.open ? ' on' : ''}">` +
    (t.subs.length
      ? t.subs
          .map(
            (s, ix) =>
              `<div class="srow${s.done ? ' on' : ''}">` +
              `<button class="sbox${s.done ? ' on' : ''}" data-act="sub" data-id="${esc(t.id)}" data-idx="${esc(ix)}">${
                s.done ? ICON.check : ''
              }</button>` +
              `<span>${esc(s.t)}</span>` +
              `<button class="sdel" data-act="sub-del" data-id="${esc(t.id)}" data-idx="${esc(ix)}" title="Delete this subtask">✕</button></div>`,
          )
          .join('')
      : '<div class="subempty">No subtasks yet. Anyone can add one.</div>') +
    `<div class="subadd"><input type="text" data-subinput="${esc(t.id)}" placeholder="Add a subtask and press Enter" />` +
    `<button data-act="sub-add" data-id="${esc(t.id)}">Add</button></div>` +
    '</div>' +
    '<div class="acts">' +
    (!m ? `<button class="take" data-act="claim" data-id="${esc(t.id)}">Take this task</button>` : '') +
    (t.status === 'DONE'
      ? '<span class="mchip" style="color:var(--green);border-color:rgba(53,208,127,.35)">Completed</span>'
      : '') +
    '</div>' +
    '</div>' +
    '</article>'
  );
}

export function composerRow(domain: FlowDomain, index: number): string {
  return (
    '<article class="row" data-composer="1">' +
    `<div class="date"><div class="d1">New</div><div class="d2">position ${index + 1}</div></div>` +
    '<div class="rail"><div class="node ghost">' +
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div></div>' +
    '<div class="composer">' +
    '<input class="title" type="text" id="newTitle" placeholder="What is the next task in this chain?" />' +
    '<div class="fgrid">' +
    `<div class="fld"><span>Type</span><select id="newType" data-role="type">${domain.workspace.types
      .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`)
      .join('')}<option value="__custom">Other…</option></select>` +
    '<input type="text" id="newTypeCustom" class="typefree" placeholder="Type your own" hidden />' +
    '</div>' +
    '<div class="fld"><span>Owner</span><select id="newOwner">' +
    '<option value="">Not taken · open pool</option>' +
    domain.workspace.members
      .map(
        (x) =>
          `<option value="${esc(x.id)}" ${x.id === domain.workspace.me ? 'selected' : ''}>${esc(x.name)}</option>`,
      )
      .join('') +
    '</select></div>' +
    '<div class="fld"><span>Due date</span><input type="date" id="newDue" /></div>' +
    `<div class="fld"><span>Priority</span><select id="newPrio">${PRIO.map(
      (p) => `<option value="${esc(p.id)}"${p.id === 'normal' ? ' selected' : ''}>${p.label}</option>`,
    ).join('')}</select></div>` +
    '<div class="fld" style="grid-column:span 2"><span>Short description</span><input type="text" id="newDesc" placeholder="Optional" /></div>' +
    '</div>' +
    `<div class="acts"><button class="btn primary" data-act="create" data-idx="${index}">Add task</button>` +
    '<button class="btn ghost" data-act="cancel-compose">Cancel</button>' +
    '<span class="taken" style="border:0;padding:0">Leave the owner empty and the card offers “Take this task”.</span></div>' +
    '</div>' +
    '</article>'
  );
}

/** The task id a composer anchor points at, ignoring the "insert below" flag. */
function anchorTarget(anchor: string | null): string | null {
  if (!anchor) return null;
  return anchor.startsWith(AFTER_PREFIX) ? anchor.slice(AFTER_PREFIX.length) : anchor;
}

/** The whole chain: task rows, an optional inline composer, and the add row. */
export function renderChain(domain: FlowDomain): string {
  const P = domain.currentProject;
  if (!P) {
    return (
      `<div class="emptychain">${GLYPH_CHAIN}` +
      '<div class="et">No projects yet</div>' +
      '<div class="ed">A project is one chain of tasks. Create your first one and the chain starts growing down the page.</div>' +
      '<button class="btn primary" data-act="new-project">Create a project</button></div>'
    );
  }
  const all = domain.projectTasks();
  const list = domain.visibleTasks();
  const out: string[] = [];
  const { composer, composerAnchor } = domain.workspace;
  const belowId = anchorTarget(composerAnchor);
  list.forEach((t, i) => {
    // An "insert below" composer sits under its anchor, so the anchor row is
    // emitted first.
    if (composer !== null && composerAnchor === t.id) out.push(composerRow(domain, i));
    out.push(taskRow(domain, t, list[i + 1] ?? null));
    if (composer !== null && belowId === t.id) out.push(composerRow(domain, i + 1));
  });
  if (composer !== null && !composerAnchor) out.push(composerRow(domain, list.length));
  if (!out.length) {
    return all.length
      ? '<div class="empty">Nothing matches these filters. <button class="btn sm" data-act="clear-filters">Clear filters</button></div>'
      : `<div class="emptychain">${GLYPH_CHAIN}` +
          `<div class="et">${esc(P.name)} has no tasks yet</div>` +
          '<div class="ed">Add the first task and the chain starts here. Leave the owner empty and any teammate can take it later.</div>' +
          '<button class="btn primary" data-act="compose-end">Add the first task</button></div>';
  }
  if (!(composer !== null && !composerAnchor)) {
    out.push(
      '<div class="addend"><button class="addbtn" data-act="compose-end">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' +
        'Add task at the end of the chain</button></div>',
    );
  }
  return out.join('');
}

/* ------------------------------- welcome -------------------------------- */

/** First-run screen: start fresh or explore the demo. */
export function renderWelcome(domain: FlowDomain): string {
  if (domain.workspace.setup) return '';
  return (
    '<div class="wcard">' +
    `<div class="wlogo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="4" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="20" r="2.4"/><path d="M12 6.4v3.2M12 14.4v3.2"/></svg></div>` +
    '<h2>BlackIT Flow</h2>' +
    '<div class="wsub">One vertical chain per project. Every task carries its own status, nothing is forced into order, and anyone can claim work that has no owner.</div>' +
    '<div class="wopts">' +
    '<button class="wopt primary" data-act="welcome-fresh"><div class="wt">Start fresh</div><div class="wd">Tell me your name, create your first project and add your team. Takes about a minute.</div></button>' +
    '<button class="wopt" data-act="welcome-demo"><div class="wt">Explore the demo</div><div class="wd">Open the sample workspace: 4 projects, 6 members and 30+ tasks with subtasks, owners and dependencies.</div></button>' +
    '</div>' +
    '<div class="wfoot">Your team shares one workspace. The demo below stays in this browser so you can try things safely.</div>' +
    '</div>'
  );
}

/* --------------------------------- sign-in ------------------------------- */

/**
 * Which card the sign-in overlay is showing.
 *
 * `signin` and `sent` are the unauthenticated half; `not-invited` and `error`
 * are shown to somebody who *is* authenticated but cannot use the workspace
 * yet — a different problem, and a different sentence to fix it. `claim` is the
 * one-time bootstrap for a workspace whose member rows predate sign-in and
 * therefore carry no email to invite anybody by.
 */
export type AuthStep = 'signin' | 'sent' | 'not-invited' | 'error' | 'claim';

/** A member row offered by the one-time bootstrap picker. */
export interface ClaimableMember {
  id: string;
  name: string;
  title: string;
}

export interface AuthScreenState {
  step: AuthStep;
  /** The address typed, or the one a code was sent to. */
  email: string;
  /** One line under the headline: an error, or what to do next. */
  message: string;
  /** The signed-in account, once there is one. */
  account: AuthUser | null;
  /** Only for `claim`: the names nobody has claimed yet. */
  claimable?: ClaimableMember[];
}

const GITHUB_MARK =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.93.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.03a9.4 9.4 0 0 1 5 0c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.35 4.7-4.58 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>';

/**
 * The sign-in overlay.
 *
 * Rendered into the same fixed overlay the first-run welcome uses, so it is
 * impossible for both to be on screen at once and there is one place that
 * decides whether the board is visible.
 */
export function renderAuthScreen(state: AuthScreenState): string {
  const logo =
    '<div class="wlogo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="4" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="20" r="2.4"/><path d="M12 6.4v3.2M12 14.4v3.2"/></svg></div>';
  const message = state.message ? `<div class="authmsg">${esc(state.message)}</div>` : '';
  const who = state.account?.email ?? state.account?.name ?? 'this account';

  if (state.step === 'not-invited') {
    return (
      '<div class="wcard">' +
      logo +
      '<h2>Not on this workspace yet</h2>' +
      '<div class="wsub">You are signed in as <b>' +
      esc(who) +
      '</b>, but no member here is connected to that account. Ask an owner to add you under <b>Team</b> with this address — then check again.</div>' +
      message +
      '<div class="authacts">' +
      '<button class="btn primary" data-act="auth-retry">Check again</button>' +
      '<button class="btn ghost" data-act="auth-signout">Sign out</button>' +
      '</div>' +
      '</div>'
    );
  }

  if (state.step === 'claim') {
    const options = (state.claimable ?? [])
      .map(
        (m) =>
          `<button class="claimrow" data-act="auth-claim" data-id="${esc(m.id)}">` +
          `<span class="claimname">${esc(m.name)}</span>` +
          `<span class="claimtitle">${esc(m.title)}</span>` +
          '</button>',
      )
      .join('');
    // No names left to offer (the last one was taken while this was on screen):
    // fall back to the invitation wording rather than an empty card.
    if (!options) {
      return renderAuthScreen({ ...state, step: 'not-invited', claimable: [] });
    }
    return (
      '<div class="wcard">' +
      logo +
      '<h2>Which one of these are you?</h2>' +
      '<div class="wsub">You are signed in as <b>' +
      esc(who) +
      '</b>. This workspace was set up before sign-in existed, so nobody here is connected to an account yet. Pick your name once and it becomes yours — after that, joining is by invitation.</div>' +
      message +
      '<div class="claimlist">' +
      options +
      '</div>' +
      '<div class="authacts">' +
      '<button class="btn ghost" data-act="auth-signout">None of these · sign out</button>' +
      '</div>' +
      '</div>'
    );
  }

  if (state.step === 'error') {
    return (
      '<div class="wcard">' +
      logo +
      '<h2>Could not open the workspace</h2>' +
      '<div class="wsub">You are signed in, but the shared workspace could not be read. This is usually a database that still needs its migrations, or a connection problem.</div>' +
      message +
      '<div class="authacts">' +
      '<button class="btn primary" data-act="auth-retry">Try again</button>' +
      '<button class="btn ghost" data-act="auth-signout">Sign out</button>' +
      '</div>' +
      '</div>'
    );
  }

  if (state.step === 'sent') {
    return (
      '<div class="wcard">' +
      logo +
      '<h2>Check your email</h2>' +
      '<div class="wsub">A sign-in link is on its way to <b>' +
      esc(state.email) +
      '</b>. Open it, or type the code from the same email below. It expires in an hour.</div>' +
      message +
      '<div class="f"><label>Code from the email</label><input type="text" id="authCode" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" /></div>' +
      '<div class="authacts">' +
      '<button class="btn primary" data-act="auth-code">Sign in</button>' +
      '<button class="btn ghost" data-act="auth-other">Use a different email</button>' +
      '</div>' +
      '<div class="wfoot">Nothing here has a password to remember, reset, or leak.</div>' +
      '</div>'
    );
  }

  return (
    '<div class="wcard">' +
    logo +
    '<h2>Sign in to BlackIT Flow</h2>' +
    '<div class="wsub">Your team shares one workspace. Signing in is what makes an owner an owner: assignments, take-times and the activity trail point at a person instead of a dropdown.</div>' +
    message +
    '<div class="wopts authone">' +
    '<button class="wopt primary" data-act="auth-github"><div class="wt">' +
    GITHUB_MARK +
    ' Continue with GitHub</div><div class="wd">No password. Uses the GitHub account your team already knows you by.</div></button>' +
    '</div>' +
    '<div class="authdiv"><span>or use an email link</span></div>' +
    '<div class="f"><label>Work email</label><input type="email" id="authEmail" value="' +
    esc(state.email) +
    '" placeholder="you@theblackit.com" autocomplete="email" /></div>' +
    '<div class="authacts"><button class="btn primary" data-act="auth-email">Email me a sign-in link</button></div>' +
    '<div class="wfoot">Sign-in is invitation based: an owner adds your email under Team first. Anyone outside the workspace sees an empty page.</div>' +
    '</div>'
  );
}

/* --------------------------------- modal -------------------------------- */

export function modalShell(title: string, body: string, footer: string): string {
  return `<div class="mh">${esc(title)}</div><div class="mb">${body}</div><div class="mf">${footer}</div>`;
}

export const MODAL_FOOTER_DEFAULT = '<button class="btn ghost" data-act="close-modal">Cancel</button>';

export function modalFooterSubmit(label: string): string {
  return `${MODAL_FOOTER_DEFAULT}<button class="btn primary" data-act="submit-modal">${esc(label)}</button>`;
}

export function editTaskBody(domain: FlowDomain, t: Task): string {
  return (
    `<div class="f"><label>Title</label><input type="text" name="title" value="${esc(t.title)}" /></div>` +
    `<div class="f"><label>Short description</label><textarea name="description" rows="3">${esc(t.description)}</textarea></div>` +
    `<div class="f"><label>Stage label</label><input type="text" name="stage" value="${esc(t.stage)}" /></div>` +
    `<div class="f"><label>Type</label><select name="typeId" data-role="type">${domain.workspace.types
      .map((x) => `<option value="${esc(x.id)}" ${x.id === t.typeId ? 'selected' : ''}>${esc(x.name)}</option>`)
      .join('')}<option value="__custom"${
      domain.workspace.types.some((x) => x.id === t.typeId) ? '' : ' selected'
    }>Other…</option></select>` +
    `<input type="text" name="typeFree" class="typefree" placeholder="Type your own" ${
      domain.workspace.types.some((x) => x.id === t.typeId) ? 'hidden' : `value="${esc(t.typeId)}"`
    } /></div>` +
    `<div class="f"><label>Priority</label><select name="priority">${PRIO.map(
      (p) => `<option value="${esc(p.id)}" ${p.id === t.priority ? 'selected' : ''}>${p.label}</option>`,
    ).join('')}</select></div>` +
    `<div class="f"><label>Due date</label><input type="date" name="due" value="${
      t.dueAt ? new Date(t.dueAt).toISOString().slice(0, 10) : ''
    }" /></div>` +
    '<div class="f"><label>Subtasks · one per line</label><textarea name="subs" rows="4" placeholder="Design the empty state">' +
    `${t.subs.map((s) => esc(s.t)).join('\n')}</textarea></div>`
  );
}

export function reassignBody(domain: FlowDomain, t: Task): string {
  return (
    '<div class="f"><label>Owner</label><select name="owner"><option value="">Not taken · open pool</option>' +
    domain.workspace.members
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${m.id === t.assigneeId ? 'selected' : ''}>${esc(m.name)} · ${esc(m.title)}</option>`,
      )
      .join('') +
    '</select></div>' +
    '<div class="hint" style="margin:0">Assigning sets the owner and the take time. Status changes separately, so order is never forced.</div>'
  );
}

export function projectBody(domain: FlowDomain): string {
  const products = [...new Set(domain.workspace.projects.map((p) => p.product).filter(Boolean))];
  return (
    '<div class="f"><label>Project name</label><input type="text" name="name" placeholder="e.g. Website redesign" /></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
    '<div class="f"><label>Key</label><input type="text" name="key" maxlength="5" placeholder="WEB" /></div>' +
    '<div class="f"><label>Product · optional</label><input type="text" name="product" list="prods" placeholder="optional" />' +
    `<datalist id="prods">${products.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist></div>` +
    '</div>' +
    '<div class="wznote">The key prefixes every task ID in this project, like WEB-1, WEB-2. Leave it empty and I will pick one.</div>'
  );
}

export function teamBody(domain: FlowDomain): string {
  const rows = domain.workspace.members
    .map((m) => {
      const meta = [m.title || m.role, m.email].filter(Boolean).join(' · ');
      return (
        '<div class="mrow">' +
        avatar(domain, m.id) +
        `<div class="mname"><div>${esc(m.name)}${
          m.userId ? ' <span class="mchip">signed in</span>' : m.email ? ' <span class="mchip">invited</span>' : ''
        }</div><div>${esc(meta)}</div></div>` +
        `<select data-act="mrole" data-id="${esc(m.id)}">${['owner', 'lead', 'member']
          .map((r) => `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r}</option>`)
          .join('')}</select>` +
        `<button class="btn ghost sm" data-act="del-member" data-id="${esc(m.id)}" title="Remove from workspace">✕</button></div>`
      );
    })
    .join('');
  return (
    `<div>${rows || '<div class="subempty">Nobody here yet. Add yourself first.</div>'}</div>` +
    '<div class="sep" style="margin:14px 0"></div>' +
    '<div class="f"><label>Add a teammate</label><input type="text" id="mNew" placeholder="Name" /></div>' +
    '<div class="f"><label>Their email · optional</label><input type="email" id="mEmail" placeholder="them@theblackit.com" /></div>' +
    '<div class="f"><label>Title · optional</label><input type="text" id="mTitle" placeholder="e.g. Frontend engineer" /></div>' +
    '<div class="wznote">Add their email and it becomes their invite: the first time they sign in with that address they become this member, with their own name on everything they take. Roles are labels: owner, lead, member.</div>'
  );
}

export const TEAM_FOOTER =
  '<button class="btn ghost" data-act="close-modal">Close</button><button class="btn primary" data-act="add-member">Add member</button>';

/* -------------------------------- wizard -------------------------------- */

/** Draft state for the three-step first-run wizard. */
export interface WizardState {
  step: number;
  name: string;
  title: string;
  project: string;
  product: string;
  team: string;
}

export const WIZARD_BACK_HOME =
  '<button class="btn ghost" data-act="welcome-home">Back</button><button class="btn primary" data-act="wz-next">Continue</button>';
export const WIZARD_BACK =
  '<button class="btn ghost" data-act="wz-back">Back</button><button class="btn primary" data-act="wz-next">Continue</button>';
export const WIZARD_FINISH =
  '<button class="btn ghost" data-act="wz-skip">Skip for now</button><button class="btn primary" data-act="wz-done">Finish setup</button>';

export function stepDots(step: number): string {
  return `<div class="wzdots">${[1, 2, 3].map((i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div>`;
}

export function wizardBody(wz: WizardState, signedIn = false): string {
  const key = keyFrom(wz.project);
  if (wz.step === 1) {
    return (
      stepDots(wz.step) +
      `<div class="f"><label>Your name</label><input type="text" id="wzName" value="${esc(wz.name)}" placeholder="e.g. Arjun Menon" /></div>` +
      `<div class="f"><label>Your title · optional</label><input type="text" id="wzTitle" value="${esc(wz.title)}" placeholder="e.g. Founder · Product" /></div>` +
      '<div class="wznote">You join as the workspace owner, so workflow and team settings are yours.</div>'
    );
  }
  if (wz.step === 2) {
    return (
      stepDots(wz.step) +
      `<div class="f"><label>Project name</label><input type="text" id="wzProject" value="${esc(wz.project)}" placeholder="e.g. Mobile app v1" /></div>` +
      `<div class="f"><label>Product or brand · optional</label><input type="text" id="wzProduct" value="${esc(wz.product)}" placeholder="e.g. TheBlackIT" /></div>` +
      `<div class="wznote">Task IDs will read <b id="wzKeyPrev">${esc(key)}-1</b> and <b id="wzKeyPrev2">${esc(key)}-2</b>. A project is one chain, and you can add more projects any time.</div>`
    );
  }
  return (
    stepDots(wz.step) +
    `<div class="f"><label>${
      signedIn ? 'Teammates · name and email, one per line' : 'Teammates, one name per line · optional'
    }</label><textarea id="wzTeam" rows="4" placeholder="${
      signedIn ? 'Nithin Raj &lt;nithin@theblackit.com&gt;&#10;Sneha Thomas' : 'Nithin Raj&#10;Sneha Thomas'
    }">${esc(wz.team)}</textarea></div>` +
    (signedIn
      ? '<div class="wznote">An email is an invitation: the first time that person signs in with it, they become this member and their name goes on everything they take. Add or change people later from the Team button.</div>'
      : '<div class="wznote">They show up in “Acting as” and can take unowned tasks. Add or remove people later from the Team button.</div>')
  );
}

export function wizardFooter(step: number): string {
  if (step === 1) return WIZARD_BACK_HOME;
  if (step === 2) return WIZARD_BACK;
  return WIZARD_FINISH;
}

/* ------------------------------- assistant ------------------------------ */

export function previewHtml(p: ParsedTask, projectName: string): string {
  return (
    '<div class="preview"><div class="pt">' +
    esc(p.title) +
    '</div><div class="pm">' +
    `<span>${esc(projectName)}</span>` +
    `<span>${p.owner ? esc(p.owner.name) : 'Not taken · open pool'}</span>` +
    `<span>${p.due ? `Due ${shortDate(new Date(`${p.due}T12:00:00`).getTime())}` : 'No due date'}</span>` +
    `<span style="text-transform:capitalize">${p.prio} priority</span></div>` +
    '<div class="pa"><button class="btn primary" data-act="chat-add">Add to the chain</button>' +
    '<button class="btn ghost" data-act="chat-discard">Discard</button></div></div>'
  );
}

export function fabIcon(open: boolean): string {
  return open
    ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
    : '<svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8.5 8.5 0 0 1-8.5 8.5H8.5L3.5 23l1.6-5.2A8.5 8.5 0 1 1 21 12z"/></svg>';
}

export function renderChat(domain: FlowDomain, chat: ChatState): string {
  if (!chat.open) return '';
  const P = domain.currentProject;
  return (
    '<div class="chh"><div>' +
    '<div class="t">Flow assistant</div>' +
    `<div class="s2">${esc(P ? P.name : 'No project yet')} · ${domain.projectTasks().length} tasks</div>` +
    '</div><button class="btn ghost" style="margin-left:auto" data-act="chat-close">✕</button></div>' +
    `<div class="msgs" id="msgs">${chat.msg.map((m) => `<div class="msg ${m.who}">${m.html}</div>`).join('')}</div>` +
    `<div class="qc">${CHAT_CHIPS.map((x) => `<button class="chipsm" data-act="chat-chip">${esc(x)}</button>`).join('')}</div>` +
    '<div class="cinput"><input id="chatIn" placeholder="Ask something, or describe a task…" autocomplete="off" />' +
    '<button data-act="chat-send" aria-label="Send"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M3 20l18-8L3 4v6l12 2-12 2z"/></svg></button></div>'
  );
}

export function chatGreeting(domain: FlowDomain): ChatMessage {
  const m = domain.me;
  return {
    who: 'bot',
    html: `Hi ${esc(m ? m.name : 'there')}. I can create tasks, reassign them, or tell you what is going on. Try <b>add task Publish the beta invite for Meera due friday</b>.`,
  };
}

/** Fallback progress percentage for tests and embeds. */
export { percentDone, GLYPH_BRAND };

/* ------------------------------ sync + people ----------------------------- */

/** Minimal shape the feed needs; keeps render.ts free of a repository import. */
export interface ActivityRecordLike {
  id: number;
  actorName: string;
  action: string;
  taskKey?: string;
  summary?: string;
  createdAt: number;
}

const SYNC_LABEL: Record<string, string> = {
  offline: 'Local only',
  connecting: 'Connecting',
  live: 'Live',
  error: 'Not saving',
};

/**
 * The header chip: connection state, writes still in flight, and who else has
 * the board open. It doubles as the presence list, so there is one place to
 * look to answer "is my change saved, and who am I sharing with".
 */
export function renderSyncChip(
  status: {
    state: string;
    pending: number;
    error: string | null;
    lastSyncedAt: number | null;
    retryInSeconds?: number | null;
    realtimePaused?: boolean;
  },
  peers: PresencePeer[],
  domain: FlowDomain,
  kind: 'local' | 'supabase',
): string {
  const others = peers.filter((p) => p.memberId !== domain.workspace.me);
  const paused = Boolean((status as { realtimePaused?: boolean }).realtimePaused);
  const label =
    kind === 'local'
      ? 'Local only'
      : paused
        ? 'Updates paused'
        : (SYNC_LABEL[status.state] ?? status.state);
  const tone = paused
    ? 'wait'
    : status.state === 'error'
      ? 'err'
      : status.state === 'live'
        ? 'ok'
        : status.state === 'connecting'
          ? 'wait'
          : 'idle';
  const title =
    kind === 'local'
      ? 'Saved in this browser only — no shared database configured'
      : paused
        ? `${status.error ?? 'Live updates are paused.'} Your changes are being saved.`
        : status.error
        ? `Not saving${status.retryInSeconds ? ` — retrying in ${status.retryInSeconds}s` : ''}: ${status.error}`
        : status.pending
          ? `${status.pending} change${status.pending === 1 ? '' : 's'} saving…`
          : status.lastSyncedAt
            ? `Saved ${relAgo(status.lastSyncedAt)}`
            : 'Waiting for the first save';

  return (
    '<div class="livewrap">' +
    `<button class="livechip ${tone}" data-act="live-menu" title="${esc(title)}" aria-haspopup="dialog">` +
    '<i class="livedot"></i>' +
    `<span>${esc(label)}</span>` +
    (status.pending ? `<span class="livecount" title="Changes not yet saved">${status.pending}</span>` : '') +
    (others.length ? `<span class="livecount people">${others.length}</span>` : '') +
    '</button>' +
    '<div class="pop live" data-pop="live">' +
    '<div class="lbl">Shared with</div>' +
    (peers.length
      ? peers
          .map(
            (p) =>
              '<div class="peer"><i class="dot" style="background:' +
              domain.colorFor(p.memberId) +
              '"></i>' +
              `${esc(p.memberName || 'Someone')}${
                p.memberId === domain.workspace.me ? ' <span class="you">you</span>' : ''
              }</div>`,
          )
          .join('')
      : '<div class="peer muted">Nobody else is looking right now.</div>') +
    '<div class="sep"></div>' +
    `<div class="peer muted">${esc(title)}</div>` +
    '</div>' +
    '</div>'
  );
}

/**
 * Recent actions, newest first. With no sign-in the actor name comes from the
 * *Acting as* choice, so this is a team log rather than a tamper-proof audit.
 */
export function renderActivityFeed(entries: ActivityRecordLike[]): string {
  if (!entries.length) {
    return '<div class="subempty">No activity yet. Changes you and your team make will appear here.</div>';
  }
  return entries
    .map((e) => {
      const verb = ACTIVITY_VERB[e.action] ?? e.action;
      return (
        '<div class="actrow">' +
        `<span class="actwho">${esc(e.actorName || 'Someone')}</span>` +
        `<span class="actwhat">${esc(verb)}</span>` +
        (e.taskKey ? `<span class="key">${esc(e.taskKey)}</span>` : '') +
        (e.summary ? `<span class="actsum">${esc(e.summary)}</span>` : '') +
        `<span class="actwhen">${esc(relAgo(e.createdAt))}</span>` +
        '</div>'
      );
    })
    .join('');
}

const ACTIVITY_VERB: Record<string, string> = {
  'task.created': 'added',
  'task.deleted': 'deleted',
  'task.status': 'moved',
  'task.claimed': 'claimed',
  'task.assigned': 'assigned',
  'task.reordered': 'reordered',
  'subtask.added': 'added a step to',
  'project.created': 'created',
  'member.added': 'joined',
  'member.removed': 'was removed from',
  'workspace.reset': 'reset',
};

/* ------------------------------ setup notice ----------------------------- */

/**
 * Shown when Supabase is reachable but the tables do not exist yet. Without it
 * the app looks like it is failing to save, when the real fix is running
 * `supabase/migrations/0001_init.sql` once.
 */
/**
 * Shown when a write to the shared database fails.
 *
 * The chip carries the same detail in its tooltip, but a tooltip is not
 * discoverable — a failed save has to be visible without hunting for it.
 */
export function renderSyncErrorBanner(error: string, pending: number, retryInSeconds?: number | null): string {
  const waiting = pending
    ? `<b>${pending} change${pending === 1 ? '' : 's'}</b> waiting to be saved. `
    : '';
  const retry = retryInSeconds ? `Retrying in ${retryInSeconds}s. ` : '';
  return (
    '<div class="setuprow">' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M12 8v4.5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>' +
    `<span><b>Not saving to the shared database.</b> ${waiting}${retry}` +
    `Your work is safe in this browser. Reason: <code>${esc(error)}</code></span>` +
    '</div>'
  );
}

export function renderSetupBanner(): string {
  return (
    '<div class="setuprow">' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
    '<path d="M12 9v5M12 17.5v.5"/><circle cx="12" cy="12" r="9"/></svg>' +
    '<span><b>Shared database not set up yet.</b> Your work is saved in this browser, but nothing is shared while the tables are missing. ' +
    'Run <code>supabase/migrations/0001_init.sql</code> in the Supabase SQL Editor, then reload.</span>' +
    '<a class="setuplink" href="https://supabase.com/dashboard/project/vevmaadaniitkboagsrl/sql/new" target="_blank" rel="noreferrer">Open SQL Editor</a>' +
    '</div>'
  );
}
