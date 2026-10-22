/**
 * A minimal in-memory stand-in for the Figma Plugin API: enough to assert
 * which nodes the builder creates and which properties it sets, in what order.
 */
export class MockNode {
  id = `m${++MockNode.counter}`;
  static counter = 0;
  name = '';
  x = 0;
  y = 0;
  width = 100;
  height = 100;
  opacity = 1;
  visible = true;
  fills: unknown[] = [];
  strokes: unknown[] = [];
  effects: unknown[] = [];
  strokeWeight = 1;
  strokeAlign = 'INSIDE';
  dashPattern: number[] = [];
  children: MockNode[] = [];
  parent: MockNode | null = null;
  layoutMode = 'NONE';
  layoutWrap = 'NO_WRAP';
  itemSpacing = 0;
  counterAxisSpacing = 0;
  paddingTop = 0; paddingRight = 0; paddingBottom = 0; paddingLeft = 0;
  primaryAxisAlignItems = 'MIN';
  counterAxisAlignItems = 'MIN';
  primaryAxisSizingMode = 'FIXED';
  counterAxisSizingMode = 'FIXED';
  strokesIncludedInLayout = false;
  clipsContent = true;
  topLeftRadius = 0; topRightRadius = 0; bottomRightRadius = 0; bottomLeftRadius = 0;
  strokeTopWeight = 0; strokeRightWeight = 0; strokeBottomWeight = 0; strokeLeftWeight = 0;
  layoutPositioning = 'AUTO';
  private _sizingH = 'FIXED';
  private _sizingV = 'FIXED';
  log: string[] = [];

  constructor(public type: string) {}

  get layoutSizingHorizontal() { return this._sizingH; }
  set layoutSizingHorizontal(v: string) {
    if (!this.parent || this.parent.layoutMode === 'NONE') {
      if (v === 'FILL') throw new Error('FILL requires an auto-layout parent');
    }
    if (v === 'HUG' && this.type !== 'TEXT' && this.layoutMode === 'NONE') throw new Error('HUG requires auto-layout');
    this._sizingH = v;
    this.log.push(`sizingH=${v}`);
  }
  get layoutSizingVertical() { return this._sizingV; }
  set layoutSizingVertical(v: string) {
    if (!this.parent || this.parent.layoutMode === 'NONE') {
      if (v === 'FILL') throw new Error('FILL requires an auto-layout parent');
    }
    if (v === 'HUG' && this.type !== 'TEXT' && this.layoutMode === 'NONE') throw new Error('HUG requires auto-layout');
    this._sizingV = v;
    this.log.push(`sizingV=${v}`);
  }

  resize(w: number, h: number) { this.width = w; this.height = h; this.log.push(`resize(${w},${h})`); }
  resizeWithoutConstraints(w: number, h: number) { this.resize(w, h); }
  appendChild(c: MockNode) {
    c.parent = this;
    this.children.push(c);
    this.log.push(`append(${c.type})`);
  }
  findAll(pred: (n: MockNode) => boolean): MockNode[] {
    const out: MockNode[] = [];
    const walk = (n: MockNode) => { for (const c of n.children) { if (pred(c)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  createInstance(): MockNode {
    const clone = (n: MockNode): MockNode => {
      const c = new MockNode(n === this ? 'INSTANCE' : n.type);
      Object.assign(c, { name: n.name, width: n.width, height: n.height, fills: [...n.fills], layoutMode: n.layoutMode });
      if (n instanceof MockText) {
        const t = new MockText();
        Object.assign(t, { name: n.name, characters: n.characters, fontName: n.fontName });
        return t;
      }
      for (const k of n.children) c.appendChild(clone(k));
      return c;
    };
    return clone(this);
  }
}

export class MockText extends MockNode {
  characters = '';
  fontName = { family: 'Inter', style: 'Regular' };
  textAlignHorizontal = 'LEFT';
  textAlignVertical = 'TOP';
  textAutoResize = 'WIDTH_AND_HEIGHT';
  textTruncation = 'DISABLED';
  maxLines = 0;
  ranges: Record<string, unknown[]> = {};
  constructor() { super('TEXT'); }
  private range(kind: string, s: number, e: number, v: unknown) { (this.ranges[kind] ??= []).push([s, e, v]); }
  setRangeFontName(s: number, e: number, v: unknown) { this.range('font', s, e, v); }
  setRangeFontSize(s: number, e: number, v: unknown) { this.range('size', s, e, v); }
  setRangeLineHeight(s: number, e: number, v: unknown) { this.range('lh', s, e, v); }
  setRangeLetterSpacing(s: number, e: number, v: unknown) { this.range('ls', s, e, v); }
  setRangeTextDecoration(s: number, e: number, v: unknown) { this.range('deco', s, e, v); }
  setRangeTextCase(s: number, e: number, v: unknown) { this.range('case', s, e, v); }
  setRangeFills(s: number, e: number, v: unknown) { this.range('fills', s, e, v); }
  getRangeAllFontNames() { return [this.fontName]; }
}

export interface MockFigma {
  created: MockNode[];
  loadedFonts: string[];
  page: MockNode;
  variables: { created: { name: string; type: string; values: unknown[] }[] };
}

export function installMockFigma(fonts: { family: string; style: string }[] = defaultFonts()): MockFigma {
  const page = new MockNode('PAGE');
  page.layoutMode = 'NONE';
  const state: MockFigma = { created: [], loadedFonts: [], page, variables: { created: [] } };
  const make = (type: string) => { const n = type === 'TEXT' ? new MockText() : new MockNode(type); state.created.push(n); return n; };
  const collections: { id: string; name: string; modes: { modeId: string }[] }[] = [];
  const vars: { id: string; name: string; variableCollectionId: string; resolvedType: string; values: unknown[]; setValueForMode(m: string, v: unknown): void }[] = [];

  (globalThis as unknown as { figma: unknown }).figma = {
    mixed: Symbol('mixed'),
    currentPage: Object.assign(page, { selection: [] as MockNode[] }),
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() { /* noop */ } },
    createFrame: () => make('FRAME'),
    createComponent: () => make('COMPONENT'),
    createText: () => make('TEXT'),
    createRectangle: () => make('RECTANGLE'),
    createEllipse: () => make('ELLIPSE'),
    createSection: () => make('SECTION'),
    createNodeFromSvg: (svg: string) => { if (!svg.includes('<svg')) throw new Error('bad svg'); const n = make('FRAME'); n.name = 'svg'; return n; },
    createImage: (bytes: Uint8Array) => { if (!bytes.length) throw new Error('empty image'); return { hash: `img-${bytes.length}` }; },
    base64Decode: (s: string) => Uint8Array.from(Buffer.from(s, 'base64')),
    listAvailableFontsAsync: async () => fonts.map((f) => ({ fontName: f })),
    loadFontAsync: async (f: { family: string; style: string }) => { state.loadedFonts.push(`${f.family}/${f.style}`); },
    notify() { /* noop */ },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async () => vars,
      createVariableCollection(name: string) { const c = { id: `col${collections.length}`, name, modes: [{ modeId: 'm0' }] }; collections.push(c); return c; },
      createVariable(name: string, collection: { id: string }, type: string) {
        const v = { id: `v${vars.length}`, name, variableCollectionId: collection.id, resolvedType: type, values: [] as unknown[], setValueForMode(_m: string, val: unknown) { v.values.push(val); } };
        vars.push(v);
        state.variables.created.push(v);
        return v;
      },
      setBoundVariableForPaint(paint: Record<string, unknown>, field: string, variable: { id: string }) {
        return { ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } } };
      },
    },
  };
  return state;
}

export function defaultFonts() {
  const out: { family: string; style: string }[] = [];
  for (const style of ['Thin', 'Light', 'Regular', 'Medium', 'Semi Bold', 'Bold', 'Black', 'Italic', 'Bold Italic']) out.push({ family: 'Inter', style });
  for (const style of ['Regular', 'Bold']) out.push({ family: 'Georgia', style });
  for (const style of ['Regular', 'Medium', 'Bold']) out.push({ family: 'Roboto Mono', style });
  return out;
}
