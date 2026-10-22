/**
 * Builds native Figma nodes from an O2F document.
 */
import type {
  O2FDocument, O2FNode, FrameNode as O2FFrame, TextNode as O2FText, Fill, Stroke, Effect, RGBA, SizingMode, TextRun, Token,
} from '@open2figma/schema';
import { validateDocument, walk, isFrame } from '@open2figma/schema';
import { FontResolver } from './fonts.js';

export interface ImportOptions {
  createComponents: boolean;
  createVariables: boolean;
  fontFallback: string;
  /** Wrap the imported frames in a section named after the page. */
  useSection: boolean;
  /** Gap between breakpoint frames. */
  frameGap: number;
}

export const DEFAULT_OPTIONS: ImportOptions = {
  createComponents: true,
  createVariables: true,
  fontFallback: 'Inter',
  useSection: true,
  frameGap: 160,
};

export interface ImportReport {
  nodes: number;
  components: number;
  instances: number;
  variables: number;
  images: number;
  warnings: string[];
  fontSubstitutions: Record<string, string>;
}

type Progress = (done: number, total: number, label: string) => void;

interface Ctx {
  doc: O2FDocument;
  opts: ImportOptions;
  fonts: FontResolver;
  images: Map<string, string | null>; // asset key -> imageHash
  variables: Map<string, Variable>;
  mainComponents: Map<string, ComponentNode>;
  report: ImportReport;
  progress: Progress;
  done: number;
  total: number;
  lastYield: number;
}

export async function importDocument(doc: O2FDocument, options: Partial<ImportOptions> = {}, progress: Progress = () => {}): Promise<{ nodes: SceneNode[]; report: ImportReport }> {
  const problems = validateDocument(doc);
  if (problems.length) throw new Error(`invalid document: ${problems.slice(0, 5).join('; ')}`);
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const fonts = new FontResolver(opts.fontFallback);
  await fonts.init();

  const ctx: Ctx = {
    doc,
    opts,
    fonts,
    images: new Map(),
    variables: new Map(),
    mainComponents: new Map(),
    report: { nodes: 0, components: 0, instances: 0, variables: 0, images: 0, warnings: [...doc.warnings], fontSubstitutions: {} },
    progress,
    done: 0,
    total: doc.breakpoints.reduce((n, bp) => {
      let c = 0;
      walk(bp.root, () => c++);
      return n + c;
    }, 0),
    lastYield: Date.now(),
  };

  progress(0, ctx.total, 'loading fonts');
  await preloadFonts(ctx);
  if (opts.createVariables && doc.tokens.length) {
    progress(0, ctx.total, 'creating variables');
    await createVariables(ctx, doc.tokens);
  }
  progress(0, ctx.total, 'decoding images');
  decodeImages(ctx);

  const page = figma.currentPage;
  const origin = figma.viewport.center;
  const roots: SceneNode[] = [];
  let x = origin.x;
  for (const bp of doc.breakpoints) {
    const node = await buildNode(ctx, bp.root, null);
    if (!node) continue;
    node.x = Math.round(x);
    node.y = Math.round(origin.y);
    page.appendChild(node);
    roots.push(node);
    x += node.width + opts.frameGap;
  }

  let out: SceneNode[] = roots;
  if (opts.useSection && roots.length && typeof figma.createSection === 'function') {
    const section = figma.createSection();
    section.name = doc.source.title || 'open2figma import';
    const minX = Math.min(...roots.map((r) => r.x));
    const minY = Math.min(...roots.map((r) => r.y));
    const maxX = Math.max(...roots.map((r) => r.x + r.width));
    const maxY = Math.max(...roots.map((r) => r.y + r.height));
    const pad = 80;
    section.x = minX - pad;
    section.y = minY - pad;
    section.resizeWithoutConstraints(maxX - minX + pad * 2, maxY - minY + pad * 2);
    for (const r of roots) {
      section.appendChild(r);
      r.x -= section.x;
      r.y -= section.y;
    }
    page.appendChild(section);
    out = [section];
  }

  for (const [from, to] of fonts.substitutions) ctx.report.fontSubstitutions[from] = to;
  figma.currentPage.selection = out;
  figma.viewport.scrollAndZoomIntoView(out);
  return { nodes: out, report: ctx.report };
}

// ---------------------------------------------------------------------------
// preparation
// ---------------------------------------------------------------------------

async function preloadFonts(ctx: Ctx): Promise<void> {
  const seen = new Set<string>();
  for (const bp of ctx.doc.breakpoints) {
    const todo: Promise<void>[] = [];
    walk(bp.root, (n) => {
      if (n.type !== 'TEXT') return;
      for (const r of n.runs) {
        const name = ctx.fonts.resolve(r.style);
        const key = `${name.family}/${name.style}`;
        if (seen.has(key)) continue;
        seen.add(key);
        todo.push(ctx.fonts.load(name).catch(() => {
          ctx.report.warnings.push(`font ${key} could not be loaded`);
        }));
      }
    });
    await Promise.all(todo);
  }
}

async function createVariables(ctx: Ctx, tokens: Token[]): Promise<void> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find((c) => c.name === 'open2figma tokens');
  if (!collection) collection = figma.variables.createVariableCollection('open2figma tokens');
  const modeId = collection.modes[0].modeId;
  const existing = await figma.variables.getLocalVariablesAsync();
  for (const t of tokens) {
    try {
      let v = existing.find((e) => e.variableCollectionId === collection!.id && e.name === t.name);
      if (!v) {
        v = figma.variables.createVariable(t.name, collection, t.type);
        ctx.report.variables++;
      }
      if (t.type === 'COLOR') v.setValueForMode(modeId, t.value as RGBA);
      else v.setValueForMode(modeId, t.value as number | string);
      ctx.variables.set(t.name, v);
    } catch (err) {
      ctx.report.warnings.push(`variable ${t.name}: ${(err as Error).message}`);
    }
  }
}

function decodeImages(ctx: Ctx): void {
  for (const [key, asset] of Object.entries(ctx.doc.assets)) {
    if (!asset.data) {
      ctx.images.set(key, null);
      continue;
    }
    try {
      const bytes = figma.base64Decode(asset.data);
      const image = figma.createImage(bytes);
      ctx.images.set(key, image.hash);
      ctx.report.images++;
    } catch (err) {
      ctx.images.set(key, null);
      ctx.report.warnings.push(`image ${asset.source ?? key} rejected: ${(err as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

type Container = FrameNode | ComponentNode;

async function buildNode(ctx: Ctx, n: O2FNode, parent: O2FFrame | null): Promise<SceneNode | null> {
  await tick(ctx, n.name);
  try {
    switch (n.type) {
      case 'FRAME':
        return await buildFrame(ctx, n);
      case 'TEXT':
        return await buildText(ctx, n);
      case 'RECTANGLE':
      case 'ELLIPSE':
        return buildShape(ctx, n);
      case 'SVG':
        return buildSvg(ctx, n);
    }
  } catch (err) {
    ctx.report.warnings.push(`${n.type} "${n.name}" skipped: ${(err as Error).message}`);
    return null;
  }
  void parent;
  return null;
}

async function tick(ctx: Ctx, label: string): Promise<void> {
  ctx.done++;
  ctx.report.nodes++;
  const now = Date.now();
  if (now - ctx.lastYield > 60) {
    ctx.lastYield = now;
    ctx.progress(ctx.done, ctx.total, label);
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function buildFrame(ctx: Ctx, n: O2FFrame): Promise<SceneNode> {
  const key = n.meta.componentKey;
  if (key && ctx.opts.createComponents) {
    const main = ctx.mainComponents.get(key);
    if (main) return buildInstance(ctx, n, main);
  }
  const node: Container = key && ctx.opts.createComponents ? figma.createComponent() : figma.createFrame();
  if (key && ctx.opts.createComponents) {
    ctx.mainComponents.set(key, node as ComponentNode);
    ctx.report.components++;
  }
  node.name = key && ctx.opts.createComponents ? ctx.doc.components[key]?.name ?? n.name : n.name;
  node.resizeWithoutConstraints(Math.max(0.01, n.width), Math.max(0.01, n.height));
  applyGeometryStyle(ctx, node, n);
  node.clipsContent = n.clipsContent;
  applyLayout(node, n);

  for (const child of n.children) {
    const built = await buildNode(ctx, child, n);
    if (!built) continue;
    node.appendChild(built);
    placeChild(ctx, node, built, child, n);
  }
  // Own sizing applies when there is no auto-layout parent to override it.
  applySelfSizing(node, n.layout.sizingHorizontal, n.layout.sizingVertical);
  return node;
}

function applyLayout(node: Container, n: O2FFrame): void {
  const l = n.layout;
  if (l.mode === 'NONE') {
    node.layoutMode = 'NONE';
    return;
  }
  if (l.mode === 'GRID') {
    const g = l.grid!;
    try {
      (node as unknown as { layoutMode: string }).layoutMode = 'GRID';
      const grid = node as unknown as { gridRowCount: number; gridColumnCount: number; gridRowGap: number; gridColumnGap: number };
      grid.gridColumnCount = g.columns;
      grid.gridRowCount = g.rows;
      grid.gridColumnGap = g.columnGap;
      grid.gridRowGap = g.rowGap;
    } catch {
      // Older Figma without grid auto-layout: wrap horizontally instead.
      node.layoutMode = 'HORIZONTAL';
      node.layoutWrap = 'WRAP';
      node.itemSpacing = g.columnGap;
      node.counterAxisSpacing = g.rowGap;
    }
  } else {
    node.layoutMode = l.mode;
    node.itemSpacing = l.gap;
    node.layoutWrap = l.wrap ? 'WRAP' : 'NO_WRAP';
    if (l.wrap) node.counterAxisSpacing = l.counterGap ?? l.gap;
    node.primaryAxisAlignItems = l.primaryAlign;
    node.counterAxisAlignItems = l.counterAlign;
  }
  node.paddingTop = l.padding.top;
  node.paddingRight = l.padding.right;
  node.paddingBottom = l.padding.bottom;
  node.paddingLeft = l.padding.left;
  node.strokesIncludedInLayout = false;
  node.primaryAxisSizingMode = 'FIXED';
  node.counterAxisSizingMode = 'FIXED';
}

function placeChild(ctx: Ctx, parentNode: Container, child: SceneNode, n: O2FNode, parent: O2FFrame): void {
  const autoLayout = parent.layout.mode !== 'NONE';
  if (!autoLayout) {
    child.x = n.x;
    child.y = n.y;
    return;
  }
  const c = child as SceneNode & LayoutMixin;
  if (n.positioning === 'ABSOLUTE') {
    c.layoutPositioning = 'ABSOLUTE';
    c.x = n.x;
    c.y = n.y;
    return;
  }
  if (parent.layout.mode === 'GRID') return; // grid children keep their fixed size
  const parentHugH = parent.layout.sizingHorizontal === 'HUG';
  const parentHugV = parent.layout.sizingVertical === 'HUG';
  setSizing(c, 'layoutSizingHorizontal', guardSizing(n.sizingHorizontal, child, parentHugH), ctx);
  setSizing(c, 'layoutSizingVertical', guardSizing(n.sizingVertical, child, parentHugV), ctx);
}

function guardSizing(mode: SizingMode, node: SceneNode, parentHugs: boolean): SizingMode {
  if (mode === 'FILL' && parentHugs) return 'FIXED';
  if (mode === 'HUG') {
    const canHug = node.type === 'TEXT' || ((node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE') && (node as FrameNode).layoutMode !== 'NONE');
    if (!canHug) return 'FIXED';
  }
  return mode;
}

function setSizing(node: SceneNode & LayoutMixin, prop: 'layoutSizingHorizontal' | 'layoutSizingVertical', mode: SizingMode, ctx: Ctx): void {
  try {
    node[prop] = mode;
  } catch (err) {
    ctx.report.warnings.push(`${node.name}: ${prop}=${mode} rejected (${(err as Error).message})`);
    try {
      node[prop] = 'FIXED';
    } catch { /* ignore */ }
  }
}

function applySelfSizing(node: Container, h: SizingMode, v: SizingMode): void {
  if (node.layoutMode === 'NONE') return;
  const horizontalIsPrimary = node.layoutMode === 'HORIZONTAL';
  const primary = horizontalIsPrimary ? h : v;
  const counter = horizontalIsPrimary ? v : h;
  if (node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL') {
    node.primaryAxisSizingMode = primary === 'HUG' ? 'AUTO' : 'FIXED';
    node.counterAxisSizingMode = counter === 'HUG' ? 'AUTO' : 'FIXED';
  }
}

async function buildInstance(ctx: Ctx, n: O2FFrame, main: ComponentNode): Promise<SceneNode> {
  const inst = main.createInstance();
  inst.name = n.name;
  ctx.report.instances++;
  if (Math.abs(inst.width - n.width) > 0.5 || Math.abs(inst.height - n.height) > 0.5) {
    inst.resizeWithoutConstraints(Math.max(0.01, n.width), Math.max(0.01, n.height));
  }
  // Text overrides: same structure, so TEXT nodes line up in traversal order.
  const sourceTexts: O2FText[] = [];
  walk(n, (c) => {
    if (c.type === 'TEXT') sourceTexts.push(c);
  });
  const targetTexts = inst.findAll((c) => c.type === 'TEXT') as TextNode[];
  for (let i = 0; i < Math.min(sourceTexts.length, targetTexts.length); i++) {
    const want = sourceTexts[i].runs.map((r) => r.characters).join('');
    if (targetTexts[i].characters !== want) {
      try {
        await setRuns(ctx, targetTexts[i], sourceTexts[i].runs);
      } catch (err) {
        ctx.report.warnings.push(`text override in ${n.name}: ${(err as Error).message}`);
      }
    }
  }
  // Image overrides for rectangles with image fills.
  const sourceImages: O2FNode[] = [];
  walk(n, (c) => {
    if ((c.type === 'RECTANGLE' || c.type === 'ELLIPSE') && c.fills.some((f) => f.type === 'IMAGE')) sourceImages.push(c);
  });
  const targetImages = inst.findAll((c) => {
    if (c.type !== 'RECTANGLE' && c.type !== 'ELLIPSE') return false;
    const fills = (c as RectangleNode).fills;
    return fills !== figma.mixed && (fills as readonly Paint[]).some((f) => f.type === 'IMAGE');
  }) as RectangleNode[];
  for (let i = 0; i < Math.min(sourceImages.length, targetImages.length); i++) {
    targetImages[i].fills = toPaints(ctx, sourceImages[i].fills, sourceImages[i].width, sourceImages[i].height);
  }
  return inst;
}

async function buildText(ctx: Ctx, n: O2FText): Promise<SceneNode> {
  const node = figma.createText();
  node.name = n.name;
  await setRuns(ctx, node, n.runs);
  const first = n.runs[0].style;
  node.textAlignHorizontal = first.textAlign;
  node.textAlignVertical = n.verticalAlign;
  node.opacity = n.opacity;
  if (n.truncation) {
    node.textTruncation = 'ENDING';
    if (n.maxLines) node.maxLines = n.maxLines;
  }
  node.textAutoResize = n.autoResize;
  if (n.autoResize === 'HEIGHT') node.resize(Math.max(0.01, n.width), node.height);
  else if (n.autoResize === 'NONE') node.resize(Math.max(0.01, n.width), Math.max(0.01, n.height));
  return node;
}

async function setRuns(ctx: Ctx, node: TextNode, runs: TextRun[]): Promise<void> {
  const text = runs.map((r) => r.characters).join('');
  // characters can only be set once all fonts in the node are loaded
  const names = await Promise.all(runs.map((r) => ctx.fonts.resolveAndLoad(r.style)));
  if (node.characters.length) {
    // existing node (instance override): its current fonts must be loaded to replace text
    const current = node.getRangeAllFontNames(0, node.characters.length);
    await Promise.all(current.map((f) => ctx.fonts.load(f)));
  }
  node.fontName = names[0];
  node.characters = text;
  if (!text.length) return;
  let pos = 0;
  runs.forEach((r, i) => {
    const end = pos + r.characters.length;
    if (end > pos) {
      const s = r.style;
      node.setRangeFontName(pos, end, names[i]);
      node.setRangeFontSize(pos, end, Math.max(1, s.fontSize));
      node.setRangeLineHeight(pos, end, s.lineHeight === undefined ? { unit: 'AUTO' } : { unit: 'PIXELS', value: s.lineHeight });
      node.setRangeLetterSpacing(pos, end, { unit: 'PIXELS', value: s.letterSpacing });
      node.setRangeTextDecoration(pos, end, s.textDecoration);
      node.setRangeTextCase(pos, end, s.textCase);
      let paint: SolidPaint = { type: 'SOLID', color: { r: s.color.r, g: s.color.g, b: s.color.b }, opacity: s.color.a };
      const v = s.colorToken ? ctx.variables.get(s.colorToken) : undefined;
      if (v) paint = figma.variables.setBoundVariableForPaint(paint, 'color', v) as SolidPaint;
      node.setRangeFills(pos, end, [paint]);
    }
    pos = end;
  });
}

function buildShape(ctx: Ctx, n: O2FNode): SceneNode {
  const node = n.type === 'ELLIPSE' ? figma.createEllipse() : figma.createRectangle();
  node.name = n.name;
  node.resizeWithoutConstraints(Math.max(0.01, n.width), Math.max(0.01, n.height));
  applyGeometryStyle(ctx, node, n);
  return node;
}

function buildSvg(ctx: Ctx, n: O2FNode & { svg: string }): SceneNode {
  let node: SceneNode;
  try {
    node = figma.createNodeFromSvg(n.svg);
  } catch (err) {
    ctx.report.warnings.push(`svg "${n.name}" could not be parsed (${(err as Error).message}); placeholder used`);
    node = figma.createRectangle();
    (node as RectangleNode).fills = [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }];
  }
  node.name = n.name;
  if (n.width > 0 && n.height > 0 && 'resize' in node) {
    (node as FrameNode).resize(Math.max(0.01, n.width), Math.max(0.01, n.height));
  }
  node.opacity = n.opacity;
  if (node.type === 'FRAME') {
    node.clipsContent = false;
    node.fills = [];
  }
  return node;
}

// ---------------------------------------------------------------------------
// paint
// ---------------------------------------------------------------------------

type Styled = SceneNode & GeometryMixin & CornerMixin & RectangleCornerMixin & BlendMixin & MinimalStrokesMixin & IndividualStrokesMixin;

function applyGeometryStyle(ctx: Ctx, node: SceneNode, n: O2FNode): void {
  const s = node as Styled;
  s.opacity = n.opacity;
  s.visible = n.visible;
  s.fills = toPaints(ctx, n.fills, n.width, n.height);
  if (n.strokes.length) applyStroke(ctx, s, n.strokes[0]);
  if (n.cornerRadius && 'topLeftRadius' in s) {
    s.topLeftRadius = n.cornerRadius.topLeft;
    s.topRightRadius = n.cornerRadius.topRight;
    s.bottomRightRadius = n.cornerRadius.bottomRight;
    s.bottomLeftRadius = n.cornerRadius.bottomLeft;
  }
  if (n.effects.length) s.effects = toEffects(n.effects);
}

function applyStroke(ctx: Ctx, node: Styled, stroke: Stroke): void {
  let paint: SolidPaint = { type: 'SOLID', color: { r: stroke.color.r, g: stroke.color.g, b: stroke.color.b }, opacity: stroke.color.a };
  const v = stroke.token ? ctx.variables.get(stroke.token) : undefined;
  if (v) paint = figma.variables.setBoundVariableForPaint(paint, 'color', v) as SolidPaint;
  node.strokes = [paint];
  node.strokeAlign = stroke.align;
  if (stroke.sides && 'strokeTopWeight' in node) {
    node.strokeTopWeight = stroke.sides.top;
    node.strokeRightWeight = stroke.sides.right;
    node.strokeBottomWeight = stroke.sides.bottom;
    node.strokeLeftWeight = stroke.sides.left;
  } else {
    node.strokeWeight = stroke.weight;
  }
  if (stroke.dash) node.dashPattern = stroke.dash;
}

export function toPaints(ctx: Pick<Ctx, 'images' | 'variables'>, fills: Fill[], width: number, height: number): Paint[] {
  const out: Paint[] = [];
  for (const f of fills) {
    if (f.type === 'SOLID') {
      let paint: SolidPaint = { type: 'SOLID', color: { r: f.color.r, g: f.color.g, b: f.color.b }, opacity: f.color.a };
      const v = f.token ? ctx.variables.get(f.token) : undefined;
      if (v) paint = figma.variables.setBoundVariableForPaint(paint, 'color', v) as SolidPaint;
      out.push(paint);
    } else if (f.type === 'GRADIENT_LINEAR') {
      out.push({
        type: 'GRADIENT_LINEAR',
        gradientStops: f.stops.map((s) => ({ position: s.position, color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a } })),
        gradientTransform: gradientTransform(f.angle, width, height),
      });
    } else if (f.type === 'IMAGE') {
      const hash = ctx.images.get(f.asset);
      if (hash) out.push({ type: 'IMAGE', imageHash: hash, scaleMode: f.scaleMode });
      else out.push({ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } });
    }
  }
  return out;
}

/**
 * CSS linear-gradient angle to Figma's gradientTransform. CSS draws the
 * gradient line through the centre, long enough to reach the corners; Figma's
 * transform maps node space (unit square) into gradient space where the
 * gradient runs from x=0 to x=1.
 */
export function gradientTransform(angleDeg: number, width: number, height: number): Transform {
  const w = Math.max(width, 0.01);
  const h = Math.max(height, 0.01);
  const a = (angleDeg * Math.PI) / 180;
  const dirX = Math.sin(a);
  const dirY = -Math.cos(a);
  const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  const p0 = { x: (w / 2 - (dirX * len) / 2) / w, y: (h / 2 - (dirY * len) / 2) / h };
  const p1 = { x: (w / 2 + (dirX * len) / 2) / w, y: (h / 2 + (dirY * len) / 2) / h };
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const det = dx * dx + dy * dy || 1;
  return [
    [dx / det, dy / det, -(dx * p0.x + dy * p0.y) / det],
    [-dy / det, dx / det, (dy * p0.x - dx * p0.y) / det],
  ];
}

export function toEffects(effects: Effect[]): Effect_[] {
  const out: Effect_[] = [];
  for (const e of effects) {
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push({
        type: e.type,
        color: { r: e.color.r, g: e.color.g, b: e.color.b, a: e.color.a },
        offset: e.offset,
        radius: e.radius,
        spread: e.spread,
        visible: true,
        blendMode: 'NORMAL',
      } as DropShadowEffect);
    } else {
      out.push({ type: e.type, radius: e.radius, visible: true, blurType: 'NORMAL' } as BlurEffect);
    }
  }
  return out;
}

type Effect_ = globalThis.Effect;
export { isFrame };
