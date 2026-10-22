/**
 * O2F (open2figma) document format.
 *
 * This is the contract between the extractor (which runs a real browser and
 * walks the rendered DOM) and the Figma plugin (which turns the tree into
 * native Figma nodes). It is deliberately Figma-shaped so the plugin side is
 * mostly a 1:1 mapping, and deliberately free of any DOM concepts so other
 * sources (Storybook, React Native, Sketch, design tokens) can target it too.
 */

export const O2F_VERSION = 1 as const;

export interface RGBA {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
  a: number; // 0..1
}

export interface SolidFill {
  type: 'SOLID';
  color: RGBA;
  /** Reference to a token in `document.tokens` when the color came from a CSS variable. */
  token?: string;
}

export interface GradientStop {
  position: number; // 0..1
  color: RGBA;
}

export interface GradientFill {
  type: 'GRADIENT_LINEAR';
  /** Angle in degrees, CSS convention (0 = to top, 90 = to right). */
  angle: number;
  stops: GradientStop[];
}

export interface ImageFill {
  type: 'IMAGE';
  /** Key into `document.assets`. */
  asset: string;
  scaleMode: 'FILL' | 'FIT' | 'TILE' | 'CROP';
}

export type Fill = SolidFill | GradientFill | ImageFill;

export interface Stroke {
  color: RGBA;
  weight: number;
  align: 'INSIDE' | 'CENTER' | 'OUTSIDE';
  /** Per-side weights when the CSS border is not uniform. */
  sides?: { top: number; right: number; bottom: number; left: number };
  dash?: number[];
  token?: string;
}

export interface ShadowEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: RGBA;
  offset: { x: number; y: number };
  radius: number;
  spread: number;
}

export interface BlurEffect {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
}

export type Effect = ShadowEffect | BlurEffect;

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type LayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
export type PrimaryAxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
export type CounterAxisAlign = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';
export type SizingMode = 'FIXED' | 'HUG' | 'FILL';

export interface AutoLayout {
  mode: LayoutMode;
  gap: number;
  /** Gap on the cross axis when wrapping. */
  counterGap?: number;
  padding: Padding;
  primaryAlign: PrimaryAxisAlign;
  counterAlign: CounterAxisAlign;
  wrap: boolean;
  /** Only for mode GRID: CSS grid geometry mapped onto Figma grid auto-layout. */
  grid?: { columns: number; rows: number; columnGap: number; rowGap: number };
  /** How this frame sizes itself on each axis. */
  sizingHorizontal: SizingMode;
  sizingVertical: SizingMode;
}

export interface CornerRadius {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

export type TextAlign = 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
export type TextCase = 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
export type TextDecoration = 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';

export interface TextStyle {
  fontFamily: string;
  /** Resolved fallback chain, first entry is `fontFamily`. */
  fontStack: string[];
  fontSize: number;
  fontWeight: number; // 100..900
  italic: boolean;
  /** Pixels. `undefined` means "auto". */
  lineHeight?: number;
  letterSpacing: number; // px
  textAlign: TextAlign;
  textCase: TextCase;
  textDecoration: TextDecoration;
  color: RGBA;
  colorToken?: string;
}

/** A run of characters with a single style. One TEXT node holds one or more runs. */
export interface TextRun {
  characters: string;
  style: TextStyle;
}

export interface NodeBase {
  id: string;
  name: string;
  /** Position relative to the parent's top-left, in CSS pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
  fills: Fill[];
  strokes: Stroke[];
  effects: Effect[];
  cornerRadius?: CornerRadius;
  /**
   * How this node participates in its parent's auto-layout.
   * `absolute` nodes keep x/y even inside an auto-layout parent
   * (CSS position: absolute / fixed, or elements pulled out of flow).
   */
  positioning: 'AUTO' | 'ABSOLUTE';
  /** Sizing inside an auto-layout parent. */
  sizingHorizontal: SizingMode;
  sizingVertical: SizingMode;
  /** Source information, kept for naming, debugging and component matching. */
  meta: {
    tag?: string;
    classes?: string[];
    role?: string;
    /** Structural fingerprint; equal across nodes that should become instances of one component. */
    fingerprint?: string;
    /** Set on nodes that have been identified as repeated components. */
    componentKey?: string;
    /** Test id, aria-label or similar stable identifier if present. */
    testId?: string;
    href?: string;
  };
}

export interface FrameNode extends NodeBase {
  type: 'FRAME';
  layout: AutoLayout;
  clipsContent: boolean;
  children: O2FNode[];
}

export interface TextNode extends NodeBase {
  type: 'TEXT';
  runs: TextRun[];
  /** Whether the width is fixed (wrapping) or hugs the content. */
  autoResize: 'WIDTH_AND_HEIGHT' | 'HEIGHT' | 'NONE';
  /** Vertical placement of the text within a fixed-height box. */
  verticalAlign: 'TOP' | 'CENTER' | 'BOTTOM';
  /** Set when CSS truncates the text with an ellipsis. */
  truncation?: 'ENDING';
  /** From -webkit-line-clamp. */
  maxLines?: number;
}

export interface RectangleNode extends NodeBase {
  type: 'RECTANGLE';
}

export interface EllipseNode extends NodeBase {
  type: 'ELLIPSE';
}

export interface VectorNode extends NodeBase {
  type: 'SVG';
  /** Serialized, self-contained SVG markup. */
  svg: string;
}

export type O2FNode = FrameNode | TextNode | RectangleNode | EllipseNode | VectorNode;

export interface Asset {
  /** Media type, e.g. image/png. */
  mime: string;
  /** Base64 payload (no data: prefix). */
  data: string;
  width?: number;
  height?: number;
  source?: string;
}

export type TokenType = 'COLOR' | 'FLOAT' | 'STRING';

export interface Token {
  name: string;
  type: TokenType;
  value: RGBA | number | string;
  /** Raw CSS value as authored. */
  raw: string;
}

export interface FontUsage {
  family: string;
  weights: number[];
  italic: boolean;
}

export interface Breakpoint {
  name: string;
  width: number;
  height: number;
  root: FrameNode;
}

export interface O2FDocument {
  version: typeof O2F_VERSION;
  generator: string;
  createdAt: string;
  source: {
    url?: string;
    title?: string;
  };
  /** One captured frame per viewport. The first is the primary. */
  breakpoints: Breakpoint[];
  /** Components identified by fingerprint. The plugin builds a main component for each. */
  components: Record<string, { name: string; count: number }>;
  assets: Record<string, Asset>;
  tokens: Token[];
  fonts: FontUsage[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers shared by both sides
// ---------------------------------------------------------------------------

export function isFrame(n: O2FNode): n is FrameNode {
  return n.type === 'FRAME';
}

export function isText(n: O2FNode): n is TextNode {
  return n.type === 'TEXT';
}

export function walk(node: O2FNode, fn: (n: O2FNode, depth: number, parent?: FrameNode) => void, depth = 0, parent?: FrameNode): void {
  fn(node, depth, parent);
  if (isFrame(node)) {
    for (const child of node.children) walk(child, fn, depth + 1, node);
  }
}

export function countNodes(node: O2FNode): number {
  let n = 0;
  walk(node, () => n++);
  return n;
}

/**
 * Lightweight structural validation. Returns a list of problems; empty means valid.
 * We avoid a JSON-schema dependency so this can run inside the Figma plugin sandbox.
 */
export function validateDocument(doc: unknown): string[] {
  const problems: string[] = [];
  if (!doc || typeof doc !== 'object') return ['document is not an object'];
  const d = doc as Partial<O2FDocument>;
  if (d.version !== O2F_VERSION) problems.push(`unsupported version ${String(d.version)}, expected ${O2F_VERSION}`);
  if (!Array.isArray(d.breakpoints) || d.breakpoints.length === 0) problems.push('breakpoints must be a non-empty array');
  else {
    d.breakpoints.forEach((bp, i) => {
      if (!bp || typeof bp !== 'object') return problems.push(`breakpoints[${i}] is not an object`);
      if (!bp.root || bp.root.type !== 'FRAME') problems.push(`breakpoints[${i}].root must be a FRAME`);
      else walk(bp.root, (n) => validateNode(n, problems));
    });
  }
  if (d.assets && typeof d.assets !== 'object') problems.push('assets must be an object');
  if (d.tokens && !Array.isArray(d.tokens)) problems.push('tokens must be an array');
  return problems;
}

function validateNode(n: O2FNode, problems: string[]): void {
  const where = `node ${n.id ?? '?'} (${n.name ?? '?'})`;
  if (typeof n.id !== 'string') problems.push(`${where}: id must be a string`);
  if (!['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'SVG'].includes(n.type)) problems.push(`${where}: unknown type ${String((n as { type: unknown }).type)}`);
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (typeof n[k] !== 'number' || !Number.isFinite(n[k])) problems.push(`${where}: ${k} must be a finite number`);
  }
  if (n.width < 0 || n.height < 0) problems.push(`${where}: negative size`);
  if (n.type === 'FRAME') {
    if (!n.layout) problems.push(`${where}: frame missing layout`);
    if (!Array.isArray(n.children)) problems.push(`${where}: frame missing children`);
  }
  if (n.type === 'TEXT') {
    if (!Array.isArray(n.runs) || n.runs.length === 0) problems.push(`${where}: text node has no runs`);
  }
  if (n.type === 'SVG' && typeof n.svg !== 'string') problems.push(`${where}: svg node missing markup`);
}

// ---------------------------------------------------------------------------
// Node factories (used by extractor and tests)
// ---------------------------------------------------------------------------

export const defaultPadding = (): Padding => ({ top: 0, right: 0, bottom: 0, left: 0 });

export const noLayout = (): AutoLayout => ({
  mode: 'NONE',
  gap: 0,
  padding: defaultPadding(),
  primaryAlign: 'MIN',
  counterAlign: 'MIN',
  wrap: false,
  sizingHorizontal: 'FIXED',
  sizingVertical: 'FIXED',
});

export function baseNode(partial: Partial<NodeBase> & Pick<NodeBase, 'id' | 'name'>): NodeBase {
  return {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    opacity: 1,
    visible: true,
    fills: [],
    strokes: [],
    effects: [],
    positioning: 'AUTO',
    sizingHorizontal: 'FIXED',
    sizingVertical: 'FIXED',
    meta: {},
    ...partial,
  };
}

export function makeFrame(partial: Partial<FrameNode> & Pick<NodeBase, 'id' | 'name'>): FrameNode {
  return {
    ...baseNode(partial),
    type: 'FRAME',
    layout: partial.layout ?? noLayout(),
    clipsContent: partial.clipsContent ?? false,
    children: partial.children ?? [],
  };
}
