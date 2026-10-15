/**
 * Injection tests. Every renderer runs through the same functions that the
 * static build and the live client use, so one hostile payload placed in each
 * user-controlled field proves the whole output path is escaped.
 */
import { describe, expect, it } from 'vitest';
import { FlowDomain, seed } from '../src/lib/domain';
import {
  accountAvatar,
  projectMenu,
  renderAuthScreen,
  renderBell,
  renderChain,
  renderChat,
  renderControls,
  renderHeadProgress,
  renderSubBar,
  renderWelcome,
  subAssignBody,
  teamBody,
  editTaskBody,
  previewHtml,
  type ChatState,
} from '../src/lib/render';
import type { AuthUser } from '../src/lib/types';

const PAYLOAD = '<img src=x onerror="window.__pwned=1">';
const QUOTE_BREAK = `" onmouseover="window.__pwned=2" x="`;
const SCRIPT = '<script>window.__pwned=3</script>';

/** Every field a person can type into. */
function poisoned(): FlowDomain {
  const d = new FlowDomain(seed(Date.UTC(2026, 9, 10)), { storage: null });
  const ws = d.workspace;
  ws.projects[0]!.name = PAYLOAD;
  ws.projects[0]!.product = QUOTE_BREAK;
  ws.members[0]!.name = PAYLOAD;
  ws.members[0]!.title = SCRIPT;
  // The invite address is echoed back on the team screen, on the "not invited"
  // card and in the ⋯ menu, so it has to travel the same escaping path.
  ws.members[0]!.email = QUOTE_BREAK;
  ws.types[0]!.name = PAYLOAD;
  d.workspace.tasks.forEach((t, i) => {
    t.title = `${PAYLOAD}${i}`;
    t.description = QUOTE_BREAK;
    t.stage = SCRIPT;
    t.subs = [{ id: `s-${i}`, t: PAYLOAD, done: false, assigneeIds: [] }];
  });
  return d;
}

/** No unescaped tag or event attribute may survive into rendered markup. */
function expectInert(html: string, label: string): void {
  expect(html, `${label}: raw tag`).not.toContain('<img');
  expect(html, `${label}: raw script`).not.toContain('<script');
  // `onerror=` only survives as an attribute if the quotes were not escaped.
  expect(html, `${label}: live handler`).not.toMatch(/onerror="window\.__pwned/);
  expect(html, `${label}: attribute break-out`).not.toMatch(/\sonmouseover="window\.__pwned2"/);
}

const chat: ChatState = {
  open: true,
  msg: [
    { who: 'bot', html: 'plain bot text' },
    { who: 'user', html: 'plain user text' },
  ],
};

describe('hostile user input stays inert', () => {
  it('escapes the whole chain', () => {
    const d = poisoned();
    const html = renderChain(d);
    expectInert(html, 'chain');
    // The payload is still visible as text.
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes the header controls', () => {
    expectInert(renderControls(poisoned()), 'controls');
  });

  it('escapes the progress bar and filters', () => {
    expectInert(renderSubBar(poisoned()), 'subbar');
  });

  it('escapes the compact header progress', () => {
    expectInert(renderHeadProgress(poisoned(), true), 'head progress');
  });

  it('escapes the welcome screen', () => {
    const d = poisoned();
    d.workspace.setup = false;
    expectInert(renderWelcome(d), 'welcome');
  });

  it('escapes the assistant panel', () => {
    expectInert(renderChat(poisoned(), chat), 'chat');
  });

  it('escapes the team modal body', () => {
    expectInert(teamBody(poisoned()), 'team');
  });

  it('escapes the edit modal body', () => {
    const d = poisoned();
    expectInert(editTaskBody(d, d.workspace.tasks[0]!), 'edit');
  });

  it('escapes the assistant task preview', () => {
    const html = previewHtml(
      { title: PAYLOAD, owner: poisoned().workspace.members[0]!, prio: 'high', due: null, projectId: 'p1' },
      `${PAYLOAD}`,
    );
    expectInert(html, 'preview');
  });

  it('escapes assistant answers built from workspace data', () => {
    const d = poisoned();
    // A blocked-task listing interpolates keys and titles into the transcript.
    const r = d.reply('what is blocked?');
    expectInert(r.html, 'assistant answer');
  });
});

describe('hostile account data stays inert', () => {
  const HOSTILE: AuthUser = { id: 'u-1', email: PAYLOAD, name: SCRIPT, avatarUrl: null };

  it('escapes every step of the sign-in screen', () => {
    expectInert(renderAuthScreen({ step: 'signin', email: PAYLOAD, message: SCRIPT, account: null }), 'auth signin');
    expectInert(renderAuthScreen({ step: 'sent', email: QUOTE_BREAK, message: PAYLOAD, account: null }), 'auth sent');
    expectInert(
      renderAuthScreen({ step: 'not-invited', email: '', message: PAYLOAD, account: HOSTILE }),
      'auth not invited',
    );
    expectInert(
      renderAuthScreen({ step: 'error', email: '', message: QUOTE_BREAK, account: HOSTILE }),
      'auth error',
    );
  });

  it('escapes the signed-in header chip and the ⋯ menu', () => {
    // The account name and email reach both, straight from the provider.
    expectInert(renderControls(poisoned(), HOSTILE), 'account chip');
    expectInert(projectMenu(HOSTILE), 'account menu');
    expectInert(accountAvatar(HOSTILE), 'account avatar');
  });

  it('escapes invite addresses on the team screen', () => {
    expectInert(teamBody(poisoned()), 'team invites');
  });

  it('escapes the step picker and the step owner on a card', () => {
    const d = poisoned();
    const t = d.workspace.tasks[0]!;
    // Unassigned first, then with a hostile member on the step: the row draws
    // their initials and their name in a title attribute.
    expectInert(subAssignBody(d, t, t.subs[0]!), 'step picker');
    t.subs[0]!.assigneeIds = [d.workspace.members[0]!.id];
    expectInert(renderChain(d), 'card with an assigned step');
    expectInert(subAssignBody(d, t, t.subs[0]!), 'step picker with an owner');
  });

  it('escapes the notification bell', () => {
    // Every field here comes from another account: the actor names themselves,
    // and the summary is a subtask's text or a status code.
    expectInert(
      renderBell(
        [
          {
            id: 1,
            kind: 'task.assigned',
            actorId: null,
            actorName: PAYLOAD,
            taskId: 't1',
            taskKey: QUOTE_BREAK,
            summary: SCRIPT,
            createdAt: Date.now(),
            readAt: null,
          },
          {
            id: 2,
            kind: 'subtask.assigned',
            actorId: null,
            actorName: SCRIPT,
            taskId: null,
            taskKey: '',
            summary: PAYLOAD,
            createdAt: Date.now(),
            readAt: null,
          },
        ],
        'supabase',
      ),
      'bell',
    );
  });
});

describe('attribute injection', () => {
  it('escapes task ids, which can arrive from an edited localStorage blob', () => {
    const d = new FlowDomain(seed(Date.UTC(2026, 9, 10)), { storage: null });
    d.workspace.tasks[0]!.id = QUOTE_BREAK;
    const html = renderChain(d);
    expect(html).toContain('&quot; onmouseover=&quot;');
    expectInert(html, 'task id');
  });

  it('escapes member, project and type ids', () => {
    const d = poisoned();
    d.workspace.members[0]!.id = QUOTE_BREAK;
    d.workspace.projects[0]!.id = QUOTE_BREAK;
    d.workspace.projects[0]!.key = QUOTE_BREAK;
    d.workspace.types[0]!.id = QUOTE_BREAK;
    d.workspace.projectId = QUOTE_BREAK;
    d.workspace.me = QUOTE_BREAK;
    d.workspace.fMember = QUOTE_BREAK;
    const html = [renderChain(d), renderControls(d), renderSubBar(d), teamBody(d), editTaskBody(d, d.workspace.tasks[0]!)].join(
      '\n',
    );
    expectInert(html, 'ids');
  });
});
