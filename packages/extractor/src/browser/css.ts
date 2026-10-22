/**
 * Pure CSS value parsers. No DOM access, so these run in vitest under Node
 * and inside the injected walker alike.
 */
import type { RGBA, GradientFill, ShadowEffect, CornerRadius, Padding } from '@open2figma/schema';

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export function px(value: string | null | undefined): number {
  if (!value) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** Split on commas that are not nested inside parentheses. */
export function splitTopLevel(input: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const rgb = (r: number, g: number, b: number): RGBA => ({ r: r / 255, g: g / 255, b: b / 255, a: 1 });
/** Computed styles always come back as rgb(), but authored token values may use names. */
const NAMED: Record<string, RGBA> = {
  transparent: TRANSPARENT,
  black: rgb(0, 0, 0), white: rgb(255, 255, 255), red: rgb(255, 0, 0), green: rgb(0, 128, 0), blue: rgb(0, 0, 255),
  yellow: rgb(255, 255, 0), orange: rgb(255, 165, 0), purple: rgb(128, 0, 128), pink: rgb(255, 192, 203),
  gray: rgb(128, 128, 128), grey: rgb(128, 128, 128), silver: rgb(192, 192, 192), navy: rgb(0, 0, 128),
  teal: rgb(0, 128, 128), cyan: rgb(0, 255, 255), aqua: rgb(0, 255, 255), magenta: rgb(255, 0, 255), fuchsia: rgb(255, 0, 255),
  lime: rgb(0, 255, 0), maroon: rgb(128, 0, 0), olive: rgb(128, 128, 0), brown: rgb(165, 42, 42), gold: rgb(255, 215, 0),
  currentcolor: rgb(0, 0, 0),
};

/**
 * Parses the color forms a browser returns from getComputedStyle:
 * rgb(), rgba(), color(srgb ...), #hex, transparent, and the
 * modern space-separated syntax with slash alpha.
 */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (NAMED[s]) return { ...NAMED[s] };

  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const full = hex.length === 3 || hex.length === 4 ? hex.split('').map((c) => c + c).join('') : hex;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(full)) return null;
    const n = parseInt(full.slice(0, 6), 16);
    const a = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
  }

  const m = s.match(/^(rgba?|color|hsla?)\((.*)\)$/);
  if (!m) return null;
  const fn = m[1];
  let body = m[2].trim();
  let space = 'srgb';
  if (fn === 'color') {
    const parts = body.split(/\s+/);
    space = parts.shift() ?? 'srgb';
    body = parts.join(' ');
    if (space !== 'srgb') return null; // out-of-gamut spaces are approximated upstream
  }
  // normalise "a, b, c / d" and "a b c / d" and "a, b, c, d" into tokens
  const [channels, alphaPart] = body.split('/').map((p) => p.trim());
  const tokens = channels.split(/[\s,]+/).filter(Boolean);
  if (tokens.length < 3) return null;
  let alpha = 1;
  if (alphaPart !== undefined) alpha = parseAlpha(alphaPart);
  else if (tokens.length >= 4) alpha = parseAlpha(tokens[3]);

  if (fn.startsWith('hsl')) {
    const h = parseFloat(tokens[0]);
    const sat = parseFloat(tokens[1]) / 100;
    const l = parseFloat(tokens[2]) / 100;
    const [r, g, b] = hslToRgb(h, sat, l);
    return { r, g, b, a: clamp01(alpha) };
  }

  const chan = (t: string): number => {
    if (t.endsWith('%')) return clamp01(parseFloat(t) / 100);
    const v = parseFloat(t);
    if (!Number.isFinite(v)) return 0;
    // color(srgb) uses 0..1, rgb() uses 0..255
    return fn === 'color' ? clamp01(v) : clamp01(v / 255);
  };
  return { r: chan(tokens[0]), g: chan(tokens[1]), b: chan(tokens[2]), a: clamp01(alpha) };
}

function parseAlpha(t: string): number {
  if (t.endsWith('%')) return parseFloat(t) / 100;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : 1;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

export function isVisibleColor(c: RGBA | null): c is RGBA {
  return !!c && c.a > 0.001;
}

export function colorsEqual(a: RGBA, b: RGBA, eps = 0.002): boolean {
  return Math.abs(a.r - b.r) < eps && Math.abs(a.g - b.g) < eps && Math.abs(a.b - b.b) < eps && Math.abs(a.a - b.a) < eps;
}

/**
 * Parses a `linear-gradient(...)` computed value into stops. Only linear
 * gradients are mapped natively; radial/conic are approximated upstream.
 */
export function parseLinearGradient(input: string): GradientFill | null {
  const m = input.trim().match(/^(repeating-)?linear-gradient\((.*)\)$/s);
  if (!m) return null;
  const parts = splitTopLevel(m[2]);
  if (parts.length < 2) return null;
  let angle = 180; // CSS default: to bottom
  let stopsStart = 0;
  const first = parts[0];
  const deg = first.match(/^(-?[\d.]+)(deg|turn|rad|grad)$/);
  if (deg) {
    const v = parseFloat(deg[1]);
    angle = deg[2] === 'deg' ? v : deg[2] === 'turn' ? v * 360 : deg[2] === 'rad' ? (v * 180) / Math.PI : v * 0.9;
    stopsStart = 1;
  } else if (first.startsWith('to ')) {
    const dir = first.slice(3).split(/\s+/).sort().join(' ');
    const map: Record<string, number> = {
      top: 0, right: 90, bottom: 180, left: 270,
      'right top': 45, 'bottom right': 135, 'bottom left': 225, 'left top': 315,
    };
    angle = map[dir] ?? 180;
    stopsStart = 1;
  }
  const rawStops = parts.slice(stopsStart);
  const stops: { color: RGBA; position?: number }[] = [];
  for (const raw of rawStops) {
    // color may contain spaces (rgb(a b c)), position is the trailing token
    const posMatch = raw.match(/\s(-?[\d.]+)(%|px)\s*$/);
    const colorStr = posMatch ? raw.slice(0, posMatch.index).trim() : raw.trim();
    const color = parseColor(colorStr);
    if (!color) continue;
    const position = posMatch && posMatch[2] === '%' ? parseFloat(posMatch[1]) / 100 : undefined;
    stops.push({ color, position });
  }
  if (stops.length < 2) return null;
  // distribute undefined positions evenly between known neighbours
  if (stops[0].position === undefined) stops[0].position = 0;
  if (stops[stops.length - 1].position === undefined) stops[stops.length - 1].position = 1;
  for (let i = 1; i < stops.length - 1; i++) {
    if (stops[i].position !== undefined) continue;
    let j = i + 1;
    while (stops[j].position === undefined) j++;
    const from = stops[i - 1].position as number;
    const to = stops[j].position as number;
    for (let k = i; k < j; k++) stops[k].position = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  return {
    type: 'GRADIENT_LINEAR',
    angle,
    stops: stops.map((s) => ({ color: s.color, position: clamp01(s.position as number) })),
  };
}

/** Parses the `box-shadow` computed value (possibly a comma list) into Figma shadow effects. */
export function parseBoxShadow(input: string | null | undefined): ShadowEffect[] {
  if (!input || input === 'none') return [];
  const out: ShadowEffect[] = [];
  for (const raw of splitTopLevel(input)) {
    let s = raw.trim();
    let inset = false;
    if (/\binset\b/.test(s)) {
      inset = true;
      s = s.replace(/\binset\b/, '').trim();
    }
    // computed form: "rgb(...) 0px 1px 2px 0px" or "0px 1px 2px rgb(...)"
    const colorMatch = s.match(/(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8}|transparent)/i);
    const color = parseColor(colorMatch ? colorMatch[1] : 'rgba(0,0,0,1)') ?? { r: 0, g: 0, b: 0, a: 1 };
    const nums = s.replace(colorMatch ? colorMatch[1] : '', '').trim().split(/\s+/).map(px);
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    if (color.a === 0) continue;
    out.push({ type: inset ? 'INNER_SHADOW' : 'DROP_SHADOW', color, offset: { x, y }, radius: blur, spread });
  }
  return out;
}

/** Extracts blur radius from `filter: blur(Npx)` style values. */
export function parseBlur(input: string | null | undefined): number {
  if (!input || input === 'none') return 0;
  const m = input.match(/blur\(\s*([\d.]+)px\s*\)/);
  return m ? parseFloat(m[1]) : 0;
}

export function parseRadius(tl: string, tr: string, br: string, bl: string, width: number, height: number): CornerRadius | undefined {
  const one = (v: string): number => {
    // computed values are "Npx" or "Npx Mpx" (elliptical) or percentages for some UAs
    const first = v.trim().split(/\s+/)[0] ?? '0px';
    if (first.endsWith('%')) return (parseFloat(first) / 100) * Math.min(width, height);
    return px(first);
  };
  const r: CornerRadius = { topLeft: one(tl), topRight: one(tr), bottomRight: one(br), bottomLeft: one(bl) };
  if (!r.topLeft && !r.topRight && !r.bottomRight && !r.bottomLeft) return undefined;
  // CSS clamps radii so adjacent corners never overlap; mirror that so Figma matches.
  const max = Math.min(width, height) / 2;
  for (const k of Object.keys(r) as (keyof CornerRadius)[]) r[k] = round(Math.min(r[k], max));
  return r;
}

export function parsePadding(t: string, r: string, b: string, l: string): Padding {
  return { top: px(t), right: px(r), bottom: px(b), left: px(l) };
}

export function parseFontFamily(input: string): string[] {
  return splitTopLevel(input).map((f) => f.replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

/** Normalises the many `font-weight` spellings into a numeric weight. */
export function parseFontWeight(input: string): number {
  const s = input.trim().toLowerCase();
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  if (s === 'lighter') return 300;
  if (s === 'bolder') return 700;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 400;
}
