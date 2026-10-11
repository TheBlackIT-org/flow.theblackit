/**
 * Wiring integrity: every `data-act` the markup can emit must be handled by
 * `FlowActions.run()`, and every handler must be reachable from markup. This is
 * the test that stops the two halves of the delegated-event design from
 * drifting apart as the app grows.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS, CHANGE_ACTIONS } from '../src/lib/constants';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.ts') || full.endsWith('.astro') ? [full] : [];
  });
}

function sources(): { path: string; text: string }[] {
  return walk(join(ROOT, 'src')).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

/** Values emitted as `data-act="x"` in source, including template literals. */
function emittedActions(): Set<string> {
  const found = new Set<string>();
  for (const { text } of sources()) {
    for (const m of text.matchAll(/data-act="([a-z-]+)"/g)) found.add(m[1]!);
    // Interpolated cases: data-act="${x}" are resolved by hand below.
  }
  return found;
}

/** `case 'x':` labels inside FlowActions.run(). */
function handledActions(): Set<string> {
  const actions = readFileSync(join(ROOT, 'src/lib/actions.ts'), 'utf8');
  const run = actions.slice(actions.indexOf('run(action: string'), actions.indexOf('/* --------------------------- task operations'));
  const found = new Set<string>();
  for (const m of run.matchAll(/case '([a-z-]+)':/g)) found.add(m[1]!);
  return found;
}

describe('action map', () => {
  const emitted = emittedActions();
  const handled = handledActions();

  const changes = new Set<string>(CHANGE_ACTIONS);

  it('handles every click action the markup emits', () => {
    const orphans = [...emitted].filter((a) => !handled.has(a) && !changes.has(a)).sort();
    expect(orphans).toEqual([]);
  });

  it('does not carry dead handlers', () => {
    const dead = [...handled].filter((a) => !emitted.has(a)).sort();
    expect(dead).toEqual([]);
  });

  it('lists every click action in the shared ACTIONS constant', () => {
    const declared = new Set<string>(ACTIONS);
    const missing = [...emitted, ...handled].filter((a) => !declared.has(a) && !changes.has(a)).sort();
    expect(missing).toEqual([]);
    expect(declared.size).toBe(ACTIONS.length);
  });

  it('routes every change action through the change listener', () => {
    const texts = sources().map((s) => s.text).join('\n');
    const app = readFileSync(join(ROOT, 'src/lib/app.ts'), 'utf8');
    for (const act of CHANGE_ACTIONS) {
      expect(texts).toContain(`data-act="${act}"`);
      expect(app).toContain(`act === '${act}'`);
    }
  });
});

describe('markup safety', () => {
  it('routes every interpolated class-name expression through esc() where it is text', () => {
    const renders = readFileSync(join(ROOT, 'src/lib/render.ts'), 'utf8');
    // Titles, names and descriptions must never be interpolated raw.
    expect(renders).not.toMatch(/\$\{t\.title\}/);
    expect(renders).not.toMatch(/\$\{t\.description\}/);
    expect(renders).not.toMatch(/\$\{m\.name\}/);
    expect(renders).not.toMatch(/\$\{sub\.t\}/);
    expect(renders).toMatch(/\$\{esc\(t\.title\)\}/);
    expect(renders).toMatch(/\$\{esc\(t\.description\)\}/);
    expect(renders).toMatch(/\$\{esc\(m\.name\)\}/);
  });
});

describe('stylesheet completeness', () => {
  const css = readFileSync(join(ROOT, 'src/styles/flow.css'), 'utf8');

  /** Class names the markup can emit. */
  function classesUsedInMarkup(): Set<string> {
    const used = new Set<string>();
    for (const { text } of sources()) {
      for (const m of text.matchAll(/class="([^"$]*)/g)) {
        m[1]!.split(/\s+/).forEach((c) => c && used.add(c));
      }
    }
    return used;
  }

  it('styles every class the markup uses, apart from known no-ops', () => {
    const declared = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]!));
    // `sm` is a size modifier that never had a rule, in the prototype either.
    const exempt = new Set(['sm']);
    const missing = [...classesUsedInMarkup()]
      .filter((c) => !declared.has(c) && !exempt.has(c))
      .sort();
    // A whole section of this file was once deleted by a bad edit, which
    // silently unstyled the chain, cards, modals and toasts.
    expect(missing, 'classes emitted by markup but not styled').toEqual([]);
  });

  it('keeps hidden-until-opened rules for popovers', () => {
    // Without a base `.pop { display: none }` every menu renders expanded and
    // breaks the header layout.
    expect(css).toMatch(/\.pop\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.pop\.on\s*\{[^}]*display:\s*block/);
  });

  it('has balanced braces', () => {
    expect(css.split('{').length).toBe(css.split('}').length);
  });

  it('hides the modal and scrim until opened', () => {
    expect(css).toMatch(/\.modal\s*\{[^}]*display:\s*none/);
    expect(css).toMatch(/\.scrim\s*\{[^}]*opacity:\s*0/);
  });
});
