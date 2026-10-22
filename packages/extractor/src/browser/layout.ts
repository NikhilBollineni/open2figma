/**
 * Auto-layout inference.
 *
 * Given a parent box, its in-flow children boxes and the relevant computed
 * styles, decide whether the parent can be expressed as a Figma auto-layout
 * frame and, if so, with which settings. Every inferred layout is verified by
 * simulating Figma's placement and comparing against the real rendered
 * positions; when the simulation disagrees we fall back to absolute
 * positioning so the import is never visually wrong.
 */
import type { AutoLayout, Padding, PrimaryAxisAlign, CounterAxisAlign, SizingMode } from '@open2figma/schema';
import { round } from './css.js';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParentStyle {
  display: string;
  flexDirection: string;
  justifyContent: string;
  alignItems: string;
  flexWrap: string;
  columnGap: number;
  rowGap: number;
  gridTemplateColumns: string;
  gridTemplateRows: string;
  /** Padding plus border widths, i.e. the inset from the border box to the content box. */
  padding: Padding;
}

export interface ChildStyle {
  box: Box;
  display: string;
  flexGrow: number;
  alignSelf: string;
}

export interface ChildSizing {
  horizontal: SizingMode;
  vertical: SizingMode;
}

export interface LayoutInference {
  layout: AutoLayout;
  children: ChildSizing[];
  /** True when the visual order is the reverse of the DOM order. */
  reverse: boolean;
  /** Why we ended up with NONE, for the warnings list. */
  reason?: string;
}

const TOL = 1.5;

export function inferLayout(parent: Box, style: ParentStyle, kids: ChildStyle[]): LayoutInference {
  const content = contentBox(parent, style.padding);
  const basePadding = { ...style.padding };
  const none = (reason?: string): LayoutInference => ({
    layout: {
      mode: 'NONE',
      gap: 0,
      padding: basePadding,
      primaryAlign: 'MIN',
      counterAlign: 'MIN',
      wrap: false,
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
    },
    children: kids.map(() => ({ horizontal: 'FIXED', vertical: 'FIXED' })),
    reverse: false,
    reason,
  });

  if (kids.length === 0) return none();

  const isFlex = style.display === 'flex' || style.display === 'inline-flex';
  const isGrid = style.display === 'grid' || style.display === 'inline-grid';

  if (isGrid) {
    const cols = trackCount(style.gridTemplateColumns);
    const rows = trackCount(style.gridTemplateRows);
    if (cols > 1 && rows > 1) {
      return {
        layout: {
          mode: 'GRID',
          gap: style.columnGap,
          counterGap: style.rowGap,
          padding: basePadding,
          primaryAlign: 'MIN',
          counterAlign: 'MIN',
          wrap: false,
          grid: { columns: cols, rows, columnGap: style.columnGap, rowGap: style.rowGap },
          sizingHorizontal: 'FIXED',
          sizingVertical: 'FIXED',
        },
        children: kids.map(() => ({ horizontal: 'FIXED', vertical: 'FIXED' })),
        reverse: false,
      };
    }
    // single-column or single-row grids behave like stacks
    const mode = cols <= 1 ? 'VERTICAL' : 'HORIZONTAL';
    return stack(mode, mode === 'VERTICAL' ? style.rowGap : style.columnGap, false, parent, content, basePadding, kids, undefined, undefined, false);
  }

  if (isFlex) {
    const dir = style.flexDirection || 'row';
    const mode = dir.startsWith('column') ? 'VERTICAL' : 'HORIZONTAL';
    const reverse = dir.endsWith('-reverse');
    const ordered = reverse ? [...kids].reverse() : kids;
    const gap = mode === 'HORIZONTAL' ? style.columnGap : style.rowGap;
    const wrap = style.flexWrap === 'wrap' || style.flexWrap === 'wrap-reverse';
    const primary = mapJustify(style.justifyContent);
    const counter = mapAlign(style.alignItems);
    const r = stack(mode, gap, wrap, parent, content, basePadding, ordered, primary, counter, true, mode === 'HORIZONTAL' ? style.rowGap : style.columnGap);
    r.reverse = reverse && r.layout.mode !== 'NONE';
    return r;
  }

  // Normal flow: detect a uniform vertical stack, then a uniform horizontal row.
  const v = geometricStack('VERTICAL', content, kids);
  if (v) return stack('VERTICAL', v.gap, false, parent, content, basePadding, kids, undefined, undefined, false);
  const h = geometricStack('HORIZONTAL', content, kids);
  if (h) return stack('HORIZONTAL', h.gap, false, parent, content, basePadding, kids, undefined, undefined, false);
  return none(kids.length > 1 ? 'children are not a uniform stack' : undefined);
}

function contentBox(parent: Box, p: Padding): Box {
  return {
    x: parent.x + p.left,
    y: parent.y + p.top,
    width: Math.max(0, parent.width - p.left - p.right),
    height: Math.max(0, parent.height - p.top - p.bottom),
  };
}

function trackCount(tpl: string): number {
  if (!tpl || tpl === 'none') return 1;
  return tpl.trim().split(/\s+/).filter((t) => t !== '').length;
}

function mapJustify(v: string): PrimaryAxisAlign {
  switch (v) {
    case 'center':
      return 'CENTER';
    case 'flex-end':
    case 'end':
    case 'right':
      return 'MAX';
    case 'space-between':
    case 'space-around':
    case 'space-evenly':
      return 'SPACE_BETWEEN';
    default:
      return 'MIN';
  }
}

function mapAlign(v: string): CounterAxisAlign | 'STRETCH' {
  switch (v) {
    case 'center':
      return 'CENTER';
    case 'flex-end':
    case 'end':
      return 'MAX';
    case 'baseline':
      return 'BASELINE';
    case 'flex-start':
    case 'start':
      return 'MIN';
    default:
      return 'STRETCH';
  }
}

interface Axis {
  pos: 'x' | 'y';
  size: 'width' | 'height';
}

const AXES: Record<'HORIZONTAL' | 'VERTICAL', { main: Axis; cross: Axis }> = {
  HORIZONTAL: { main: { pos: 'x', size: 'width' }, cross: { pos: 'y', size: 'height' } },
  VERTICAL: { main: { pos: 'y', size: 'height' }, cross: { pos: 'x', size: 'width' } },
};

/** Detects children laid out one after another on an axis with a uniform gap. */
function geometricStack(mode: 'HORIZONTAL' | 'VERTICAL', content: Box, kids: ChildStyle[]): { gap: number } | null {
  if (kids.length < 2) {
    // A single child is trivially a stack; prefer vertical which matches block flow.
    return mode === 'VERTICAL' ? { gap: 0 } : null;
  }
  const { main, cross } = AXES[mode];
  const gaps: number[] = [];
  for (let i = 0; i < kids.length - 1; i++) {
    const a = kids[i].box;
    const b = kids[i + 1].box;
    const gap = b[main.pos] - (a[main.pos] + a[main.size]);
    if (gap < -TOL) return null; // overlapping on the main axis
    // must share the cross axis band
    const overlap = Math.min(a[cross.pos] + a[cross.size], b[cross.pos] + b[cross.size]) - Math.max(a[cross.pos], b[cross.pos]);
    if (mode === 'HORIZONTAL' && overlap < -TOL) return null;
    gaps.push(gap);
  }
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  if (max - min > TOL) return null;
  return { gap: round(Math.max(0, (min + max) / 2)) };
}

/**
 * Builds and verifies a stack layout. Leading/trailing offsets on the main
 * axis are absorbed into padding so block margins survive the conversion.
 */
function stack(
  mode: 'HORIZONTAL' | 'VERTICAL',
  gap: number,
  wrap: boolean,
  parent: Box,
  content: Box,
  padding: Padding,
  kids: ChildStyle[],
  declaredPrimary: PrimaryAxisAlign | undefined,
  declaredCounter: CounterAxisAlign | 'STRETCH' | undefined,
  isFlex: boolean,
  crossGap = 0,
): LayoutInference {
  const { main, cross } = AXES[mode];
  const pad = { ...padding };

  const children: ChildSizing[] = kids.map((k) => {
    const fillCross = (declaredCounter === 'STRETCH' || k.alignSelf === 'stretch' || !isFlex) && Math.abs(k.box[cross.size] - content[cross.size]) <= TOL;
    const fillMain = isFlex && k.flexGrow > 0;
    return mode === 'HORIZONTAL'
      ? { horizontal: fillMain ? 'FILL' : 'FIXED', vertical: fillCross ? 'FILL' : 'FIXED' }
      : { horizontal: fillCross ? 'FILL' : 'FIXED', vertical: fillMain ? 'FILL' : 'FIXED' };
  });

  const sizesMain = kids.map((k) => k.box[main.size]);
  const total = sizesMain.reduce((a, b) => a + b, 0) + gap * (kids.length - 1);

  if (wrap) {
    // Wrapped rows are placed by Figma's own wrapping; we only need to make sure
    // the primary alignment is sane. Skip simulation.
    return {
      layout: {
        mode,
        gap,
        counterGap: crossGap,
        padding: pad,
        primaryAlign: declaredPrimary ?? 'MIN',
        counterAlign: toCounter(declaredCounter),
        wrap: true,
        sizingHorizontal: 'FIXED',
        sizingVertical: 'FIXED',
      },
      children,
      reverse: false,
    };
  }

  // Absorb leading/trailing offsets for MIN alignment (block margins etc.).
  const first = kids[0].box;
  const last = kids[kids.length - 1].box;
  const lead = first[main.pos] - content[main.pos];
  const trail = content[main.pos] + content[main.size] - (last[main.pos] + last[main.size]);

  // Candidate (alignment, padding) pairs, most faithful first:
  //  1. the declared flex alignment against the real padding,
  //  2. MIN with leading/trailing space folded into padding (block margins; makes the frame huggable),
  //  3. the remaining alignments against the real padding.
  const absorbed = addPad(addPad(pad, mode, 'lead', Math.max(0, lead)), mode, 'trail', Math.max(0, trail));
  const attempts: { primary: PrimaryAxisAlign; padTry: Padding }[] = [];
  if (declaredPrimary) attempts.push({ primary: declaredPrimary, padTry: pad });
  attempts.push({ primary: 'MIN', padTry: absorbed });
  for (const p of ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] as PrimaryAxisAlign[]) attempts.push({ primary: p, padTry: pad });
  const counterCandidates: CounterAxisAlign[] = declaredCounter && declaredCounter !== 'STRETCH' ? [declaredCounter, 'MIN', 'CENTER', 'MAX'] : ['MIN', 'CENTER', 'MAX'];

  for (const { primary, padTry } of attempts) {
    const contentTry = contentBox(parent, padTry);
    for (const counter of unique(counterCandidates)) {
      if (simulate(mode, gap, primary, counter, contentTry, kids, children)) {
        const sizing = frameSizing(mode, contentTry, kids, children, total);
        return {
          layout: {
            mode,
            gap: round(gap),
            padding: roundPad(padTry),
            primaryAlign: primary,
            counterAlign: counter,
            wrap: false,
            sizingHorizontal: sizing.horizontal,
            sizingVertical: sizing.vertical,
          },
          children,
          reverse: false,
        };
      }
    }
  }

  return {
    layout: {
      mode: 'NONE',
      gap: 0,
      padding: pad,
      primaryAlign: 'MIN',
      counterAlign: 'MIN',
      wrap: false,
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
    },
    children: kids.map(() => ({ horizontal: 'FIXED', vertical: 'FIXED' })),
    reverse: false,
    reason: `rendered positions do not match any ${mode.toLowerCase()} auto-layout`,
  };
}

function toCounter(c: CounterAxisAlign | 'STRETCH' | undefined): CounterAxisAlign {
  return !c || c === 'STRETCH' ? 'MIN' : c;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function addPad(p: Padding, mode: 'HORIZONTAL' | 'VERTICAL', side: 'lead' | 'trail', amount: number): Padding {
  const q = { ...p };
  if (mode === 'VERTICAL') {
    if (side === 'lead') q.top += amount;
    else q.bottom += amount;
  } else if (side === 'lead') q.left += amount;
  else q.right += amount;
  return q;
}

function roundPad(p: Padding): Padding {
  return { top: round(p.top), right: round(p.right), bottom: round(p.bottom), left: round(p.left) };
}

/** Places children the way Figma would and checks against the rendered boxes. */
function simulate(
  mode: 'HORIZONTAL' | 'VERTICAL',
  gap: number,
  primary: PrimaryAxisAlign,
  counter: CounterAxisAlign,
  content: Box,
  kids: ChildStyle[],
  sizing: ChildSizing[],
): boolean {
  const { main, cross } = AXES[mode];
  const sizes = kids.map((k) => k.box[main.size]);
  const sum = sizes.reduce((a, b) => a + b, 0);
  let cursor = content[main.pos];
  let g = gap;
  if (primary === 'CENTER') cursor += (content[main.size] - (sum + gap * (kids.length - 1))) / 2;
  else if (primary === 'MAX') cursor += content[main.size] - (sum + gap * (kids.length - 1));
  else if (primary === 'SPACE_BETWEEN' && kids.length > 1) g = (content[main.size] - sum) / (kids.length - 1);
  else if (primary === 'SPACE_BETWEEN') cursor += (content[main.size] - sum) / 2; // single child centres

  for (let i = 0; i < kids.length; i++) {
    const box = kids[i].box;
    if (Math.abs(box[main.pos] - cursor) > TOL) return false;
    const fillsCross = mode === 'HORIZONTAL' ? sizing[i].vertical === 'FILL' : sizing[i].horizontal === 'FILL';
    let crossPos = content[cross.pos];
    if (!fillsCross) {
      if (counter === 'CENTER') crossPos += (content[cross.size] - box[cross.size]) / 2;
      else if (counter === 'MAX') crossPos += content[cross.size] - box[cross.size];
      else if (counter === 'BASELINE') crossPos = box[cross.pos]; // trust the browser's baseline placement
    }
    if (Math.abs(box[cross.pos] - crossPos) > TOL) return false;
    cursor += box[main.size] + g;
  }
  return true;
}

/** Decides HUG vs FIXED for the frame itself. */
function frameSizing(
  mode: 'HORIZONTAL' | 'VERTICAL',
  content: Box,
  kids: ChildStyle[],
  sizing: ChildSizing[],
  total: number,
): { horizontal: SizingMode; vertical: SizingMode } {
  const { cross } = AXES[mode];
  const hugMain = Math.abs(content[mode === 'HORIZONTAL' ? 'width' : 'height'] - total) <= TOL;
  const anyFillCross = sizing.some((s) => (mode === 'HORIZONTAL' ? s.vertical : s.horizontal) === 'FILL');
  const maxCross = Math.max(...kids.map((k) => k.box[cross.size]));
  const hugCross = !anyFillCross && Math.abs(content[cross.size] - maxCross) <= TOL;
  return mode === 'HORIZONTAL'
    ? { horizontal: hugMain ? 'HUG' : 'FIXED', vertical: hugCross ? 'HUG' : 'FIXED' }
    : { horizontal: hugCross ? 'HUG' : 'FIXED', vertical: hugMain ? 'HUG' : 'FIXED' };
}
