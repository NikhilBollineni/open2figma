import { describe, it, expect } from 'vitest';
import { inferLayout, type ParentStyle, type ChildStyle, type Box } from '../src/browser/layout.js';

const pad = { top: 0, right: 0, bottom: 0, left: 0 };
const block = (): ParentStyle => ({
  display: 'block', flexDirection: 'row', justifyContent: 'normal', alignItems: 'normal', flexWrap: 'nowrap',
  columnGap: 0, rowGap: 0, gridTemplateColumns: 'none', gridTemplateRows: 'none', padding: { ...pad },
});
const flex = (over: Partial<ParentStyle> = {}): ParentStyle => ({ ...block(), display: 'flex', justifyContent: 'flex-start', alignItems: 'stretch', ...over });
const kid = (box: Box, over: Partial<ChildStyle> = {}): ChildStyle => ({ box, display: 'block', flexGrow: 0, alignSelf: 'auto', ...over });

describe('inferLayout', () => {
  it('turns a uniform block stack into VERTICAL with gap and absorbed margins', () => {
    const parent = { x: 0, y: 0, width: 400, height: 200 };
    const kids = [kid({ x: 0, y: 20, width: 400, height: 40 }), kid({ x: 0, y: 70, width: 400, height: 40 }), kid({ x: 0, y: 120, width: 400, height: 40 })];
    const r = inferLayout(parent, block(), kids);
    expect(r.layout.mode).toBe('VERTICAL');
    expect(r.layout.gap).toBe(10);
    expect(r.layout.padding.top).toBe(20);
    expect(r.layout.padding.bottom).toBe(40);
    expect(r.children[0]).toEqual({ horizontal: 'FILL', vertical: 'FIXED' });
  });

  it('falls back to NONE when spacing is irregular', () => {
    const parent = { x: 0, y: 0, width: 400, height: 200 };
    const kids = [kid({ x: 0, y: 0, width: 400, height: 40 }), kid({ x: 0, y: 50, width: 400, height: 40 }), kid({ x: 0, y: 130, width: 400, height: 40 })];
    const r = inferLayout(parent, block(), kids);
    expect(r.layout.mode).toBe('NONE');
    expect(r.reason).toBeTruthy();
  });

  it('maps flex row with space-between and centred items', () => {
    const parent = { x: 0, y: 0, width: 600, height: 80 };
    const style = flex({ justifyContent: 'space-between', alignItems: 'center', padding: { top: 20, right: 48, bottom: 20, left: 48 } });
    const kids = [kid({ x: 48, y: 30, width: 100, height: 20 }), kid({ x: 250, y: 25, width: 100, height: 30 }), kid({ x: 452, y: 20, width: 100, height: 40 })];
    const r = inferLayout(parent, style, kids);
    expect(r.layout.mode).toBe('HORIZONTAL');
    expect(r.layout.primaryAlign).toBe('SPACE_BETWEEN');
    expect(r.layout.counterAlign).toBe('CENTER');
    expect(r.layout.padding.left).toBe(48);
  });

  it('detects HUG sizing when the content defines the size', () => {
    const parent = { x: 0, y: 0, width: 240, height: 40 };
    const style = flex({ alignItems: 'center', columnGap: 12, padding: { top: 0, right: 18, bottom: 0, left: 18 } });
    const kids = [kid({ x: 18, y: 10, width: 100, height: 20 }), kid({ x: 130, y: 10, width: 92, height: 20 })];
    const r = inferLayout(parent, style, kids);
    expect(r.layout.mode).toBe('HORIZONTAL');
    expect(r.layout.gap).toBe(12);
    expect(r.layout.sizingHorizontal).toBe('HUG');
    expect(r.layout.sizingVertical).toBe('FIXED');
  });

  it('recovers alignment that CSS achieved with margin auto', () => {
    // declared flex-start but the last child is pushed right with margin-left:auto → no single alignment matches → NONE
    const parent = { x: 0, y: 0, width: 600, height: 40 };
    const kids = [kid({ x: 0, y: 0, width: 100, height: 40 }), kid({ x: 110, y: 0, width: 100, height: 40 }), kid({ x: 500, y: 0, width: 100, height: 40 })];
    const r = inferLayout(parent, flex({ columnGap: 10 }), kids);
    expect(r.layout.mode).toBe('NONE');
  });

  it('respects reversed flex direction', () => {
    const parent = { x: 0, y: 0, width: 300, height: 40 };
    const kids = [kid({ x: 200, y: 0, width: 100, height: 40 }), kid({ x: 100, y: 0, width: 100, height: 40 }), kid({ x: 0, y: 0, width: 100, height: 40 })];
    const r = inferLayout(parent, flex({ flexDirection: 'row-reverse' }), kids);
    expect(r.layout.mode).toBe('HORIZONTAL');
    expect(r.reverse).toBe(true);
  });

  it('maps multi-track grids to GRID and single column grids to VERTICAL', () => {
    const parent = { x: 0, y: 0, width: 600, height: 400 };
    const grid = { ...block(), display: 'grid', gridTemplateColumns: '184px 184px 184px', gridTemplateRows: '190px 190px', columnGap: 24, rowGap: 20 };
    const kids = Array.from({ length: 6 }, (_, i) => kid({ x: (i % 3) * 208, y: Math.floor(i / 3) * 210, width: 184, height: 190 }));
    const r = inferLayout(parent, grid, kids);
    expect(r.layout.mode).toBe('GRID');
    expect(r.layout.grid).toEqual({ columns: 3, rows: 2, columnGap: 24, rowGap: 20 });

    const single = { ...grid, gridTemplateColumns: '600px', gridTemplateRows: '40px 40px' };
    const col = inferLayout({ x: 0, y: 0, width: 600, height: 100 }, single, [kid({ x: 0, y: 0, width: 600, height: 40 }), kid({ x: 0, y: 60, width: 600, height: 40 })]);
    expect(col.layout.mode).toBe('VERTICAL');
    expect(col.layout.gap).toBe(20);
  });

  it('marks flex-grow children as FILL on the main axis', () => {
    const parent = { x: 0, y: 0, width: 400, height: 40 };
    const kids = [kid({ x: 0, y: 0, width: 300, height: 40 }, { flexGrow: 1 }), kid({ x: 308, y: 0, width: 92, height: 40 })];
    const r = inferLayout(parent, flex({ columnGap: 8 }), kids);
    expect(r.layout.mode).toBe('HORIZONTAL');
    expect(r.children[0].horizontal).toBe('FILL');
    expect(r.children[1].horizontal).toBe('FIXED');
  });
});
