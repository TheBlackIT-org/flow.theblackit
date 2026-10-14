/**
 * BlackIT Flow — status / priority constants and the DOM action map.
 *
 * The action map is the single source of truth for the delegated click
 * handler: every interactive element carries `data-act="<key>"`, and
 * `actions.ts` switches on exactly these keys.
 */

import type { PriorityDef, StatusDef } from './types';

export const APP_NAME = 'BlackIT Flow';
export const STORAGE_KEY = 'blackit_flow_v1';

export const STATUS: StatusDef[] = [
  { id: 'DONE', label: 'Done', cls: 'done', color: 'var(--green)', line: 'done' },
  { id: 'PROG', label: 'In Progress', cls: 'prog', color: 'var(--teal)', line: 'prog' },
  { id: 'REVIEW', label: 'In Review', cls: 'review', color: 'var(--amber)', line: 'review' },
  { id: 'BLOCK', label: 'Blocked', cls: 'block', color: 'var(--red)', line: 'block' },
  { id: 'TODO', label: 'Not Taken', cls: 'todo', color: 'var(--grey)', line: 'todo' },
];

export const PRIO: PriorityDef[] = [
  { id: 'low', label: 'Low', color: '#8b95a6' },
  { id: 'normal', label: 'Normal', color: 'var(--blue)' },
  { id: 'high', label: 'High', color: 'var(--amber)' },
  { id: 'urgent', label: 'Urgent', color: 'var(--red)' },
];

/** Node click cycles through this ring. */
export const CYCLE = ['TODO', 'PROG', 'REVIEW', 'DONE', 'BLOCK'] as const;

export const PALETTE = [
  '#2ee6c5',
  '#5b9bff',
  '#f5b544',
  '#c084fc',
  '#35d07f',
  '#ff8f6b',
  '#7dd3fc',
  '#f472b6',
];

export const DEFAULT_TYPES = [
  { id: 'tt1', name: 'Feature', color: '#3b82f6' },
  { id: 'tt2', name: 'Bug', color: '#ef4444' },
  { id: 'tt3', name: 'Task', color: '#64748b' },
  { id: 'tt4', name: 'Idea', color: '#f59e0b' },
  { id: 'tt6', name: 'Chore', color: '#14b8a6' },
];

export const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5l10.5 6.5L8 18.5z"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  pause:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M9.5 6v12M14.5 6v12"/></svg>',
};

export const GLYPH_CHAIN =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="4" r="2.3"/><circle cx="12" cy="12" r="2.3"/><circle cx="12" cy="20" r="2.3"/><path d="M12 6.3v3.4M12 14.3v3.4"/></svg>';

export const GLYPH_BRAND =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="4" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="20" r="2.4"/><path d="M12 6.4v3.2M12 14.4v3.2"/></svg>';

export const CHAT_CHIPS = [
  'What is blocked?',
  'What is due this week?',
  'Who has the most work?',
  'What is not taken?',
  'How do I reorder tasks?',
];

/**
 * Every `data-act` value the app understands. Kept as a frozen list so an
 * audit can assert that markup and handlers never drift apart.
 */
export const ACTIONS = [
  'cycle',
  'claim',
  'st',
  'sub',
  'subs',
  'edit',
  'reassign',
  'assign-me',
  'unassign',
  'delete',
  'menu',
  'insert',
  'compose-end',
  'cancel-compose',
  'create',
  'wsmenu',
  'live-menu',
  'activity-close',
  'ws-fresh',
  'ws-export',
  'ws-help',
  'ws-task',
  'new-project',
  'team',
  'add-member',
  'del-member',
  'welcome-fresh',
  'welcome-demo',
  'welcome-home',
  'wz-next',
  'wz-back',
  'wz-skip',
  'wz-done',
  'clear-filters',
  'fstatus',
  'sub-add',
  'sub-del',
  'chat-toggle',
  'chat-close',
  'chat-chip',
  'chat-send',
  'chat-discard',
  'chat-add',
  'auth-github',
  'auth-email',
  'auth-code',
  'auth-other',
  'auth-retry',
  'auth-claim',
  'auth-signout',
  'close-modal',
  'submit-modal',
] as const;

/** Actions handled on `change` rather than `click`. */
export const CHANGE_ACTIONS = ['project', 'me', 'fmember', 'mrole'] as const;

export type ActionName = (typeof ACTIONS)[number];
