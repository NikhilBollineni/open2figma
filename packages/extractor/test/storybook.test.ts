import { describe, it, expect } from 'vitest';
import { parseStorybookIndex } from '../src/storybook.js';
import { parseViewports } from '../src/capture.js';

describe('storybook index', () => {
  it('reads v7 index.json and skips docs entries', () => {
    const entries = parseStorybookIndex({
      v: 4,
      entries: {
        'button--primary': { id: 'button--primary', title: 'Button', name: 'Primary', type: 'story' },
        'button--docs': { id: 'button--docs', title: 'Button', name: 'Docs', type: 'docs' },
      },
    });
    expect(entries).toEqual([{ id: 'button--primary', title: 'Button', name: 'Primary', type: 'story' }]);
  });
  it('reads legacy stories.json', () => {
    expect(parseStorybookIndex({ stories: { a: { id: 'a', title: 'A', name: 'x' } } })).toHaveLength(1);
  });
});

describe('parseViewports', () => {
  it('parses named and unnamed sizes', () => {
    expect(parseViewports('Desktop=1440x900, 390x844')).toEqual([
      { name: 'Desktop', width: 1440, height: 900 },
      { name: undefined, width: 390, height: 844 },
    ]);
  });
  it('rejects garbage', () => {
    expect(() => parseViewports('big')).toThrow();
  });
});
