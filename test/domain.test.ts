/**
 * Domain tests — the rules the prototype encodes: claim ownership, status
 * cycling, the "order never blocks work" contract, and the assistant's
 * task-drafting heuristics. No DOM required.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  FlowDomain,
  counts,
  esc,
  initialWorkspace,
  keyFrom,
  percentDone,
  projectKeyFallback,
  relAgo,
  relDays,
  uid,
} from '../src/lib/domain';
import { seed, emptyWorkspace, normalise } from '../src/lib/domain';
import { STORAGE_KEY } from '../src/lib/constants';

/** Minimal in-memory localStorage stand-in. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const FIXED_NOW = Date.UTC(2026, 9, 10, 12, 0, 0); // 10 Oct 2026

function domain(now = FIXED_NOW) {
  return new FlowDomain(seed(now - 86_400_000), { storage: fakeStorage(), now });
}

describe('seed workspace', () => {
  it('builds the demo workspace with 4 projects, 6 members and 32 tasks', () => {
    const ws = seed(FIXED_NOW);
    expect(ws.projects).toHaveLength(4);
    expect(ws.members).toHaveLength(6);
    expect(ws.tasks).toHaveLength(32);
    expect(ws.mode).toBe('demo');
    expect(ws.setup).toBe(true);
    expect(ws.projectId).toBe('p1');
  });

  it('numbers task keys per project', () => {
    const ws = seed(FIXED_NOW);
    const p1 = ws.tasks.filter((t) => t.projectId === 'p1').map((t) => t.key);
    expect(p1[0]).toBe('NE-1');
    expect(p1[p1.length - 1]).toBe(`NE-${p1.length}`);
    expect(ws.tasks.find((t) => t.id === 't16')?.key).toBe('NLM-1');
  });

  it('includes an AI agent and unowned tasks for the claim flow', () => {
    const d = domain();
    expect(d.member('m7')?.agent).toBe(true);
    expect(d.workspace.tasks.filter((t) => !t.assigneeIds.length).length).toBeGreaterThan(0);
  });
});

describe('storage', () => {
  it('round-trips through localStorage', () => {
    const storage = fakeStorage();
    const d = new FlowDomain(seed(FIXED_NOW), { storage, now: FIXED_NOW });
    d.save();
    const raw = storage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const revived = FlowDomain.hydrate({ storage, now: FIXED_NOW });
    expect(revived.workspace.tasks).toHaveLength(32);
    expect(revived.workspace.projects[0]?.key).toBe('NE');
  });

  it('starts empty when storage holds junk', () => {
    const storage = fakeStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    const d = FlowDomain.hydrate({ storage });
    expect(d.workspace.tasks).toEqual([]);
    expect(d.workspace.setup).toBe(false);
  });

  it('backfills missing fields on legacy payloads', () => {
    const legacy = { ...emptyWorkspace(), setup: true, projects: seed(FIXED_NOW).projects, tasks: seed(FIXED_NOW).tasks };
    delete (legacy as Record<string, unknown>).types;
    const norm = normalise(legacy);
    expect(norm?.types.length).toBe(5);
  });

  it('never throws when there is no storage at all', () => {
    const d = FlowDomain.blank({ storage: null });
    expect(() => d.save()).not.toThrow();
    expect(d.workspace.tasks).toEqual([]);
  });
});

describe('progress', () => {
  it('reports counts and percentage for the current project only', () => {
    const d = domain();
    const { counts: c, total, pct } = d.progress();
    expect(total).toBe(d.projectTasks().length);
    expect(c.DONE + c.PROG + c.REVIEW + c.BLOCK + c.TODO).toBe(total);
    expect(pct).toBe(Math.round((c.DONE / total) * 100));
  });

  it('treats an empty project as 0% rather than NaN', () => {
    expect(percentDone([])).toBe(0);
    expect(counts([])).toEqual({ DONE: 0, PROG: 0, REVIEW: 0, BLOCK: 0, TODO: 0 });
  });
});

describe('filters', () => {
  it('filters by member and by status', () => {
    const d = domain();
    d.workspace.fMember = 'none';
    expect(d.visibleTasks().every((t) => !t.assigneeIds.length)).toBe(true);
    d.workspace.fMember = 'all';
    d.workspace.fStatus = 'BLOCK';
    expect(d.visibleTasks().every((t) => t.status === 'BLOCK')).toBe(true);
    expect(d.visibleTasks().length).toBeGreaterThan(0);
  });
});

describe('status changes', () => {
  it('cycles TODO → PROG → REVIEW → DONE → BLOCK → TODO', () => {
    const d = domain();
    const t = d.findTask('t4')!;
    expect(t.status).toBe('TODO');
    const seen = [t.status];
    for (let i = 0; i < 5; i++) {
      d.cycleStatus(t.id);
      seen.push(d.findTask(t.id)!.status);
    }
    expect(seen).toEqual(['TODO', 'PROG', 'REVIEW', 'DONE', 'BLOCK', 'TODO']);
  });

  it('stamps completedAt only while DONE', () => {
    const d = domain();
    d.setStatus('t4', 'DONE');
    expect(d.findTask('t4')?.completedAt).toBeTypeOf('number');
    d.setStatus('t4', 'PROG');
    expect(d.findTask('t4')?.completedAt).toBeNull();
  });
});

describe('claiming unowned work', () => {
  it('records who took an unowned task and when, and starts it', () => {
    const d = domain();
    const target = d.workspace.tasks.find((t) => !t.assigneeIds.length)!;
    const r = d.claim(target.id);
    expect(r.ok).toBe(true);
    const after = d.findTask(target.id)!;
    expect(after.assigneeIds).toEqual(['m1']);
    expect(after.claimedBy).toBe('m1');
    expect(after.claimedAt).toBeTypeOf('number');
    expect(after.status).toBe('PROG');
  });

  it('joins a task somebody else is already on, without taking their credit', () => {
    const d = domain();
    const before = d.findTask('t1')!;
    const taker = before.claimedBy;
    const r = d.claim('t1');
    // A task can be shared, so "somebody is already on it" is not a refusal —
    // it is the normal joint-assignment case.
    expect(r.ok).toBe(true);
    const after = d.findTask('t1')!;
    expect(after.assigneeIds).toEqual(['m3', 'm1']);
    expect(after.claimedBy).toBe(taker);
    expect(after.claimedAt).toBe(before.claimedAt);
  });

  it('refuses a second time when you are already on the task', () => {
    const d = domain();
    expect(d.claim('t1').ok).toBe(true);
    const again = d.claim('t1');
    expect(again.ok).toBe(false);
    expect(again.message).toContain('Already on');
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m3', 'm1']);
  });

  it('adds a second person without disturbing the first', () => {
    const d = domain();
    const r = d.addAssignee('t1', 'm4');
    expect(r.message).toContain('assigned to');
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m3', 'm4']);
    // Adding the same person twice is a no-op, not a duplicate row.
    d.addAssignee('t1', 'm4');
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m3', 'm4']);
  });

  it('takes one person off and leaves the rest on the task', () => {
    const d = domain();
    d.addAssignee('t1', 'm4');
    const r = d.removeAssignee('t1', 'm4');
    expect(r.message).toContain('removed from');
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m3']);
    // Removing the last person is what returns it to the pool.
    d.removeAssignee('t1', 'm3');
    expect(d.findTask('t1')!.assigneeIds).toEqual([]);
    expect(d.findTask('t1')!.claimedBy).toBeNull();
    expect(d.findTask('t1')!.claimedAt).toBeNull();
  });

  it('hands the "took it" credit to whoever is left when the taker leaves', () => {
    const d = domain();
    d.addAssignee('t1', 'm4');
    d.removeAssignee('t1', 'm3');
    expect(d.findTask('t1')!.claimedBy).toBe('m4');
  });

  it('sets the whole list at once from the multi-select', () => {
    const d = domain();
    const r = d.setAssignees('t1', ['m2', 'm5', 'm5']);
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m2', 'm5']);
    expect(r.message).toContain('added');
    // Unticking everybody empties the pool rather than leaving a stale owner.
    d.setAssignees('t1', []);
    expect(d.findTask('t1')!.assigneeIds).toEqual([]);
    expect(d.findTask('t1')!.claimedBy).toBeNull();
  });

  it('ignores ids that are not members', () => {
    const d = domain();
    d.setAssignees('t1', ['m2', 'not-a-member']);
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m2']);
  });

  it('starts a not-taken task as soon as somebody is on it', () => {
    const d = domain();
    const unowned = d.workspace.tasks.find((t) => !t.assigneeIds.length && t.status === 'TODO')!;
    d.addAssignee(unowned.id, 'm4');
    expect(d.findTask(unowned.id)!.status).toBe('PROG');
  });

  it('filters by membership, not ownership', () => {
    const d = domain();
    d.addAssignee('t1', 'm4');
    d.workspace.fMember = 'm4';
    expect(d.visibleTasks().map((t) => t.id)).toContain('t1');
    d.workspace.fMember = 'none';
    expect(d.visibleTasks().map((t) => t.id)).not.toContain('t1');
  });

  it('returns a task to the open pool', () => {
    const d = domain();
    d.reassign('t1', null);
    const t = d.findTask('t1')!;
    expect(t.assigneeIds).toEqual([]);
    expect(t.claimedAt).toBeNull();
  });

  it('replaces the list rather than adding to it', () => {
    const d = domain();
    d.addAssignee('t1', 'm4');
    // "Put this on X" means X owns it now — the blunt instrument, as distinct
    // from addAssignee.
    d.reassign('t1', 'm5');
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m5']);
  });
});

describe('ordering contract', () => {
  it('moves a task without touching any status', () => {
    const d = domain();
    const before = new Map(d.workspace.tasks.map((t) => [t.id, t.status]));
    const first = d.projectTasks()[0]!.id;
    const position = d.moveTask('t5', first);
    expect(position).toBe(1);
    expect(d.projectTasks()[0]!.id).toBe('t5');
    d.workspace.tasks.forEach((t) => expect(t.status).toBe(before.get(t.id)));
  });

  it('ignores a no-op drop', () => {
    const d = domain();
    const first = d.projectTasks()[0]!.id;
    expect(d.moveTask(first, 't1')).toBeNull();
  });

  it('appends when dropped past the end', () => {
    const d = domain();
    const position = d.moveTask('t1', '__end__');
    expect(position).toBe(d.projectTasks().length);
    expect(d.projectTasks().at(-1)?.id).toBe('t1');
  });
});

describe('composer', () => {
  it('inserts before the anchor and clears the composer', async () => {
    const d = domain();
    d.workspace.composer = 1;
    d.workspace.composerAnchor = 't3';
    const created = (await d.createTask({ title: 'Draft the invite', typeId: 'tt3', assigneeId: null, due: null, priority: 'normal' }))!;
    const ids = d.projectTasks().map((t) => t.id);
    expect(ids.indexOf(created.id)).toBe(ids.indexOf('t3') - 1);
    expect(created.status).toBe('TODO');
    expect(created.claimedAt).toBeNull();
    expect(d.workspace.composer).toBeNull();
  });

  it('starts an assigned task in progress and keys it off the project', async () => {
    const d = domain();
    const created = (await d.createTask({ title: 'Ship it', typeId: 'tt1', assigneeId: 'm3', due: '2026-10-20', priority: 'urgent' }))!;
    expect(created.status).toBe('PROG');
    expect(created.key).toBe(`NE-${d.projectTasks().length}`);
    expect(created.dueAt).toBe(new Date('2026-10-20T12:00:00').getTime());
  });
});

describe('subtasks', () => {
  it('adds, toggles and removes steps once the task is known', () => {
    const d = domain();
    d.addSub('t4', 'Pick a layout');
    expect(d.findTask('t4')?.subs).toHaveLength(1);
    d.toggleSub('t4', 0);
    expect(d.findTask('t4')?.subs[0]?.done).toBe(true);
    d.removeSub('t4', 0);
    expect(d.findTask('t4')?.subs).toHaveLength(0);
  });

  it('preserves done flags by text when the list is rewritten', () => {
    const d = domain();
    d.replaceSubs('t1', ['Message list renders nearby users', 'Pull to refresh', 'New step']);
    const subs = d.findTask('t1')!.subs;
    expect(subs[0]?.done).toBe(true);
    expect(subs[1]?.done).toBe(false);
    // Subtasks now carry stable ids so they can sync as individual rows.
    expect(subs[2]?.t).toBe('New step');
    expect(subs[2]?.done).toBe(false);
    expect(subs[2]?.id).toBeTruthy();
  });

  it('gives a step an owner, and takes them off again', () => {
    const d = domain();
    const sub = d.findTask('t1')!.subs[0]!;
    expect(sub.assigneeId ?? null).toBeNull();

    const r = d.assignSub('t1', sub.id, 'm4');
    expect(r.message).toContain('Rahul');
    expect(d.findTask('t1')!.subs[0]!.assigneeId).toBe('m4');

    // Assigning the same person again is a no-op, not an error.
    expect(d.assignSub('t1', sub.id, 'm4').message).toContain('already');
    expect(d.assignSub('t1', sub.id, null).message).toContain('unassigned');
    expect(d.findTask('t1')!.subs[0]!.assigneeId).toBeNull();
  });

  it('keys a step assignment by subtask id, not position', () => {
    // The picker is a round trip. Indexing by position would assign whichever
    // step happened to land in that slot while the modal was open.
    const d = domain();
    const second = d.findTask('t1')!.subs[1]!;
    d.addSub('t1', 'A step added while the modal was open');
    d.assignSub('t1', second.id, 'm4');
    expect(d.findTask('t1')!.subs[1]!.assigneeId).toBe('m4');
    expect(d.findTask('t1')!.subs[2]!.assigneeId ?? null).toBeNull();
  });

  it('refuses an unknown step or member', () => {
    const d = domain();
    expect(d.assignSub('t1', 'not-a-step', 'm4').message).toContain('not found');
    expect(d.assignSub('t1', d.findTask('t1')!.subs[0]!.id, 'not-a-member').message).toContain('not found');
  });

  it('lets anybody claim a step for themselves, and hand it back', () => {
    const d = domain();
    const sub = d.findTask('t1')!.subs[0]!;
    expect(d.toggleSubAssignee('t1', sub.id).message).toContain('Arjun');
    expect(d.findTask('t1')!.subs[0]!.assigneeId).toBe('m1');
    // The same click takes it off again rather than reassigning it.
    expect(d.toggleSubAssignee('t1', sub.id).message).toContain('unassigned');
    expect(d.findTask('t1')!.subs[0]!.assigneeId).toBeNull();
  });

  it('keeps step owners when the task description is edited', () => {
    // Regression risk: replaceSubs rebuilds every row from the textarea. It
    // matched on text and dropped everything else, which silently wiped every
    // step assignment in the task.
    const d = domain();
    const kept = d.findTask('t1')!.subs[0]!;
    d.assignSub('t1', kept.id, 'm4');
    d.replaceSubs('t1', ['Message list renders nearby users', 'Pull to refresh']);
    const after = d.findTask('t1')!.subs[0]!;
    expect(after.id).toBe(kept.id);
    expect(after.assigneeId).toBe('m4');
  });

  it('drops a removed member’s steps back to unassigned', () => {
    const d = domain();
    const sub = d.findTask('t1')!.subs[0]!;
    d.assignSub('t1', sub.id, 'm4');
    d.removeMember('m4');
    expect(d.findTask('t1')!.subs[0]!.assigneeId ?? null).toBeNull();
  });

  it('records the hand-over in the audit trail', () => {
    const events: Array<{ action: string; summary: string }> = [];
    const d = new FlowDomain(seed(FIXED_NOW), {
      storage: null,
      onEvent: (e) => events.push({ action: e.action, summary: e.summary }),
    });
    const sub = d.findTask('t1')!.subs[0]!;
    d.assignSub('t1', sub.id, 'm4');
    expect(events.at(-1)?.action).toBe('subtask.assigned');
    expect(events.at(-1)?.summary).toContain('Rahul');
  });
});

describe('team', () => {
  it('moves a removed member’s tasks into the open pool', () => {
    const d = domain();
    const r = d.removeMember('m3');
    expect(r.ok).toBe(true);
    expect(r.owned).toBeGreaterThan(0);
    expect(d.workspace.tasks.some((t) => t.assigneeIds.includes('m3'))).toBe(false);
  });

  it('never removes the last member', () => {
    const d = new FlowDomain(emptyWorkspace(), { storage: fakeStorage() });
    d.addMember('Solo', 'Owner', 'owner');
    expect(d.removeMember(d.workspace.members[0]!.id).ok).toBe(false);
  });

  it('carries the sign-in identity when there is one', () => {
    // The domain never asks who is signed in; it stores what it is handed, so
    // the whole rule set stays testable in Node.
    const d = new FlowDomain(emptyWorkspace(), { storage: fakeStorage() });
    const owner = d.addMember('Arjun', 'Founder', 'owner', { email: 'arjun@x.com', userId: 'auth-1' });
    expect(owner.email).toBe('arjun@x.com');
    expect(owner.userId).toBe('auth-1');
    // The first member also becomes the acting user, as before.
    expect(d.workspace.me).toBe(owner.id);
  });

  it('invites by email alone, without binding anybody yet', () => {
    const d = new FlowDomain(emptyWorkspace(), { storage: fakeStorage() });
    const invited = d.addMember('Sneha', '', 'member', { email: 'sneha@x.com' });
    expect(invited.email).toBe('sneha@x.com');
    // Unbound: the row is claimed on her first sign-in, not before.
    expect(invited.userId).toBeUndefined();
  });

  it('leaves the browser-local member exactly as it was', () => {
    const d = new FlowDomain(emptyWorkspace(), { storage: fakeStorage() });
    const local = d.addMember('Rahul', 'Backend');
    expect(local.email).toBeUndefined();
    expect(local.userId).toBeUndefined();
  });
});

describe('assistant', () => {
  let d: FlowDomain;
  beforeEach(() => {
    d = domain();
  });

  it('answers what is blocked', () => {
    const r = d.reply('what is blocked?');
    expect(r.html).toContain('NE-3');
    expect(r.pending).toBeNull();
  });

  it('answers progress with the real percentages', () => {
    const r = d.reply('how far along are we?');
    expect(r.html).toContain(`${d.progress().pct}%`);
  });

  it('reassigns by task key', () => {
    const r = d.reply('assign NE-1 to Rahul');
    expect(r.mutated).toBe(true);
    expect(d.findTask('t1')!.assigneeIds).toEqual(['m4']);
  });

  it('marks a task done by key', () => {
    const r = d.reply('NE-4 is complete');
    expect(r.mutated).toBe(true);
    expect(d.findTask('t4')?.status).toBe('DONE');
  });

  it('drafts a task from a sentence without saving it yet', () => {
    const r = d.reply('add task Publish the beta invite for Meera due friday');
    expect(r.pending).not.toBeNull();
    expect(r.pending?.owner?.name).toBe('Meera Suresh');
    expect(r.pending?.title.toLowerCase()).toContain('beta invite');
    expect(r.pending?.title.toLowerCase()).not.toContain('meera');
    expect(r.pending?.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.workspace.tasks.some((t) => t.title.includes('beta invite'))).toBe(false);
  });

  it('reads priorities and relative dates', () => {
    const urgent = d.parseTask('add urgent Fix the login crash in 2 days');
    expect(urgent.prio).toBe('urgent');
    expect(urgent.due).toBeTruthy();
    expect(d.parseTask('add low Clean up the backlog').prio).toBe('low');
    expect(d.parseTask('add Write the changelog').prio).toBe('normal');
  });

  it('says so when there is no project', () => {
    const blank = FlowDomain.blank({ storage: fakeStorage() });
    expect(blank.reply('what is blocked?').html).toContain('no project yet');
  });

  it('commits a drafted task to the end of the chain', async () => {
    const pending = d.parseTask('add task Invite 50 beta testers for Meera due friday');
    const t = (await d.addAssistantTask(pending))!;
    expect(d.projectTasks().at(-1)?.id).toBe(t.id);
    expect(t.assigneeIds).toEqual(['m5']);
    expect(t.status).toBe('PROG');
  });
});

describe('formatting helpers', () => {
  it('escapes every dangerous character', () => {
    expect(esc('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('derives project keys exactly as the prototype keyFrom() does', () => {
    // Verified value-for-value against the prototype source: non-letters are
    // dropped (not replaced), articles are kept, multi-word names become
    // initials, and a single word keeps its first four letters.
    // (workflow-chain.html, keyFrom at line 1141.)
    expect(keyFrom('Mobile app v1')).toBe('MAV');
    expect(keyFrom('Natil Evidayaa · Mobile App')).toBe('NEMA');
    expect(keyFrom('theblackit.com Redesign')).toBe('TR');
    expect(keyFrom('Redesign')).toBe('REDE');
    expect(keyFrom('New Website')).toBe('NW');
    expect(keyFrom('Our new tool')).toBe('ONT');
    expect(keyFrom('App v1')).toBe('AV');
    expect(keyFrom('v1')).toBe('V');
    expect(keyFrom('!!!')).toBe('PRJ');
    expect(keyFrom('')).toBe('PRJ');
  });

  it('keeps the prototype modal fallback for an empty Key field', () => {
    // openProjectModal() joined the first letter of every word, so a
    // single-word name differs from keyFrom(): "Redesign" -> "R", not "REDE".
    // (workflow-chain.html, openProjectModal at line 1210.)
    expect(projectKeyFallback('Redesign')).toBe('R');
    expect(projectKeyFallback('Mobile app v1')).toBe('MAV');
    expect(projectKeyFallback('Natil Evidayaa · Mobile App')).toBe('NEMA');
    expect(projectKeyFallback('theblackit.com Redesign')).toBe('TR');
    expect(projectKeyFallback('New Website')).toBe('NW');
    expect(projectKeyFallback('!!!')).toBe('PRJ');
  });

  it('describes relative dates', () => {
    const now = FIXED_NOW;
    expect(relDays(now, now)).toBe('today');
    expect(relDays(now + 86_400_000, now)).toBe('tomorrow');
    expect(relDays(now - 2 * 86_400_000, now)).toBe('2d late');
    expect(relDays(now + 3 * 86_400_000, now)).toBe('in 3d');
    expect(relAgo(now - 30_000, now)).toBe('just now');
    expect(relAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
});

describe('initialWorkspace — shared workspace keys', () => {
  it('uses real UUIDs everywhere the database requires them', () => {
    const ws = initialWorkspace(FIXED_NOW);
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    ws.members.forEach((m) => expect(m.id, `member ${m.name}`).toMatch(pattern));
    ws.projects.forEach((p) => expect(p.id, `project ${p.key}`).toMatch(pattern));
    ws.tasks.forEach((t) => {
      expect(t.id, `task ${t.key}`).toMatch(pattern);
      expect(t.projectId, `task ${t.key} project`).toMatch(pattern);
      t.subs.forEach((sub) => expect(sub.id, `subtask of ${t.key}`).toMatch(pattern));
    });
    expect(ws.me).toMatch(pattern);
    expect(ws.projectId).toMatch(pattern);
  });

  it('keeps cross-references pointing at the remapped ids', () => {
    const ws = initialWorkspace(FIXED_NOW);
    const memberIds = new Set(ws.members.map((m) => m.id));
    const projectIds = new Set(ws.projects.map((p) => p.id));
    ws.tasks.forEach((t) => {
      expect(projectIds.has(t.projectId), `${t.key} points at a real project`).toBe(true);
      t.assigneeIds.forEach((id) => expect(memberIds.has(id), `${t.key} assignee exists`).toBe(true));
      if (t.claimedBy) expect(memberIds.has(t.claimedBy), `${t.key} claimer exists`).toBe(true);
    });
  });

  it('seeds each project counter past its own tasks', () => {
    const ws = initialWorkspace(FIXED_NOW);
    ws.projects.forEach((p) => {
      const count = ws.tasks.filter((t) => t.projectId === p.id).length;
      expect(p.taskCounter).toBe(count);
    });
  });

  it('has the same shape as the demo seed', () => {
    const shared = initialWorkspace(FIXED_NOW);
    const demo = seed(FIXED_NOW);
    expect(shared.members.length).toBe(demo.members.length);
    expect(shared.projects.length).toBe(demo.projects.length);
    expect(shared.tasks.length).toBe(demo.tasks.length);
    expect(shared.mode).toBe('live');
  });
});

describe('initialWorkspace is idempotent', () => {
  it('gives every row a unique id', () => {
    const ws = initialWorkspace(FIXED_NOW);
    const ids = [
      ...ws.members.map((m) => m.id),
      ...ws.projects.map((p) => p.id),
      ...ws.tasks.map((t) => t.id),
      ...ws.tasks.flatMap((t) => t.subs.map((s) => s.id)),
    ];
    // A collision here silently merges rows in Postgres — four projects once
    // collapsed onto one UUID because the hash key was too coarse.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces the same ids on every call, so re-seeding updates rather than duplicates', () => {
    const first = initialWorkspace(FIXED_NOW);
    const second = initialWorkspace(FIXED_NOW);
    expect(second.projects.map((p) => p.id)).toEqual(first.projects.map((p) => p.id));
    expect(second.members.map((m) => m.id)).toEqual(first.members.map((m) => m.id));
    expect(second.tasks.map((t) => t.id)).toEqual(first.tasks.map((t) => t.id));
  });

  it('points every task at a project that exists', () => {
    const ws = initialWorkspace(FIXED_NOW);
    const projectIds = new Set(ws.projects.map((p) => p.id));
    // The earlier collision left all 32 tasks on a single project.
    expect(new Set(ws.tasks.map((t) => t.projectId)).size).toBe(ws.projects.length);
    ws.tasks.forEach((t) => expect(projectIds.has(t.projectId)).toBe(true));
  });

  it('counts each project its own tasks, not every task', () => {
    const ws = initialWorkspace(FIXED_NOW);
    ws.projects.forEach((p) => {
      expect(p.taskCounter).toBe(ws.tasks.filter((t) => t.projectId === p.id).length);
    });
    expect(ws.projects.reduce((sum, p) => sum + (p.taskCounter ?? 0), 0)).toBe(ws.tasks.length);
  });
});

describe('ids created in the app are Postgres-safe', () => {
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it('uid() returns a UUID, not a readable string', () => {
    // These go straight into `uuid` columns; a short id like "m1x9f2" makes
    // Postgres reject the row, so nothing created in the UI ever persisted.
    for (let i = 0; i < 20; i++) expect(uid('m')).toMatch(pattern);
    expect(new Set(Array.from({ length: 50 }, () => uid('t'))).size).toBe(50);
  });

  it('a member added through the API gets a UUID', () => {
    const d = new FlowDomain(seed(FIXED_NOW), { storage: null });
    expect(d.addMember('New Person', 'Designer').id).toMatch(pattern);
  });

  it('a created task and its subtask get UUIDs', async () => {
    const d = new FlowDomain(seed(FIXED_NOW), { storage: null });
    const task = (await d.createTask({
      title: 'From the composer',
      typeId: 'tt3',
      assigneeId: null,
      due: null,
      priority: 'normal',
    }))!;
    expect(task.id).toMatch(pattern);
    expect(d.addSub(task.id, 'A step')!.id).toMatch(pattern);
  });

  it('a new project gets a UUID', () => {
    const d = new FlowDomain(seed(FIXED_NOW), { storage: null });
    expect(d.createProject('Brand new', 'BN', 'Brand').id).toMatch(pattern);
  });
});

describe('custom task types', () => {
  it('renders an unknown type id as its own label, not "Task"', () => {
    const d = new FlowDomain(seed(FIXED_NOW), { storage: null });
    // A custom type is stored as the typed text, since the type list itself is
    // not part of the synced workspace.
    expect(d.typeName('Spike')).toBe('Spike');
    expect(d.typeName('tt3')).toBe('Task');
    expect(d.typeName('')).toBe('Task');
  });

  it('keeps a custom type through create and reload', async () => {
    const d = new FlowDomain(seed(FIXED_NOW), { storage: null });
    const t = (await d.createTask({
      title: 'Investigate the crash',
      typeId: 'Spike',
      assigneeId: null,
      due: null,
      priority: 'normal',
    }))!;
    expect(t.typeId).toBe('Spike');
    expect(d.typeName(t.typeId)).toBe('Spike');
  });
});

describe('creation writes are not left in the debounce window', () => {
  it('marks a newly created task as urgent', async () => {
    const calls: Array<{ urgent?: boolean }> = [];
    const d = new FlowDomain(seed(FIXED_NOW), {
      storage: null,
      persist: (_ws, options) => calls.push(options ?? {}),
    });
    await d.createTask({
      title: 'Written straight away',
      typeId: 'tt3',
      assigneeId: null,
      due: null,
      priority: 'normal',
    });
    // Refreshing right after adding a task must not lose it.
    expect(calls.at(-1)?.urgent).toBe(true);
  });

  it('marks a newly created project as urgent', () => {
    const calls: Array<{ urgent?: boolean }> = [];
    const d = new FlowDomain(seed(FIXED_NOW), {
      storage: null,
      persist: (_ws, options) => calls.push(options ?? {}),
    });
    d.createProject('New thing', 'NT', '');
    expect(calls.at(-1)?.urgent).toBe(true);
  });
});

describe('first run ends when the first project exists', () => {
  it('creating a project ends the welcome state', () => {
    // `setup` is what hides the welcome screen. It used to be set only on
    // load, so a workspace created in this session kept showing the welcome
    // screen until the page was reloaded.
    const ws = emptyWorkspace();
    ws.mode = 'live';
    const d = new FlowDomain(ws, { storage: null });
    expect(d.workspace.setup).toBe(false);
    d.createProject('The BlackIT', 'TBI', '');
    expect(d.workspace.setup).toBe(true);
  });
});
