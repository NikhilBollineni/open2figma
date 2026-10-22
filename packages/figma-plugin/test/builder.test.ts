import { describe, it, expect, beforeEach } from 'vitest';
import { installMockFigma, MockNode, MockText, type MockFigma } from './mock-figma.js';
import { importDocument, gradientTransform } from '../src/builder.js';
import { pickStyle, FontResolver } from '../src/fonts.js';
import { makeFrame, O2F_VERSION, type O2FDocument, type TextNode, type TextStyle, type FrameNode } from '@open2figma/schema';

const style = (over: Partial<TextStyle> = {}): TextStyle => ({
  fontFamily: 'Inter', fontStack: ['Inter', 'sans-serif'], fontSize: 16, fontWeight: 400, italic: false, letterSpacing: 0,
  textAlign: 'LEFT', textCase: 'ORIGINAL', textDecoration: 'NONE', color: { r: 0, g: 0, b: 0, a: 1 }, ...over,
});

const text = (id: string, chars: string, over: Partial<TextNode> = {}): TextNode => ({
  id, name: chars, type: 'TEXT', x: 0, y: 0, width: 120, height: 20, opacity: 1, visible: true, fills: [], strokes: [], effects: [],
  positioning: 'AUTO', sizingHorizontal: 'HUG', sizingVertical: 'HUG', meta: {}, runs: [{ characters: chars, style: style() }],
  autoResize: 'WIDTH_AND_HEIGHT', verticalAlign: 'TOP', ...over,
});

function doc(root: FrameNode, extra: Partial<O2FDocument> = {}): O2FDocument {
  return {
    version: O2F_VERSION, generator: 'test', createdAt: '', source: { title: 'Test page' },
    breakpoints: [{ name: 'Desktop', width: 800, height: 600, root }],
    components: {}, assets: {}, tokens: [], fonts: [], warnings: [], ...extra,
  };
}

let fig: MockFigma;
beforeEach(() => { fig = installMockFigma(); });

describe('importDocument', () => {
  it('builds auto-layout frames with padding, gap, alignment and child sizing', async () => {
    const root = makeFrame({
      id: 'root', name: 'root', width: 800, height: 100,
      layout: { mode: 'HORIZONTAL', gap: 12, padding: { top: 10, right: 20, bottom: 10, left: 20 }, primaryAlign: 'SPACE_BETWEEN', counterAlign: 'CENTER', wrap: false, sizingHorizontal: 'FIXED', sizingVertical: 'FIXED' },
      children: [
        text('t1', 'Left'),
        { ...makeFrame({ id: 'f1', name: 'grow', width: 300, height: 40 }), sizingHorizontal: 'FILL', sizingVertical: 'FIXED' },
        { ...makeFrame({ id: 'abs', name: 'badge', x: 700, y: 5, width: 40, height: 20 }), positioning: 'ABSOLUTE' },
      ],
    });
    const { nodes, report } = await importDocument(doc(root), { useSection: false });
    expect(report.nodes).toBe(4);
    const frame = nodes[0] as MockNode;
    expect(frame.layoutMode).toBe('HORIZONTAL');
    expect(frame.itemSpacing).toBe(12);
    expect(frame.paddingLeft).toBe(20);
    expect(frame.primaryAxisAlignItems).toBe('SPACE_BETWEEN');
    expect(frame.counterAxisAlignItems).toBe('CENTER');
    expect(frame.children.map((c) => c.type)).toEqual(['TEXT', 'FRAME', 'FRAME']);
    expect(frame.children[0].layoutSizingHorizontal).toBe('HUG');
    expect(frame.children[1].layoutSizingHorizontal).toBe('FILL');
    expect(frame.children[2].layoutPositioning).toBe('ABSOLUTE');
    expect(frame.children[2].x).toBe(700);
    // sizing must be set only after the child is appended
    expect(frame.children[1].log.indexOf('sizingH=FILL')).toBeGreaterThan(-1);
    expect(frame.log.indexOf('append(FRAME)')).toBeLessThan(frame.children[1].log.length + frame.log.length);
  });

  it('writes text runs with per-range styles and resolves fonts', async () => {
    const t = text('t', 'Hello world', { runs: [
      { characters: 'Hello ', style: style() },
      { characters: 'world', style: style({ fontWeight: 700, color: { r: 1, g: 0, b: 0, a: 1 }, textDecoration: 'UNDERLINE' }) },
    ] });
    const root = makeFrame({ id: 'root', name: 'root', children: [t] });
    await importDocument(doc(root), { useSection: false });
    const node = fig.created.find((n) => n.type === 'TEXT') as MockText;
    expect(node.characters).toBe('Hello world');
    expect(node.ranges.font).toEqual([[0, 6, { family: 'Inter', style: 'Regular' }], [6, 11, { family: 'Inter', style: 'Bold' }]]);
    expect(node.ranges.deco[1]).toEqual([6, 11, 'UNDERLINE']);
    expect(fig.loadedFonts).toContain('Inter/Bold');
  });

  it('substitutes missing families using the stack and generic fallbacks', async () => {
    const t = text('t', 'Mono', { runs: [{ characters: 'Mono', style: style({ fontFamily: 'Fira Code', fontStack: ['Fira Code', 'monospace'], fontWeight: 500 }) }] });
    const root = makeFrame({ id: 'root', name: 'root', children: [t] });
    const { report } = await importDocument(doc(root), { useSection: false });
    expect(report.fontSubstitutions['Fira Code']).toBe('Roboto Mono');
    const node = fig.created.find((n) => n.type === 'TEXT') as MockText;
    expect(node.ranges.font[0][2]).toEqual({ family: 'Roboto Mono', style: 'Medium' });
  });

  it('creates a main component and instances with text overrides', async () => {
    const card = (id: string, title: string): FrameNode => ({
      ...makeFrame({ id, name: 'card', width: 200, height: 100, meta: { componentKey: 'abc' }, layout: { mode: 'VERTICAL', gap: 8, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'MIN', counterAlign: 'MIN', wrap: false, sizingHorizontal: 'FIXED', sizingVertical: 'FIXED' } }),
      children: [text(`${id}-t`, title)],
    });
    const root = makeFrame({ id: 'root', name: 'root', children: [card('c1', 'First'), card('c2', 'Second'), card('c3', 'Third')] });
    const { report } = await importDocument(doc(root, { components: { abc: { name: 'Card', count: 3 } } }), { useSection: false });
    expect(report.components).toBe(1);
    expect(report.instances).toBe(2);
    const main = fig.created.find((n) => n.type === 'COMPONENT') as MockNode;
    expect(main.name).toBe('Card');
    const rootNode = fig.created.find((n) => n.name === 'root') as MockNode;
    expect(rootNode.children.map((c) => c.type)).toEqual(['COMPONENT', 'INSTANCE', 'INSTANCE']);
    const second = rootNode.children[1].findAll((n) => n.type === 'TEXT')[0] as MockText;
    expect(second.characters).toBe('Second');
  });

  it('can be told not to create components', async () => {
    const root = makeFrame({ id: 'root', name: 'root', children: [
      makeFrame({ id: 'a', name: 'x', meta: { componentKey: 'k' } }), makeFrame({ id: 'b', name: 'x', meta: { componentKey: 'k' } }),
    ] });
    const { report } = await importDocument(doc(root, { components: { k: { name: 'X', count: 2 } } }), { useSection: false, createComponents: false });
    expect(report.components).toBe(0);
    expect(fig.created.filter((n) => n.type === 'COMPONENT')).toHaveLength(0);
  });

  it('creates variables from tokens and binds fills to them', async () => {
    const root = makeFrame({ id: 'root', name: 'root', fills: [{ type: 'SOLID', color: { r: 0.31, g: 0.27, b: 0.9, a: 1 }, token: 'color/brand' }] });
    const tokens = [
      { name: 'color/brand', type: 'COLOR' as const, value: { r: 0.31, g: 0.27, b: 0.9, a: 1 }, raw: '#4f46e5' },
      { name: 'space/4', type: 'FLOAT' as const, value: 16, raw: '16px' },
      { name: 'font/sans', type: 'STRING' as const, value: 'Inter', raw: 'Inter' },
    ];
    const { report } = await importDocument(doc(root, { tokens }), { useSection: false });
    expect(report.variables).toBe(3);
    expect(fig.variables.created.map((v) => v.name)).toEqual(['color/brand', 'space/4', 'font/sans']);
    const frame = fig.created.find((n) => n.name === 'root') as MockNode;
    expect((frame.fills[0] as { boundVariables: unknown }).boundVariables).toEqual({ color: { type: 'VARIABLE_ALIAS', id: 'v0' } });
  });

  it('decodes images into fills and falls back to grey when missing', async () => {
    const root = makeFrame({ id: 'root', name: 'root', children: [
      { ...makeFrame({ id: 'img', name: 'img' }), type: 'RECTANGLE', fills: [{ type: 'IMAGE', asset: 'a1', scaleMode: 'FILL' }] } as never,
      { ...makeFrame({ id: 'img2', name: 'broken' }), type: 'RECTANGLE', fills: [{ type: 'IMAGE', asset: 'missing', scaleMode: 'FILL' }] } as never,
    ] });
    const assets = { a1: { mime: 'image/png', data: Buffer.from('fakepng').toString('base64') }, missing: { mime: 'image/png', data: '' } };
    const { report } = await importDocument(doc(root, { assets }), { useSection: false });
    expect(report.images).toBe(1);
    const rects = fig.created.filter((n) => n.type === 'RECTANGLE');
    expect(rects[0].fills[0]).toMatchObject({ type: 'IMAGE', imageHash: 'img-7' });
    expect(rects[1].fills[0]).toMatchObject({ type: 'SOLID' });
  });

  it('imports SVG via createNodeFromSvg and survives bad markup', async () => {
    const root = makeFrame({ id: 'root', name: 'root', children: [
      { ...makeFrame({ id: 's', name: 'icon', width: 20, height: 20 }), type: 'SVG', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' } as never,
      { ...makeFrame({ id: 's2', name: 'bad', width: 20, height: 20 }), type: 'SVG', svg: 'nope' } as never,
    ] });
    const { report } = await importDocument(doc(root), { useSection: false });
    expect(fig.created.some((n) => n.name === 'icon')).toBe(true);
    expect(report.warnings.join()).toMatch(/could not be parsed/);
  });

  it('wraps breakpoints in a section and lays them out side by side', async () => {
    const d = doc(makeFrame({ id: 'r1', name: 'Desktop', width: 800, height: 600 }));
    d.breakpoints.push({ name: 'Mobile', width: 390, height: 844, root: makeFrame({ id: 'r2', name: 'Mobile', width: 390, height: 844 }) });
    const { nodes } = await importDocument(d, { frameGap: 100 });
    expect(nodes[0].type).toBe('SECTION');
    const section = nodes[0] as MockNode;
    expect(section.name).toBe('Test page');
    expect(section.children).toHaveLength(2);
    expect(section.children[1].x - section.children[0].x).toBe(900);
  });

  it('rejects invalid documents', async () => {
    await expect(importDocument({ version: 2 } as never)).rejects.toThrow(/invalid document/);
  });
});

describe('fonts', () => {
  it('picks the closest weight and italic', () => {
    const styles = ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Italic', 'Bold Italic'];
    expect(pickStyle(styles, 600, false)).toBe('Semi Bold');
    expect(pickStyle(styles, 650, false)).toBe('Semi Bold');
    expect(pickStyle(styles, 700, true)).toBe('Bold Italic');
    expect(pickStyle(styles, 300, false)).toBe('Light');
    expect(pickStyle(styles, 200, false)).toBe('Thin');
  });
  it('resolves generic families', async () => {
    const r = new FontResolver('Inter');
    await r.init();
    expect(r.resolve({ fontFamily: 'serif', fontStack: ['serif'], fontWeight: 700, italic: false })).toEqual({ family: 'Georgia', style: 'Bold' });
  });
});

describe('gradientTransform', () => {
  it('maps a left-to-right gradient onto the x axis', () => {
    const t = gradientTransform(90, 200, 100);
    expect(t[0][0]).toBeCloseTo(1);
    expect(t[0][1]).toBeCloseTo(0);
    expect(t[0][2]).toBeCloseTo(0);
  });
  it('maps a top-to-bottom gradient onto y', () => {
    const t = gradientTransform(180, 200, 100);
    expect(t[0][0]).toBeCloseTo(0);
    expect(t[0][1]).toBeCloseTo(1);
    expect(t[0][2]).toBeCloseTo(0);
  });
});
