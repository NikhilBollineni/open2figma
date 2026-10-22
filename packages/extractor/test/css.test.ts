import { describe, it, expect } from 'vitest';
import { parseColor, parseLinearGradient, parseBoxShadow, parseRadius, splitTopLevel, parseFontFamily, parseFontWeight, parseBlur } from '../src/browser/css.js';

describe('parseColor', () => {
  it('parses rgb/rgba as returned by getComputedStyle', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 255, 0.5)')).toEqual({ r: 0, g: 0, b: 1, a: 0.5 });
    expect(parseColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
  it('parses modern space syntax, hex and color(srgb)', () => {
    expect(parseColor('rgb(0 128 255 / 50%)')).toMatchObject({ r: 0, b: 1, a: 0.5 });
    expect(parseColor('#4f46e5')).toMatchObject({ r: 79 / 255, g: 70 / 255, b: 229 / 255, a: 1 });
    expect(parseColor('#fff8')).toMatchObject({ r: 1, g: 1, b: 1 });
    expect(parseColor('color(srgb 1 0.5 0 / 0.25)')).toEqual({ r: 1, g: 0.5, b: 0, a: 0.25 });
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
  it('parses hsl', () => {
    const c = parseColor('hsl(120, 100%, 50%)')!;
    expect(c.g).toBeCloseTo(1);
    expect(c.r).toBeCloseTo(0);
  });
  it('rejects garbage', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('')).toBeNull();
  });
});

describe('splitTopLevel', () => {
  it('ignores commas inside parentheses', () => {
    expect(splitTopLevel('url("a,b.png"), linear-gradient(rgb(1, 2, 3), red)')).toEqual(['url("a,b.png")', 'linear-gradient(rgb(1, 2, 3), red)']);
  });
});

describe('parseLinearGradient', () => {
  it('maps angle and stops', () => {
    const g = parseLinearGradient('linear-gradient(135deg, rgb(79, 70, 229) 0%, rgb(147, 51, 234) 100%)')!;
    expect(g.angle).toBe(135);
    expect(g.stops).toHaveLength(2);
    expect(g.stops[0].position).toBe(0);
    expect(g.stops[1].position).toBe(1);
  });
  it('handles "to right" and distributes missing positions', () => {
    const g = parseLinearGradient('linear-gradient(to right, red, white, blue)')!;
    expect(g.angle).toBe(90);
    expect(g.stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
  });
  it('defaults to top-to-bottom', () => {
    expect(parseLinearGradient('linear-gradient(red, blue)')!.angle).toBe(180);
  });
  it('rejects radial', () => {
    expect(parseLinearGradient('radial-gradient(red, blue)')).toBeNull();
  });
});

describe('parseBoxShadow', () => {
  it('parses computed shadow lists including inset', () => {
    const fx = parseBoxShadow('rgba(15, 23, 42, 0.2) 0px 1px 2px 0px, rgb(0, 0, 0) 0px 0px 0px 1px inset');
    expect(fx).toHaveLength(2);
    expect(fx[0]).toMatchObject({ type: 'DROP_SHADOW', offset: { x: 0, y: 1 }, radius: 2, spread: 0 });
    expect(fx[1]).toMatchObject({ type: 'INNER_SHADOW', spread: 1 });
  });
  it('returns nothing for none', () => {
    expect(parseBoxShadow('none')).toEqual([]);
  });
});

describe('parseRadius', () => {
  it('clamps like CSS', () => {
    const r = parseRadius('999px', '999px', '999px', '999px', 100, 40)!;
    expect(r.topLeft).toBe(20);
  });
  it('returns undefined for zero radii', () => {
    expect(parseRadius('0px', '0px', '0px', '0px', 10, 10)).toBeUndefined();
  });
});

describe('fonts', () => {
  it('splits families and strips quotes', () => {
    expect(parseFontFamily('Inter, "Segoe UI", system-ui, sans-serif')).toEqual(['Inter', 'Segoe UI', 'system-ui', 'sans-serif']);
  });
  it('normalises weights', () => {
    expect(parseFontWeight('bold')).toBe(700);
    expect(parseFontWeight('600')).toBe(600);
    expect(parseFontWeight('normal')).toBe(400);
  });
  it('reads blur radius', () => {
    expect(parseBlur('blur(12px)')).toBe(12);
    expect(parseBlur('none')).toBe(0);
  });
});
