import { describe, it, expect } from 'vitest';
import { validateDocument, makeFrame, countNodes, O2F_VERSION } from '../src/index.js';

describe('validateDocument', () => {
  it('accepts a minimal document', () => {
    const doc = { version: O2F_VERSION, breakpoints: [{ name: 'd', width: 1, height: 1, root: makeFrame({ id: 'r', name: 'root' }) }] };
    expect(validateDocument(doc)).toEqual([]);
  });
  it('reports bad nodes', () => {
    const bad = makeFrame({ id: 'r', name: 'root', children: [{ ...makeFrame({ id: 'c', name: 'c' }), width: -1 }] });
    const doc = { version: O2F_VERSION, breakpoints: [{ name: 'd', width: 1, height: 1, root: bad }] };
    expect(validateDocument(doc).join()).toMatch(/negative size/);
    expect(validateDocument({ version: 99 }).join()).toMatch(/unsupported version/);
  });
  it('counts nodes', () => {
    expect(countNodes(makeFrame({ id: 'r', name: 'r', children: [makeFrame({ id: 'a', name: 'a' })] }))).toBe(2);
  });
});
