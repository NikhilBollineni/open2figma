import { describe, it, expect } from 'vitest';
import { detectComponents } from '../src/components.js';
import { makeFrame, O2F_VERSION, type O2FDocument, type TextNode } from '@open2figma/schema';

const text = (id: string, chars: string): TextNode => ({
  id, name: chars, type: 'TEXT', x: 0, y: 0, width: 100, height: 20, opacity: 1, visible: true, fills: [], strokes: [], effects: [],
  positioning: 'AUTO', sizingHorizontal: 'FIXED', sizingVertical: 'FIXED', meta: { tag: 'h3' },
  runs: [{ characters: chars, style: { fontFamily: 'Inter', fontStack: ['Inter'], fontSize: 16, fontWeight: 600, italic: false, letterSpacing: 0, textAlign: 'LEFT', textCase: 'ORIGINAL', textDecoration: 'NONE', color: { r: 0, g: 0, b: 0, a: 1 } } }],
  autoResize: 'HEIGHT', verticalAlign: 'TOP',
});

function card(i: number) {
  return makeFrame({
    id: `card${i}`, name: 'article.card', meta: { tag: 'article', classes: ['card', `css-${i}abcdef`] },
    children: [
      makeFrame({ id: `icon${i}`, name: 'div.icon', meta: { tag: 'div', classes: ['icon'] } }),
      text(`t${i}`, `Title ${i}`),
      text(`p${i}`, `Body ${i}`),
    ],
  });
}

describe('detectComponents', () => {
  it('finds repeated subtrees, ignoring text and hashed classes, and prefers the outermost match', () => {
    const grid = makeFrame({ id: 'grid', name: 'div.grid', meta: { tag: 'div', classes: ['grid'] }, children: [card(1), card(2), card(3)] });
    const doc: O2FDocument = {
      version: O2F_VERSION, generator: 't', createdAt: '', source: {}, breakpoints: [{ name: 'd', width: 1, height: 1, root: makeFrame({ id: 'root', name: 'root', children: [grid] }) }],
      components: {}, assets: {}, tokens: [], fonts: [], warnings: [],
    };
    detectComponents(doc);
    const keys = Object.keys(doc.components);
    expect(keys).toHaveLength(1);
    expect(doc.components[keys[0]]).toEqual({ name: 'Article.card', count: 3 });
    expect(grid.children.every((c) => c.meta.componentKey === keys[0])).toBe(true);
    // inner icons repeat too but must not become their own component
    expect((grid.children[0] as typeof grid).children[0].meta.componentKey).toBeUndefined();
  });

  it('ignores tiny subtrees', () => {
    const root = makeFrame({ id: 'root', name: 'root', children: [makeFrame({ id: 'a', name: 'div', meta: { tag: 'div' } }), makeFrame({ id: 'b', name: 'div', meta: { tag: 'div' } })] });
    const doc: O2FDocument = { version: O2F_VERSION, generator: 't', createdAt: '', source: {}, breakpoints: [{ name: 'd', width: 1, height: 1, root }], components: {}, assets: {}, tokens: [], fonts: [], warnings: [] };
    detectComponents(doc);
    expect(Object.keys(doc.components)).toHaveLength(0);
  });
});
