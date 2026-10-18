/**
 * Typed-but-unsaved input survives a re-render.
 *
 * Every render replaces a subtree's `innerHTML`, which throws away whatever is
 * in its inputs. Some of that text is real state the domain owns (a task title
 * after saving); the rest is only in the DOM — the composer you are halfway
 * through, a subtask you are typing, the assistant's question box. A remote
 * change from a teammate, or simply the minute heartbeat, used to erase all of
 * it, and there was nowhere for the person to get it back from.
 *
 * The fix is to carry the values, selection and focus across the swap. It is
 * deliberately blunt — capture everything, restore everything that is still
 * there — because the alternative is remembering, for every renderer, which
 * fields are precious, and getting that wrong is silent data loss.
 */

export interface FieldSnapshot {
  /** Stable across renders where possible; see `keyFor`. */
  key: string;
  value: string;
  checked?: boolean;
  start: number | null;
  end: number | null;
  focused: boolean;
}

const FIELDS = 'input, textarea, select';

/**
 * How a field is recognised after the swap.
 *
 * Ids first: every field the app renders on purpose carries one. `data-subinput`
 * is the subtask composer, which is keyed by task. `name` covers modal fields.
 * The index is a last resort and only ever matches something that was at the
 * same position, which is why it is not trusted for anything the app renders
 * with an id.
 */
function keyFor(el: Element, index: number): string {
  const id = el.getAttribute('id');
  if (id) return `#${id}`;
  const sub = el.getAttribute('data-subinput');
  if (sub) return `sub:${sub}`;
  const name = el.getAttribute('name');
  if (name) return `name:${name}`;
  return `${el.tagName}:${index}`;
}

/** `selectionStart` throws on date/number inputs, so it is never assumed. */
function selection(el: HTMLInputElement | HTMLTextAreaElement): { start: number | null; end: number | null } {
  try {
    return { start: el.selectionStart ?? null, end: el.selectionEnd ?? null };
  } catch {
    return { start: null, end: null };
  }
}

export function captureFields(root: Element): FieldSnapshot[] {
  const active = root.ownerDocument?.activeElement ?? null;
  return Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    FIELDS,
  )).map((el, index) => {
    const boxed = el as HTMLInputElement;
    const isBox = boxed.type === 'checkbox' || boxed.type === 'radio';
    const caret = isBox ? { start: null, end: null } : selection(el as HTMLInputElement);
    return {
      key: keyFor(el, index),
      value: el.value,
      checked: isBox ? boxed.checked : undefined,
      start: caret.start,
      end: caret.end,
      focused: el === active,
    };
  });
}

export function restoreFields(root: Element, snapshots: FieldSnapshot[]): void {
  if (!snapshots.length) return;
  const found = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(FIELDS)).forEach(
    (el, index) => found.set(keyFor(el, index), el),
  );

  let focus: HTMLElement | null = null;
  for (const snapshot of snapshots) {
    const el = found.get(snapshot.key);
    if (!el) continue;
    const boxed = el as HTMLInputElement;
    const isBox = boxed.type === 'checkbox' || boxed.type === 'radio';
    if (isBox) {
      if (snapshot.checked !== undefined) boxed.checked = snapshot.checked;
    } else if (el.hasAttribute('data-act')) {
      // A `data-act` field (the Project, Acting as and Member pickers, a role)
      // commits the moment it changes, so it never holds unsaved input and the
      // render is the truth. Restoring it put the old value back: after the demo
      // loaded, "No project yet" — which matches no option — left the header
      // pickers showing no text at all.
    } else if (el.value !== snapshot.value) {
      // Only touch it when it actually differs, so a rendered default (an
      // `<option selected>`, a `value="…"` attribute) is not clobbered by an
      // empty snapshot entry. A select is never given a value none of its
      // options carry: that leaves it blank.
      const isSelect = el.tagName === 'SELECT';
      if (!isSelect || Array.from((el as HTMLSelectElement).options).some((o) => o.value === snapshot.value)) {
        el.value = snapshot.value;
      }
    }
    if (snapshot.start !== null) {
      try {
        (el as HTMLInputElement).setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start);
      } catch {
        /* not a text field */
      }
    }
    if (snapshot.focused) focus = el;
  }
  // Focus last, and only if it was ours: stealing focus back from something the
  // user moved to during the render would be worse than losing it.
  focus?.focus();
}

/**
 * Replace a subtree's markup without losing what was typed into it.
 *
 * Every renderer goes through here rather than calling `innerHTML` directly.
 */
export function swapHtml(root: Element, html: string): void {
  const snapshots = captureFields(root);
  root.innerHTML = html;
  restoreFields(root, snapshots);
}
