/**
 * `swapHtml` carries typed input across a re-render. It must not carry a
 * picker's old value over the one the render just chose: that left the header
 * Project / Acting as pickers blank after the demo loaded.
 */
import { describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { swapHtml } from '../src/lib/dom-state';

function host(html: string): HTMLElement {
  const document = new Window().document as unknown as Document;
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe('swapHtml and selects', () => {
  it('keeps the rendered choice of a picker that commits on change', () => {
    const root = host('<select data-act="project" disabled><option>No project yet</option></select>');
    swapHtml(
      root,
      '<select data-act="project"><option value="p1" selected>Mobile App</option><option value="p2">Launch</option></select>',
    );
    expect(root.querySelector('select')!.value).toBe('p1');
  });

  it('still restores an unsaved choice in a form select', () => {
    const root = host('<select id="newType"><option value="a" selected>A</option><option value="b">B</option></select>');
    root.querySelector('select')!.value = 'b';
    swapHtml(root, '<select id="newType"><option value="a" selected>A</option><option value="b">B</option></select>');
    expect(root.querySelector('select')!.value).toBe('b');
  });

  it('never gives a select a value none of its options carry', () => {
    const root = host('<select id="newType"><option value="gone" selected>Gone</option></select>');
    swapHtml(root, '<select id="newType"><option value="a" selected>A</option></select>');
    expect(root.querySelector('select')!.value).toBe('a');
  });
});
