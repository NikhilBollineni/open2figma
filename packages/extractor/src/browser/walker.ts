/**
 * In-page DOM walker. Bundled to an IIFE and injected by the capture driver.
 * Everything here runs inside the browser, so no Node imports.
 */
import type {
  O2FNode, FrameNode, TextNode, TextRun, TextStyle, Fill, Stroke, Effect, Asset, Token, FontUsage,
  RGBA, SizingMode, CornerRadius, Padding,
} from '@open2figma/schema';
import {
  parseColor, isVisibleColor, colorsEqual, parseLinearGradient, parseBoxShadow, parseBlur, parseRadius,
  parsePadding, parseFontFamily, parseFontWeight, splitTopLevel, px, round,
} from './css.js';
import { inferLayout, type Box, type ChildStyle } from './layout.js';

export interface ExtractOptions {
  rootSelector?: string;
  includeHidden?: boolean;
  inlineImages?: boolean;
  maxNodes?: number;
}

export interface RawExtract {
  root: FrameNode;
  assets: Record<string, Asset>;
  tokens: Token[];
  fonts: FontUsage[];
  warnings: string[];
  title: string;
  url: string;
  width: number;
  height: number;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'OPTION', 'OPTGROUP', 'AREA', 'MAP', 'PARAM', 'SOURCE', 'TRACK']);
const tagOf = (el: Element): string => el.tagName.toUpperCase();
const REPLACED = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'IFRAME', 'EMBED', 'OBJECT', 'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'PICTURE', 'AUDIO', 'PROGRESS', 'METER']);

/**
 * Modern sites (Tailwind v4, shadcn) author colours in oklch()/lab()/display-p3 and
 * Chrome keeps that syntax in computed styles. A 2D canvas converts any CSS colour
 * to sRGB for us, with gamut clipping, so we only hand-parse the common rgb() form.
 */
let colorCtx: CanvasRenderingContext2D | null | undefined;
const colorCache = new Map<string, RGBA | null>();
function toColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const direct = parseColor(input);
  if (direct) return direct;
  const cached = colorCache.get(input);
  if (cached !== undefined) return cached;
  if (colorCtx === undefined) colorCtx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  let out: RGBA | null = null;
  if (colorCtx) {
    colorCtx.fillStyle = '#000';
    colorCtx.fillStyle = input;
    const normalised = String(colorCtx.fillStyle);
    out = normalised !== '#000000' || /^(#000|black|rgb\(0,? 0,? 0\))/i.test(input.trim()) ? parseColor(normalised) : null;
    if (!out && colorCtx.fillStyle !== '#000000') out = parseColor(normalised);
    if (!out) {
      // canvas rejected it: draw one pixel and read it back
      colorCtx.clearRect(0, 0, 1, 1);
      colorCtx.fillStyle = input;
      colorCtx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
      out = a === 0 && !/transparent|\/\s*0\s*\)|,\s*0\s*\)$/.test(input) ? null : { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
    }
  }
  colorCache.set(input, out);
  return out;
}

class Walker {
  private idCounter = 0;
  private nodeCount = 0;
  private assets: Record<string, Asset> = {};
  private assetKeys = new Map<string, string>();
  private pending: Promise<void>[] = [];
  private fonts = new Map<string, FontUsage>();
  private warnings: string[] = [];
  private warnCounts = new Map<string, number>();
  private tokens: Token[] = [];
  private docWidth = 0;
  private docHeight = 0;

  constructor(private opts: Required<ExtractOptions>) {}

  async run(): Promise<RawExtract> {
    const docEl = document.documentElement;
    this.docWidth = Math.max(docEl.scrollWidth, window.innerWidth);
    this.docHeight = Math.max(docEl.scrollHeight, window.innerHeight);
    this.collectTokens();

    const rootEl = this.opts.rootSelector ? document.querySelector(this.opts.rootSelector) : document.body;
    if (!rootEl) throw new Error(`root selector "${this.opts.rootSelector}" matched nothing`);

    const root = this.buildRoot(rootEl);
    await Promise.all(this.pending);
    this.flushWarnCounts();
    return {
      root,
      assets: this.assets,
      tokens: this.tokens,
      fonts: [...this.fonts.values()],
      warnings: this.warnings,
      title: document.title,
      url: location.href,
      width: root.width,
      height: root.height,
    };
  }

  // ---------------------------------------------------------------------
  // Root
  // ---------------------------------------------------------------------

  private buildRoot(rootEl: Element): FrameNode {
    const isBody = rootEl === document.body;
    const cs = getComputedStyle(rootEl);
    const box: Box = isBody
      ? { x: 0, y: 0, width: this.docWidth, height: this.docHeight }
      : this.absRect(rootEl);
    const frame = this.frameFrom(rootEl, cs, box, { x: 0, y: 0 }, true);
    frame.x = 0;
    frame.y = 0;
    frame.name = document.title || (isBody ? 'Page' : this.nameFor(rootEl, cs));
    frame.clipsContent = true;
    frame.positioning = 'AUTO';
    if (isBody) {
      // CSS propagates the body background to the canvas; mirror that, default white.
      const htmlBg = toColor(getComputedStyle(document.documentElement).backgroundColor);
      if (!frame.fills.length) {
        if (isVisibleColor(htmlBg)) frame.fills.push({ type: 'SOLID', color: htmlBg });
        else frame.fills.push({ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } });
      }
      // body margin becomes root padding so children positions stay exact
      const pad = frame.layout.padding;
      frame.layout.padding = {
        top: pad.top + px(cs.marginTop), right: pad.right + px(cs.marginRight),
        bottom: pad.bottom + px(cs.marginBottom), left: pad.left + px(cs.marginLeft),
      };
    }
    // Walk children against the full document box.
    this.applyLayout(frame, rootEl, cs, box, frame.layout.padding);
    return frame;
  }

  // ---------------------------------------------------------------------
  // Visiting
  // ---------------------------------------------------------------------

  private absRect(el: Element): Box {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }

  /** Returns the element's in-flow/absolute children as O2F nodes plus the styles layout inference needs. */
  private collectChildren(el: Element, parentAbs: { x: number; y: number }, parentCs: CSSStyleDeclaration): { node: O2FNode; style: ChildStyle; z: number }[] {
    const out: { node: O2FNode; style: ChildStyle; z: number }[] = [];
    for (const kid of this.childNodesOf(el)) {
      if (this.nodeCount >= this.opts.maxNodes) {
        this.countWarn('node limit reached; remaining elements skipped');
        break;
      }
      if (kid.nodeType === Node.TEXT_NODE) {
        const entry = this.bareText(kid, parentCs, parentAbs);
        if (entry) out.push(entry);
        continue;
      }
      const child = kid as Element;
      const cs = getComputedStyle(child);
      if (cs.display === 'contents') {
        out.push(...this.collectChildren(child, parentAbs, cs));
        continue;
      }
      const node = this.visit(child, cs, parentAbs);
      if (!node) continue;
      const box = this.absRect(child);
      const positioned = cs.position !== 'static';
      const z = positioned && cs.zIndex !== 'auto' ? parseInt(cs.zIndex, 10) || 0 : 0;
      out.push({
        node,
        style: { box, display: cs.display, flexGrow: parseFloat(cs.flexGrow) || 0, alignSelf: cs.alignSelf },
        z,
      });
    }
    // Stable sort by z-index so stacking survives; DOM order otherwise.
    return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.z - b.e.z || a.i - b.i).map(({ e }) => e);
  }

  /** Element children plus non-blank text nodes, looking through shadow roots and slots. */
  private childNodesOf(el: Element): Node[] {
    const host = el as HTMLElement & { shadowRoot?: ShadowRoot | null };
    const raw: Node[] = tagOf(el) === 'SLOT'
      ? (el as HTMLSlotElement).assignedNodes({ flatten: true })
      : Array.from((host.shadowRoot ?? el).childNodes);
    return raw.filter((n) => {
      if (n.nodeType === Node.ELEMENT_NODE) return !SKIP_TAGS.has(tagOf(n as Element));
      if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').trim().length > 0;
      return false;
    });
  }

  private childElements(el: Element): Element[] {
    return this.childNodesOf(el).filter((n) => n.nodeType === Node.ELEMENT_NODE) as Element[];
  }

  /** A text node sitting next to element siblings: an anonymous box that takes part in the parent's layout. */
  private bareText(n: Node, cs: CSSStyleDeclaration, parentAbs: { x: number; y: number }): { node: O2FNode; style: ChildStyle; z: number } | null {
    const pre = cs.whiteSpace.startsWith('pre');
    const text = pre ? (n.textContent ?? '') : (n.textContent ?? '').replace(/[\t\n\r ]+/g, ' ').trim();
    if (!text) return null;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const style = this.textStyle(cs);
    this.noteFont(style);
    const box: Box = { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
    this.nodeCount++;
    const node: TextNode = {
      id: this.nextId(),
      name: text.slice(0, 40),
      type: 'TEXT',
      x: round(box.x - parentAbs.x),
      y: round(box.y - parentAbs.y),
      width: round(box.width),
      height: round(box.height),
      opacity: 1,
      visible: true,
      fills: [],
      strokes: [],
      effects: [],
      positioning: 'AUTO',
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
      meta: { tag: '#text' },
      runs: [{ characters: text, style }],
      autoResize: range.getClientRects().length > 1 ? 'HEIGHT' : 'WIDTH_AND_HEIGHT',
      verticalAlign: 'TOP',
    };
    return { node, style: { box, display: 'inline', flexGrow: 0, alignSelf: 'auto' }, z: 0 };
  }

  private visit(el: Element, cs: CSSStyleDeclaration, parentAbs: { x: number; y: number }): O2FNode | null {
    if (SKIP_TAGS.has(tagOf(el))) return null;
    if (cs.display === 'none') return null;
    if (cs.visibility === 'hidden' && !this.opts.includeHidden) return null;
    const box = this.absRect(el);
    const hasKids = this.childNodesOf(el).length > 0;
    if (box.width <= 0 && box.height <= 0 && !hasKids) return null;
    if (this.isOffscreen(box)) return null;
    if (this.isScreenReaderOnly(box, cs)) return null;

    this.nodeCount++;
    const tag = tagOf(el);
    if (tag === 'SVG') return this.svgNode(el as SVGSVGElement, cs, box, parentAbs);
    if (tag === 'IMG') return this.imageNode(el as HTMLImageElement, cs, box, parentAbs);
    if (tag === 'PICTURE') {
      const img = el.querySelector('img');
      return img ? this.imageNode(img, getComputedStyle(img), this.absRect(img), parentAbs) : null;
    }
    if (tag === 'VIDEO') return this.videoNode(el as HTMLVideoElement, cs, box, parentAbs);
    if (tag === 'CANVAS') return this.canvasNode(el as HTMLCanvasElement, cs, box, parentAbs);
    if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') return this.placeholderNode(el, cs, box, parentAbs, tag.toLowerCase());
    if (tag === 'INPUT') return this.inputNode(el as HTMLInputElement, cs, box, parentAbs);
    if (tag === 'TEXTAREA') return this.textFieldNode(el, cs, box, parentAbs, (el as HTMLTextAreaElement).value, (el as HTMLTextAreaElement).placeholder);
    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      return this.textFieldNode(el, cs, box, parentAbs, sel.selectedOptions[0]?.text ?? '', '');
    }

    if (this.isTextOnly(el)) {
      const runs = this.collectRuns(el, cs);
      if (runs.length === 0) return this.frameFrom(el, cs, box, parentAbs);
      if (this.hasDecoration(cs, box)) {
        const frame = this.frameFrom(el, cs, box, parentAbs, true);
        const pad = frame.layout.padding;
        const text = this.textNode(el, cs, runs, {
          x: box.x + pad.left, y: box.y + pad.top,
          width: Math.max(0, box.width - pad.left - pad.right), height: Math.max(0, box.height - pad.top - pad.bottom),
        }, { x: box.x, y: box.y });
        frame.children = [text];
        frame.layout = {
          ...frame.layout,
          mode: 'VERTICAL',
          primaryAlign: this.verticalAlignFor(cs) === 'CENTER' ? 'CENTER' : this.verticalAlignFor(cs) === 'BOTTOM' ? 'MAX' : 'MIN',
          counterAlign: 'MIN',
          sizingHorizontal: 'FIXED',
          sizingVertical: 'FIXED',
        };
        if (text.autoResize === 'WIDTH_AND_HEIGHT') {
          // a label hugging its glyphs (buttons, badges, links): grow with the font instead of wrapping
          text.sizingHorizontal = 'HUG';
          text.sizingVertical = 'HUG';
          frame.layout.sizingHorizontal = 'HUG';
          frame.layout.sizingVertical = 'HUG';
          frame.layout.primaryAlign = 'CENTER';
          frame.layout.counterAlign = 'CENTER';
        } else {
          text.sizingHorizontal = 'FILL';
          text.sizingVertical = text.autoResize === 'NONE' ? 'FILL' : 'HUG';
          if (text.autoResize !== 'NONE') frame.layout.sizingVertical = 'HUG';
        }
        this.addMarker(el, cs, frame, box);
        return frame;
      }
      const text = this.textNode(el, cs, runs, box, parentAbs);
      return text;
    }

    return this.frameFrom(el, cs, box, parentAbs);
  }

  private isOffscreen(box: Box): boolean {
    return box.x + box.width < 0 || box.y + box.height < 0 || box.x > this.docWidth + 1 || box.y > this.docHeight + 1;
  }

  private isScreenReaderOnly(box: Box, cs: CSSStyleDeclaration): boolean {
    return box.width <= 1 && box.height <= 1 && (cs.overflow === 'hidden' || cs.clip !== 'auto' || cs.clipPath !== 'none');
  }

  // ---------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------

  private frameFrom(el: Element, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }, leaf = false): FrameNode {
    const padding = this.paddingOf(cs);
    const frame: FrameNode = {
      id: this.nextId(),
      name: this.nameFor(el, cs),
      type: 'FRAME',
      x: round(box.x - parentAbs.x),
      y: round(box.y - parentAbs.y),
      width: round(box.width),
      height: round(box.height),
      opacity: parseFloat(cs.opacity),
      visible: cs.visibility !== 'hidden',
      fills: this.fillsOf(cs, box),
      strokes: this.strokesOf(cs),
      effects: this.effectsOf(cs),
      cornerRadius: parseRadius(cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius, box.width, box.height),
      positioning: this.positioningOf(cs),
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
      meta: this.metaFor(el),
      layout: {
        mode: 'NONE', gap: 0, padding, primaryAlign: 'MIN', counterAlign: 'MIN', wrap: false,
        sizingHorizontal: 'FIXED', sizingVertical: 'FIXED',
      },
      clipsContent: this.clips(cs),
      children: [],
    };
    this.notePseudo(el);
    if (!leaf) {
      this.applyLayout(frame, el, cs, box, padding);
      this.addMarker(el, cs, frame, box);
    }
    return frame;
  }

  /** Walks children, infers auto-layout, assigns child sizing and order. */
  private applyLayout(frame: FrameNode, el: Element, cs: CSSStyleDeclaration, box: Box, padding: Padding): void {
    const all = this.collectChildren(el, { x: box.x, y: box.y }, cs);
    const inFlow = all.filter((e) => e.node.positioning === 'AUTO');
    const result = inferLayout(box, {
      display: cs.display,
      flexDirection: cs.flexDirection,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      flexWrap: cs.flexWrap,
      columnGap: px(cs.columnGap),
      rowGap: px(cs.rowGap),
      gridTemplateColumns: cs.gridTemplateColumns,
      gridTemplateRows: cs.gridTemplateRows,
      padding,
    }, inFlow.map((e) => e.style));

    frame.layout = result.layout;
    if (result.reason && inFlow.length > 1) this.countWarn(`auto-layout fallback: ${result.reason}`);

    const ordered = result.reverse ? [...inFlow].reverse() : inFlow;
    ordered.forEach((e, i) => {
      const s = result.children[result.reverse ? inFlow.length - 1 - i : i];
      e.node.sizingHorizontal = this.combineSizing(s.horizontal, e.node, 'horizontal', frame.layout.mode);
      e.node.sizingVertical = this.combineSizing(s.vertical, e.node, 'vertical', frame.layout.mode);
    });
    const absolute = all.filter((e) => e.node.positioning === 'ABSOLUTE');
    frame.children = [...ordered.map((e) => e.node), ...absolute.map((e) => e.node)];
  }

  private combineSizing(parentSays: SizingMode, node: O2FNode, axis: 'horizontal' | 'vertical', parentMode: string): SizingMode {
    if (parentMode === 'NONE') return 'FIXED';
    if (parentSays === 'FILL') return 'FILL';
    if (node.type === 'FRAME') {
      const own = axis === 'horizontal' ? node.layout.sizingHorizontal : node.layout.sizingVertical;
      return own === 'HUG' ? 'HUG' : 'FIXED';
    }
    if (node.type === 'TEXT') {
      if (node.autoResize === 'WIDTH_AND_HEIGHT') return 'HUG';
      if (node.autoResize === 'HEIGHT' && axis === 'vertical') return 'HUG';
    }
    return 'FIXED';
  }

  private paddingOf(cs: CSSStyleDeclaration): Padding {
    const p = parsePadding(cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft);
    return {
      top: p.top + px(cs.borderTopWidth),
      right: p.right + px(cs.borderRightWidth),
      bottom: p.bottom + px(cs.borderBottomWidth),
      left: p.left + px(cs.borderLeftWidth),
    };
  }

  private positioningOf(cs: CSSStyleDeclaration): 'AUTO' | 'ABSOLUTE' {
    return cs.position === 'absolute' || cs.position === 'fixed' ? 'ABSOLUTE' : 'AUTO';
  }

  private clips(cs: CSSStyleDeclaration): boolean {
    const c = (v: string) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll';
    return c(cs.overflowX) || c(cs.overflowY);
  }

  private hasDecoration(cs: CSSStyleDeclaration, box: Box): boolean {
    const p = this.paddingOf(cs);
    if (p.top || p.right || p.bottom || p.left) return true;
    if (this.fillsOf(cs, box).length) return true;
    if (cs.boxShadow !== 'none') return true;
    return false;
  }

  // ---------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------

  private fillsOf(cs: CSSStyleDeclaration, box: Box): Fill[] {
    const fills: Fill[] = [];
    const bg = toColor(cs.backgroundColor);
    if (isVisibleColor(bg)) fills.push(this.solid(bg));
    if (cs.backgroundImage && cs.backgroundImage !== 'none') {
      const layers = splitTopLevel(cs.backgroundImage);
      const sizes = splitTopLevel(cs.backgroundSize);
      const repeats = splitTopLevel(cs.backgroundRepeat);
      const imageFills: Fill[] = [];
      layers.forEach((layer, i) => {
        const size = sizes[i] ?? sizes[0] ?? 'auto';
        const repeat = repeats[i] ?? repeats[0] ?? 'repeat';
        const grad = parseLinearGradient(layer);
        if (grad) return imageFills.push(grad);
        const url = layer.match(/^url\(["']?(.*?)["']?\)$/);
        if (url) {
          const key = this.addAsset(url[1]);
          if (!key) return;
          const scaleMode = size === 'cover' ? 'FILL' : size === 'contain' ? 'FIT' : repeat.startsWith('repeat') && size === 'auto' ? 'TILE' : 'FILL';
          return imageFills.push({ type: 'IMAGE', asset: key, scaleMode });
        }
        const radial = layer.match(/^(repeating-)?(radial|conic)-gradient\((.*)\)$/s);
        if (radial) {
          const stops = splitTopLevel(radial[3]).map((s) => toColor(s.replace(/\s+-?[\d.]+(%|px|deg)\s*$/, ''))).filter(Boolean) as RGBA[];
          if (stops.length) {
            imageFills.push(this.solid(stops[0]));
            this.countWarn(`${radial[2]} gradient approximated with its first stop`);
          }
        }
      });
      // CSS lists the top layer first; Figma paints the last fill on top.
      fills.push(...imageFills.reverse());
    }
    return fills;
  }

  private solid(color: RGBA): Fill {
    const token = this.tokenFor(color);
    return token ? { type: 'SOLID', color, token } : { type: 'SOLID', color };
  }

  private strokesOf(cs: CSSStyleDeclaration): Stroke[] {
    const sides = {
      top: { w: px(cs.borderTopWidth), c: toColor(cs.borderTopColor), s: cs.borderTopStyle },
      right: { w: px(cs.borderRightWidth), c: toColor(cs.borderRightColor), s: cs.borderRightStyle },
      bottom: { w: px(cs.borderBottomWidth), c: toColor(cs.borderBottomColor), s: cs.borderBottomStyle },
      left: { w: px(cs.borderLeftWidth), c: toColor(cs.borderLeftColor), s: cs.borderLeftStyle },
    };
    const visible = Object.values(sides).filter((s) => s.w > 0 && s.s !== 'none' && s.s !== 'hidden' && isVisibleColor(s.c));
    if (!visible.length) return [];
    const color = visible[0].c as RGBA;
    const weight = Math.max(...visible.map((s) => s.w));
    const uniform = visible.length === 4 && visible.every((s) => s.w === weight && colorsEqual(s.c as RGBA, color));
    const style = visible[0].s;
    const dash = style === 'dashed' ? [weight * 3, weight * 2] : style === 'dotted' ? [weight, weight] : undefined;
    const token = this.tokenFor(color);
    const stroke: Stroke = { color, weight, align: 'INSIDE' };
    if (dash) stroke.dash = dash;
    if (token) stroke.token = token;
    if (!uniform) {
      stroke.sides = {
        top: sides.top.s !== 'none' ? sides.top.w : 0,
        right: sides.right.s !== 'none' ? sides.right.w : 0,
        bottom: sides.bottom.s !== 'none' ? sides.bottom.w : 0,
        left: sides.left.s !== 'none' ? sides.left.w : 0,
      };
      if (!visible.every((s) => colorsEqual(s.c as RGBA, color))) this.countWarn('multi-colour borders use the first side colour');
    }
    return [stroke];
  }

  private effectsOf(cs: CSSStyleDeclaration): Effect[] {
    const effects: Effect[] = [...parseBoxShadow(cs.boxShadow)];
    const blur = parseBlur(cs.filter);
    if (blur) effects.push({ type: 'LAYER_BLUR', radius: blur });
    const bblur = parseBlur((cs as CSSStyleDeclaration & { backdropFilter?: string }).backdropFilter ?? cs.getPropertyValue('backdrop-filter'));
    if (bblur) effects.push({ type: 'BACKGROUND_BLUR', radius: bblur });
    return effects;
  }

  // ---------------------------------------------------------------------
  // Text
  // ---------------------------------------------------------------------

  /** True when the element renders only text (through inline descendants) with no boxes of its own. */
  private isTextOnly(el: Element): boolean {
    const host = el as HTMLElement & { shadowRoot?: ShadowRoot | null };
    if (host.shadowRoot) return false;
    let sawText = false;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        if ((n.textContent ?? '').trim()) sawText = true;
        continue;
      }
      if (n.nodeType !== Node.ELEMENT_NODE) continue;
      const c = n as Element;
      if (tagOf(c) === 'BR') continue;
      if (SKIP_TAGS.has(tagOf(c))) continue;
      if (REPLACED.has(tagOf(c))) return false;
      const cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      if (cs.display !== 'inline') return false;
      if (cs.position === 'absolute' || cs.position === 'fixed') return false;
      if (isVisibleColor(toColor(cs.backgroundColor)) || cs.backgroundImage !== 'none') return false;
      if (px(cs.borderTopWidth) || px(cs.borderBottomWidth) || px(cs.borderLeftWidth) || px(cs.borderRightWidth)) return false;
      if (!this.isTextOnly(c)) return false;
      if ((c.textContent ?? '').trim()) sawText = true;
    }
    return sawText;
  }

  private collectRuns(el: Element, cs: CSSStyleDeclaration): TextRun[] {
    const runs: TextRun[] = [];
    const pre = cs.whiteSpace.startsWith('pre');
    const walk = (node: Node, style: TextStyle, preserve: boolean) => {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE) {
          let t = n.textContent ?? '';
          if (!preserve) t = t.replace(/[\t\n\r ]+/g, ' ');
          if (t) runs.push({ characters: t, style });
        } else if (n.nodeType === Node.ELEMENT_NODE) {
          const c = n as Element;
          if (tagOf(c) === 'BR') {
            runs.push({ characters: '\n', style });
            continue;
          }
          if (SKIP_TAGS.has(tagOf(c))) continue;
          const ccs = getComputedStyle(c);
          if (ccs.display === 'none') continue;
          walk(c, this.textStyle(ccs), ccs.whiteSpace.startsWith('pre'));
        }
      }
    };
    walk(el, this.textStyle(cs), pre);

    // Collapse whitespace across run boundaries and trim the ends, like a line box would.
    const merged: TextRun[] = [];
    for (const r of runs) {
      const prev = merged[merged.length - 1];
      let chars = r.characters;
      if (prev && prev.characters.endsWith(' ') && chars.startsWith(' ')) chars = chars.replace(/^ +/, '');
      if (prev && prev.characters.endsWith('\n') && chars.startsWith(' ')) chars = chars.replace(/^ +/, '');
      if (!chars) continue;
      if (prev && sameStyle(prev.style, r.style)) prev.characters += chars;
      else merged.push({ characters: chars, style: r.style });
    }
    if (merged.length) {
      merged[0].characters = merged[0].characters.replace(/^[ \n]+/, '');
      merged[merged.length - 1].characters = merged[merged.length - 1].characters.replace(/[ \n]+$/, '');
    }
    const result = merged.filter((r) => r.characters.length > 0);
    for (const r of result) this.noteFont(r.style);
    return result;
  }

  private textStyle(cs: CSSStyleDeclaration): TextStyle {
    const stack = resolveRenderedStack(parseFontFamily(cs.fontFamily));
    const color = toColor(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    const token = this.tokenFor(color);
    const lh = cs.lineHeight === 'normal' ? undefined : px(cs.lineHeight);
    const style: TextStyle = {
      fontFamily: stack[0] ?? 'Inter',
      fontStack: stack,
      fontSize: round(px(cs.fontSize)),
      fontWeight: parseFontWeight(cs.fontWeight),
      italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
      lineHeight: lh === undefined ? undefined : round(lh),
      letterSpacing: cs.letterSpacing === 'normal' ? 0 : round(px(cs.letterSpacing)),
      textAlign: this.textAlign(cs),
      textCase: cs.textTransform === 'uppercase' ? 'UPPER' : cs.textTransform === 'lowercase' ? 'LOWER' : cs.textTransform === 'capitalize' ? 'TITLE' : 'ORIGINAL',
      textDecoration: cs.textDecorationLine.includes('underline') ? 'UNDERLINE' : cs.textDecorationLine.includes('line-through') ? 'STRIKETHROUGH' : 'NONE',
      color,
    };
    if (token) style.colorToken = token;
    return style;
  }

  private textAlign(cs: CSSStyleDeclaration): TextStyle['textAlign'] {
    const rtl = cs.direction === 'rtl';
    switch (cs.textAlign) {
      case 'center': return 'CENTER';
      case 'right': return 'RIGHT';
      case 'left': return 'LEFT';
      case 'justify': return 'JUSTIFIED';
      case 'end': return rtl ? 'LEFT' : 'RIGHT';
      default: return rtl ? 'RIGHT' : 'LEFT';
    }
  }

  private verticalAlignFor(cs: CSSStyleDeclaration): 'TOP' | 'CENTER' | 'BOTTOM' {
    if (cs.display.includes('flex') || cs.display.includes('grid')) {
      const a = cs.alignItems;
      if (a === 'center') return 'CENTER';
      if (a === 'flex-end' || a === 'end') return 'BOTTOM';
    }
    return 'TOP';
  }

  private textNode(el: Element, cs: CSSStyleDeclaration, runs: TextRun[], box: Box, parentAbs: { x: number; y: number }): TextNode {
    const range = document.createRange();
    range.selectNodeContents(el);
    const tight = range.getBoundingClientRect();
    const lines = Math.max(1, range.getClientRects().length ? new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size : 1);
    const singleLine = lines === 1 && !runs.some((r) => r.characters.includes('\n'));
    // A single line whose box is no wider than its glyphs hugs its content, so a
    // substituted font can never force a wrap. Wider boxes keep their width (the
    // text-align then still applies) and let the height follow the content.
    const hugsWidth = Math.abs(tight.width - box.width) <= 2;
    const autoResize: TextNode['autoResize'] = singleLine && hugsWidth ? 'WIDTH_AND_HEIGHT' : 'HEIGHT';
    const node: TextNode = {
      id: this.nextId(),
      name: runs.map((r) => r.characters).join('').trim().slice(0, 40) || 'Text',
      type: 'TEXT',
      x: round(box.x - parentAbs.x),
      y: round(box.y - parentAbs.y),
      width: round(box.width),
      height: round(box.height),
      opacity: parseFloat(cs.opacity),
      visible: true,
      fills: [],
      strokes: [],
      effects: [],
      positioning: this.positioningOf(cs),
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
      meta: this.metaFor(el),
      runs,
      autoResize,
      verticalAlign: this.verticalAlignFor(cs),
    };
    if (cs.textOverflow === 'ellipsis' && cs.whiteSpace === 'nowrap') node.truncation = 'ENDING';
    const clamp = cs.getPropertyValue('-webkit-line-clamp');
    if (clamp && clamp !== 'none') {
      node.truncation = 'ENDING';
      node.maxLines = parseInt(clamp, 10) || undefined;
    }
    return node;
  }

  /** Synthesises list markers, which have no DOM node of their own. */
  private addMarker(el: Element, cs: CSSStyleDeclaration, frame: FrameNode, box: Box): void {
    if (cs.display !== 'list-item' || cs.listStyleType === 'none') return;
    const parent = el.parentElement;
    const index = parent ? Array.from(parent.children).filter((c) => tagOf(c) === tagOf(el)).indexOf(el) + 1 : 1;
    const glyph = markerGlyph(cs.listStyleType, index);
    if (!glyph) return;
    const style = this.textStyle(cs);
    this.noteFont(style);
    const fs = style.fontSize;
    const lh = style.lineHeight ?? fs * 1.2;
    const inside = cs.listStylePosition === 'inside';
    const node: TextNode = {
      id: this.nextId(),
      name: 'marker',
      type: 'TEXT',
      x: inside ? frame.layout.padding.left : round(-fs * 1.5),
      y: frame.layout.padding.top,
      width: round(fs * 1.5),
      height: round(lh),
      opacity: 1,
      visible: true,
      fills: [],
      strokes: [],
      effects: [],
      positioning: 'ABSOLUTE',
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
      meta: { tag: '::marker' },
      runs: [{ characters: glyph, style: { ...style, textAlign: inside ? 'LEFT' : 'RIGHT' } }],
      autoResize: 'NONE',
      verticalAlign: 'TOP',
    };
    frame.children.push(node);
    void box;
  }

  private notePseudo(el: Element): void {
    for (const p of ['::before', '::after'] as const) {
      const cs = getComputedStyle(el, p);
      if (cs.content && cs.content !== 'none' && cs.content !== 'normal' && cs.content !== '""' && cs.display !== 'none') {
        this.countWarn('pseudo-element with content skipped');
      }
    }
  }

  // ---------------------------------------------------------------------
  // Replaced elements
  // ---------------------------------------------------------------------

  private svgNode(el: SVGSVGElement, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }): O2FNode {
    const clone = el.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.max(1, Math.round(box.width))));
    clone.setAttribute('height', String(Math.max(1, Math.round(box.height))));
    if (!clone.getAttribute('viewBox') && el.viewBox.baseVal.width) {
      clone.setAttribute('viewBox', `0 0 ${el.viewBox.baseVal.width} ${el.viewBox.baseVal.height}`);
    }
    // Inline sprite references so the SVG is self-contained.
    for (const use of Array.from(clone.querySelectorAll('use'))) {
      const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
      if (!href.startsWith('#')) continue;
      const id = href.slice(1);
      if (clone.querySelector(`#${CSS.escape(id)}`)) continue;
      const target = document.getElementById(id);
      if (!target) continue;
      let defs = clone.querySelector('defs');
      if (!defs) {
        defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        clone.insertBefore(defs, clone.firstChild);
      }
      defs.appendChild(target.cloneNode(true));
    }
    // Resolve currentColor against the computed color so the import is not black.
    const color = cs.color;
    const markup = new XMLSerializer().serializeToString(clone).replace(/currentColor/g, color);
    const fillAttr = clone.getAttribute('fill');
    const svg = fillAttr || /fill=/.test(markup) ? markup : markup.replace('<svg', `<svg fill="${cs.fill || color}"`);
    return {
      id: this.nextId(),
      name: this.nameFor(el, cs, 'svg'),
      type: 'SVG',
      x: round(box.x - parentAbs.x),
      y: round(box.y - parentAbs.y),
      width: round(box.width),
      height: round(box.height),
      opacity: parseFloat(cs.opacity),
      visible: true,
      fills: [],
      strokes: [],
      effects: this.effectsOf(cs),
      positioning: this.positioningOf(cs),
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
      meta: this.metaFor(el),
      svg,
    };
  }

  private imageNode(el: HTMLImageElement, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }): O2FNode {
    const src = el.currentSrc || el.src;
    const key = el.naturalWidth > 0 || src.startsWith('data:') ? this.addAsset(src, el.naturalWidth, el.naturalHeight) : null;
    const fit = cs.objectFit;
    const scaleMode = fit === 'contain' ? 'FIT' : fit === 'none' ? 'CROP' : 'FILL';
    const fills: Fill[] = key ? [{ type: 'IMAGE', asset: key, scaleMode }] : [this.solid({ r: 0.85, g: 0.85, b: 0.85, a: 1 })];
    if (!key) this.countWarn('image not loaded; grey placeholder used');
    return this.rectLike(el, cs, box, parentAbs, fills, this.nameFor(el, cs, el.alt || 'image'));
  }

  private videoNode(el: HTMLVideoElement, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }): O2FNode {
    const key = el.poster ? this.addAsset(el.poster) : null;
    const fills: Fill[] = key ? [{ type: 'IMAGE', asset: key, scaleMode: 'FILL' }] : [this.solid({ r: 0.1, g: 0.1, b: 0.1, a: 1 })];
    return this.rectLike(el, cs, box, parentAbs, fills, 'video');
  }

  private canvasNode(el: HTMLCanvasElement, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }): O2FNode {
    let fills: Fill[];
    try {
      const data = el.toDataURL('image/png');
      const key = this.addAsset(data, el.width, el.height);
      fills = key ? [{ type: 'IMAGE', asset: key, scaleMode: 'FILL' }] : [];
    } catch {
      this.countWarn('canvas is tainted and could not be exported');
      fills = [this.solid({ r: 0.9, g: 0.9, b: 0.9, a: 1 })];
    }
    return this.rectLike(el, cs, box, parentAbs, fills, 'canvas');
  }

  private placeholderNode(el: Element, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }, label: string): O2FNode {
    this.countWarn(`${label} replaced with a placeholder`);
    return this.rectLike(el, cs, box, parentAbs, [this.solid({ r: 0.93, g: 0.93, b: 0.95, a: 1 })], label);
  }

  private rectLike(el: Element, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }, fills: Fill[], name: string): O2FNode {
    const radius = parseRadius(cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius, box.width, box.height);
    const isCircle = radius && box.width === box.height && radius.topLeft >= box.width / 2 - 0.5;
    return {
      id: this.nextId(),
      name,
      type: isCircle ? 'ELLIPSE' : 'RECTANGLE',
      x: round(box.x - parentAbs.x),
      y: round(box.y - parentAbs.y),
      width: round(box.width),
      height: round(box.height),
      opacity: parseFloat(cs.opacity),
      visible: true,
      fills,
      strokes: this.strokesOf(cs),
      effects: this.effectsOf(cs),
      cornerRadius: isCircle ? undefined : radius,
      positioning: this.positioningOf(cs),
      sizingHorizontal: 'FIXED',
      sizingVertical: 'FIXED',
      meta: this.metaFor(el),
    };
  }

  private inputNode(el: HTMLInputElement, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }): O2FNode | null {
    const type = (el.type || 'text').toLowerCase();
    if (type === 'hidden') return null;
    if (type === 'checkbox' || type === 'radio') {
      const accent = toColor(cs.accentColor) ?? { r: 0.1, g: 0.4, b: 0.9, a: 1 };
      const fills: Fill[] = el.checked ? [this.solid(accent)] : [this.solid({ r: 1, g: 1, b: 1, a: 1 })];
      const node = this.rectLike(el, cs, box, parentAbs, fills, type);
      if (type === 'radio') node.type = 'ELLIPSE';
      if (!node.strokes.length) node.strokes = [{ color: { r: 0.46, g: 0.46, b: 0.46, a: 1 }, weight: 1, align: 'INSIDE' }];
      if (!node.cornerRadius && type === 'checkbox') node.cornerRadius = { topLeft: 2, topRight: 2, bottomRight: 2, bottomLeft: 2 };
      return node;
    }
    if (type === 'range' || type === 'color' || type === 'file') {
      return this.placeholderNode(el, cs, box, parentAbs, `input[${type}]`);
    }
    if (type === 'submit' || type === 'button' || type === 'reset') {
      return this.textFieldNode(el, cs, box, parentAbs, el.value || 'Submit', '');
    }
    const value = type === 'password' ? '•'.repeat(el.value.length) : el.value;
    return this.textFieldNode(el, cs, box, parentAbs, value, el.placeholder);
  }

  private textFieldNode(el: Element, cs: CSSStyleDeclaration, box: Box, parentAbs: { x: number; y: number }, value: string, placeholder: string): O2FNode {
    const frame = this.frameFrom(el, cs, box, parentAbs, true);
    const text = value || placeholder;
    if (!text) return frame;
    const style = this.textStyle(cs);
    if (!value && placeholder) style.color = { ...style.color, a: style.color.a * 0.55 };
    this.noteFont(style);
    const pad = frame.layout.padding;
    const inner = { x: box.x + pad.left, y: box.y + pad.top, width: Math.max(0, box.width - pad.left - pad.right), height: Math.max(0, box.height - pad.top - pad.bottom) };
    const node: TextNode = {
      id: this.nextId(),
      name: text.slice(0, 40),
      type: 'TEXT',
      x: round(inner.x - box.x),
      y: round(inner.y - box.y),
      width: round(inner.width),
      height: round(inner.height),
      opacity: 1,
      visible: true,
      fills: [],
      strokes: [],
      effects: [],
      positioning: 'AUTO',
      sizingHorizontal: 'FILL',
      sizingVertical: 'FILL',
      meta: { tag: 'value' },
      runs: [{ characters: text, style }],
      autoResize: 'NONE',
      verticalAlign: tagOf(el) === 'TEXTAREA' ? 'TOP' : 'CENTER',
    };
    frame.children = [node];
    frame.layout = { ...frame.layout, mode: 'VERTICAL', primaryAlign: 'MIN', counterAlign: 'MIN' };
    return frame;
  }

  // ---------------------------------------------------------------------
  // Assets, tokens, fonts, naming
  // ---------------------------------------------------------------------

  private addAsset(url: string, width?: number, height?: number): string | null {
    if (!url) return null;
    if (!this.opts.inlineImages) return null;
    let abs = url;
    try {
      abs = new URL(url, location.href).href;
    } catch {
      return null;
    }
    const existing = this.assetKeys.get(abs);
    if (existing) return existing;
    const key = `asset${this.assetKeys.size + 1}`;
    this.assetKeys.set(abs, key);
    this.pending.push(this.loadAsset(abs, key, width, height));
    return key;
  }

  private async loadAsset(url: string, key: string, width?: number, height?: number): Promise<void> {
    try {
      let blob: Blob;
      if (url.startsWith('data:')) {
        blob = await (await fetch(url)).blob();
      } else {
        const res = await fetch(url, { mode: 'cors', credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        blob = await res.blob();
      }
      let mime = blob.type || 'application/octet-stream';
      let data: string;
      if (mime === 'image/svg+xml' || mime === 'image/webp' || mime === 'image/avif' || mime === 'image/gif') {
        // Figma only accepts PNG/JPEG; rasterise everything else through a canvas.
        const png = await rasterise(blob, width, height);
        mime = 'image/png';
        data = png;
      } else {
        data = await blobToBase64(blob);
      }
      this.assets[key] = { mime, data, width, height, source: url };
    } catch (err) {
      // Opaque cross-origin images cannot be read; try drawing through an <img> with CORS.
      try {
        const png = await rasterise(url, width, height);
        this.assets[key] = { mime: 'image/png', data: png, width, height, source: url };
      } catch {
        this.countWarn('image could not be fetched (CORS or network); placeholder used');
        this.assets[key] = { mime: 'image/png', data: '', width, height, source: url };
      }
    }
  }

  private tokenFor(color: RGBA): string | undefined {
    for (const t of this.tokens) {
      if (t.type === 'COLOR' && colorsEqual(t.value as RGBA, color)) return t.name;
    }
    return undefined;
  }

  private collectTokens(): void {
    const seen = new Map<string, Token>();
    const rootCs = getComputedStyle(document.documentElement);
    const rem = px(rootCs.fontSize) || 16;
    const visitRules = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          if (!/(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText)) continue;
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (!prop.startsWith('--')) continue;
            const raw = rootCs.getPropertyValue(prop).trim() || rule.style.getPropertyValue(prop).trim();
            seen.set(prop, this.classifyToken(prop, raw, rem));
          }
        } else if ('cssRules' in rule) {
          try {
            visitRules((rule as CSSGroupingRule).cssRules);
          } catch { /* ignore */ }
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visitRules(sheet.cssRules);
      } catch {
        this.countWarn(`stylesheet not readable (cross-origin): ${sheet.href ?? 'inline'}`);
      }
    }
    this.tokens = [...seen.values()];
  }

  private classifyToken(prop: string, raw: string, rem: number): Token {
    const name = prop.replace(/^--/, '').replace(/-/, '/');
    const color = toColor(raw);
    if (color) return { name, type: 'COLOR', value: color, raw };
    const m = raw.match(/^(-?[\d.]+)(px|rem|em)$/);
    if (m) return { name, type: 'FLOAT', value: m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * rem, raw };
    const n = Number(raw);
    if (raw !== '' && Number.isFinite(n)) return { name, type: 'FLOAT', value: n, raw };
    return { name, type: 'STRING', value: raw, raw };
  }

  private noteFont(style: TextStyle): void {
    const key = `${style.fontFamily}|${style.italic ? 'i' : 'n'}`;
    const entry = this.fonts.get(key) ?? { family: style.fontFamily, weights: [], italic: style.italic };
    if (!entry.weights.includes(style.fontWeight)) entry.weights.push(style.fontWeight);
    this.fonts.set(key, entry);
  }

  private nameFor(el: Element, cs: CSSStyleDeclaration, fallback?: string): string {
    const testId = el.getAttribute('data-testid') ?? el.getAttribute('data-test') ?? el.getAttribute('data-cy');
    if (testId) return testId;
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.id && el.id.length <= 32) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList).find((c) => !/^(css|sc|jsx|_)-|[A-Za-z0-9]{8,}$/.test(c) || c.length <= 24);
    if (cls) return `${tag}.${cls}`;
    if (fallback) return fallback;
    if (cs.display.includes('flex')) return `${tag} (flex)`;
    return tag;
  }

  private metaFor(el: Element): O2FNode['meta'] {
    const meta: O2FNode['meta'] = { tag: el.tagName.toLowerCase() };
    const classes = Array.from(el.classList);
    if (classes.length) meta.classes = classes;
    const role = el.getAttribute('role');
    if (role) meta.role = role;
    const testId = el.getAttribute('data-testid');
    if (testId) meta.testId = testId;
    if (el instanceof HTMLAnchorElement && el.href) meta.href = el.href;
    return meta;
  }

  private nextId(): string {
    return `n${++this.idCounter}`;
  }

  private countWarn(msg: string): void {
    this.warnCounts.set(msg, (this.warnCounts.get(msg) ?? 0) + 1);
  }

  private flushWarnCounts(): void {
    for (const [msg, n] of this.warnCounts) this.warnings.push(n > 1 ? `${msg} (×${n})` : msg);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const GENERIC_FONT = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', '-apple-system', 'blinkmacsystemfont']);
let fontProbe: CanvasRenderingContext2D | null | undefined;
const fontAvailability = new Map<string, boolean>();

/** True when the browser can render `family` itself rather than falling back. */
function fontAvailable(family: string): boolean {
  const cached = fontAvailability.get(family);
  if (cached !== undefined) return cached;
  if (fontProbe === undefined) fontProbe = document.createElement('canvas').getContext('2d');
  let ok = false;
  if (fontProbe) {
    const sample = 'mmmmmmmmmmlli0123456789WWW';
    const widthWith = (fallback: string) => {
      fontProbe!.font = `32px "${family}", ${fallback}`;
      return fontProbe!.measureText(sample).width;
    };
    fontProbe.font = '32px monospace';
    const mono = fontProbe.measureText(sample).width;
    fontProbe.font = '32px serif';
    const serif = fontProbe.measureText(sample).width;
    ok = widthWith('monospace') !== mono || widthWith('serif') !== serif;
  }
  fontAvailability.set(family, ok);
  return ok;
}

/** The platform font Chrome substitutes for generic families, named the way Figma lists it. */
function platformFont(generic: string): string {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const win = /Win/.test(navigator.platform);
  switch (generic) {
    case 'monospace':
    case 'ui-monospace':
      return mac ? 'SF Mono' : win ? 'Consolas' : 'DejaVu Sans Mono';
    case 'serif':
    case 'ui-serif':
      return mac ? 'Times' : win ? 'Times New Roman' : 'DejaVu Serif';
    default:
      return mac ? 'SF Pro Text' : win ? 'Segoe UI' : 'DejaVu Sans';
  }
}

/**
 * Moves the family that actually rendered to the front of the stack. The
 * browser measured every box with that font, so the plugin should prefer it;
 * the authored families stay behind it for designers who want to swap.
 */
function resolveRenderedStack(stack: string[]): string[] {
  for (const family of stack) {
    const lower = family.toLowerCase();
    if (GENERIC_FONT.has(lower)) {
      const concrete = platformFont(lower);
      return [concrete, ...stack.filter((f) => f !== concrete)];
    }
    if (fontAvailable(family)) {
      return [family, ...stack.filter((f) => f !== family)];
    }
  }
  return stack;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function markerGlyph(type: string, index: number): string | null {
  switch (type) {
    case 'disc': return '•';
    case 'circle': return '◦';
    case 'square': return '▪';
    case 'decimal': return `${index}.`;
    case 'decimal-leading-zero': return `${String(index).padStart(2, '0')}.`;
    case 'lower-alpha':
    case 'lower-latin': return `${String.fromCharCode(96 + ((index - 1) % 26) + 1)}.`;
    case 'upper-alpha':
    case 'upper-latin': return `${String.fromCharCode(64 + ((index - 1) % 26) + 1)}.`;
    case 'lower-roman': return `${roman(index).toLowerCase()}.`;
    case 'upper-roman': return `${roman(index)}.`;
    default: return type.startsWith('"') ? type.replace(/"/g, '') : '•';
  }
}

function roman(n: number): string {
  const map: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(blob);
  });
}

async function rasterise(source: Blob | string, width?: number, height?: number): Promise<string> {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
    const w = Math.max(1, Math.round(width || img.naturalWidth || 1));
    const h = Math.max(1, Math.round(height || img.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    // cap very large images to keep the document small
    const scale = Math.min(1, 2048 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

export async function extract(options: ExtractOptions = {}): Promise<RawExtract> {
  const opts: Required<ExtractOptions> = {
    rootSelector: options.rootSelector ?? '',
    includeHidden: options.includeHidden ?? false,
    inlineImages: options.inlineImages ?? true,
    maxNodes: options.maxNodes ?? 20000,
  };
  return new Walker(opts).run();
}

declare global {
  interface Window {
    __o2f: { extract: typeof extract };
  }
}
