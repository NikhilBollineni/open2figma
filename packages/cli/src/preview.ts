/**
 * Renders an O2F document to a standalone HTML page. This is a faithful
 * drawing of what the Figma plugin will build: every node is placed at its
 * captured position with its fills, strokes, effects and text runs. It is
 * useful for checking a capture without opening Figma and for CI artifacts.
 */
import type { O2FDocument, O2FNode, Fill, RGBA, TextRun } from '@open2figma/schema';
import { isFrame, walk } from '@open2figma/schema';

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji']);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const rgba = (c: RGBA) => `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${+c.a.toFixed(3)})`;

function background(fills: Fill[], doc: O2FDocument): string {
  // O2F lists fills bottom to top; CSS lists top layer first.
  const layers: string[] = [];
  const sizes: string[] = [];
  for (const f of [...fills].reverse()) {
    if (f.type === 'SOLID') {
      layers.push(`linear-gradient(${rgba(f.color)}, ${rgba(f.color)})`);
      sizes.push('auto');
    } else if (f.type === 'GRADIENT_LINEAR') {
      layers.push(`linear-gradient(${f.angle}deg, ${f.stops.map((s) => `${rgba(s.color)} ${(s.position * 100).toFixed(1)}%`).join(', ')})`);
      sizes.push('auto');
    } else {
      const a = doc.assets[f.asset];
      if (a && a.data) {
        layers.push(`url("data:${a.mime};base64,${a.data}") center / ${f.scaleMode === 'FIT' ? 'contain' : f.scaleMode === 'TILE' ? 'auto' : 'cover'} ${f.scaleMode === 'TILE' ? 'repeat' : 'no-repeat'}`);
      } else {
        layers.push('linear-gradient(#d9d9d9, #d9d9d9)');
      }
      sizes.push('');
    }
  }
  return layers.length ? `background:${layers.join(', ')};` : '';
}

function runStyle(r: TextRun): string {
  const s = r.style;
  const parts = [
    `font-family:${s.fontStack.map((f) => (/^[a-z-]+$/.test(f) && GENERIC_FAMILIES.has(f) ? f : `'${f.replace(/'/g, '')}'`)).join(', ')}`,
    `font-size:${s.fontSize}px`,
    `font-weight:${s.fontWeight}`,
    `color:${rgba(s.color)}`,
    `letter-spacing:${s.letterSpacing}px`,
    s.lineHeight !== undefined ? `line-height:${s.lineHeight}px` : 'line-height:normal',
    s.italic ? 'font-style:italic' : '',
    s.textDecoration === 'UNDERLINE' ? 'text-decoration:underline' : s.textDecoration === 'STRIKETHROUGH' ? 'text-decoration:line-through' : '',
    s.textCase === 'UPPER' ? 'text-transform:uppercase' : s.textCase === 'LOWER' ? 'text-transform:lowercase' : s.textCase === 'TITLE' ? 'text-transform:capitalize' : '',
  ];
  return parts.filter(Boolean).join(';');
}

function node(n: O2FNode, doc: O2FDocument, out: string[]): void {
  const style: string[] = [`left:${n.x}px`, `top:${n.y}px`, `width:${n.width}px`, `height:${n.height}px`, `opacity:${n.opacity}`];
  if (!n.visible) style.push('display:none');
  style.push(background(n.fills, doc));
  if (n.cornerRadius) style.push(`border-radius:${n.cornerRadius.topLeft}px ${n.cornerRadius.topRight}px ${n.cornerRadius.bottomRight}px ${n.cornerRadius.bottomLeft}px`);
  if (n.type === 'ELLIPSE') style.push('border-radius:50%');
  const shadows: string[] = [];
  for (const s of n.strokes) {
    if (s.sides) shadows.push(`inset 0 ${s.sides.top}px 0 0 ${rgba(s.color)}`, `inset ${s.sides.left}px 0 0 0 ${rgba(s.color)}`, `inset 0 -${s.sides.bottom}px 0 0 ${rgba(s.color)}`, `inset -${s.sides.right}px 0 0 0 ${rgba(s.color)}`);
    else shadows.push(`inset 0 0 0 ${s.weight}px ${rgba(s.color)}`);
  }
  for (const e of n.effects) {
    if (e.type === 'DROP_SHADOW') shadows.push(`${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread}px ${rgba(e.color)}`);
    else if (e.type === 'INNER_SHADOW') shadows.push(`inset ${e.offset.x}px ${e.offset.y}px ${e.radius}px ${e.spread}px ${rgba(e.color)}`);
    else if (e.type === 'LAYER_BLUR') style.push(`filter:blur(${e.radius}px)`);
    else style.push(`backdrop-filter:blur(${e.radius}px)`);
  }
  if (shadows.length) style.push(`box-shadow:${shadows.join(', ')}`);
  if (isFrame(n) && n.clipsContent) style.push('overflow:hidden');

  const layoutTag = isFrame(n) ? n.layout.mode : n.type;
  const title = `${n.name} · ${n.type}${isFrame(n) ? ` · ${n.layout.mode}${n.layout.mode !== 'NONE' ? ` gap ${n.layout.gap}` : ''}` : ''}${n.meta.componentKey ? ' · component' : ''}`;
  const cls = ['n', n.type.toLowerCase(), isFrame(n) && n.layout.mode !== 'NONE' ? 'auto' : '', n.meta.componentKey ? 'comp' : ''].filter(Boolean).join(' ');
  out.push(`<div class="${cls}" data-layout="${layoutTag}" title="${esc(title)}" style="${esc(style.join(';'))}">`);

  if (n.type === 'TEXT') {
    const s = n.runs[0].style;
    const align = s.textAlign === 'JUSTIFIED' ? 'justify' : s.textAlign.toLowerCase();
    const valign = n.verticalAlign === 'CENTER' ? 'center' : n.verticalAlign === 'BOTTOM' ? 'flex-end' : 'flex-start';
    out.push(`<div class="t" style="text-align:${align};justify-content:${valign}${n.autoResize === 'WIDTH_AND_HEIGHT' ? ';white-space:nowrap' : ''}"><div>`);
    for (const r of n.runs) out.push(`<span style="${esc(runStyle(r))}">${esc(r.characters).replace(/\n/g, '<br>')}</span>`);
    out.push('</div></div>');
  } else if (n.type === 'SVG') {
    out.push(n.svg.replace(/<svg/, '<svg style="width:100%;height:100%;display:block"'));
  } else if (isFrame(n)) {
    for (const c of n.children) node(c, doc, out);
  }
  out.push('</div>');
}

export function renderHtml(doc: O2FDocument): string {
  const frames: string[] = [];
  let totalNodes = 0;
  let autoFrames = 0;
  let allFrames = 0;
  for (const bp of doc.breakpoints) {
    const out: string[] = [];
    node(bp.root, doc, out);
    walk(bp.root, (n) => {
      totalNodes++;
      if (isFrame(n)) {
        allFrames++;
        if (n.layout.mode !== 'NONE') autoFrames++;
      }
    });
    frames.push(`<section><h2>${esc(bp.name)} <small>${bp.root.width} × ${bp.root.height}</small></h2><div class="canvas" style="width:${bp.root.width}px;height:${bp.root.height}px">${out.join('')}</div></section>`);
  }
  const comps = Object.values(doc.components);
  const stats = [
    ['Nodes', totalNodes],
    ['Auto-layout frames', `${autoFrames} / ${allFrames}`],
    ['Components', `${comps.length} (${comps.reduce((a, c) => a + c.count, 0)} instances)`],
    ['Images', Object.keys(doc.assets).length],
    ['Variables (tokens)', doc.tokens.length],
    ['Fonts', doc.fonts.map((f) => f.family).join(', ')],
  ];
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>open2figma preview: ${esc(doc.source.title ?? '')}</title>
<style>
  body { margin: 0; font: 13px/1.4 Inter, system-ui, sans-serif; background: #e5e5e5; color: #111; }
  header { position: sticky; top: 0; z-index: 10; background: #fff; border-bottom: 1px solid #ccc; padding: 10px 16px; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  header b { font-size: 14px; }
  header span { color: #555; } header span em { color: #111; font-style: normal; font-weight: 600; }
  header label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
  section { padding: 24px; } h2 { margin: 0 0 8px; font-size: 14px; } h2 small { color: #666; font-weight: 400; }
  .canvas { position: relative; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.15); transform-origin: top left; }
  .n { position: absolute; box-sizing: border-box; }
  .t { width: 100%; height: 100%; display: flex; flex-direction: column; white-space: pre-wrap; overflow: visible; }
  body.outlines .auto { outline: 1px dashed rgba(0, 122, 255, .7); outline-offset: -1px; }
  body.outlines .comp { outline: 1px solid rgba(190, 0, 200, .8); outline-offset: -1px; }
  body.outlines .n[data-layout="NONE"] { outline: 1px dashed rgba(255, 140, 0, .5); outline-offset: -1px; }
  .legend i { display: inline-block; width: 12px; height: 12px; vertical-align: -2px; margin-right: 4px; }
</style></head>
<body>
<header>
  <b>open2figma preview</b>
  ${stats.map(([k, v]) => `<span>${k}: <em>${esc(String(v))}</em></span>`).join('')}
  <label><input type="checkbox" id="o" onchange="document.body.classList.toggle('outlines', this.checked)"> show structure</label>
  <span class="legend"><i style="outline:1px dashed #007aff"></i>auto-layout &nbsp; <i style="outline:1px dashed #ff8c00"></i>absolute &nbsp; <i style="outline:1px solid #be00c8"></i>component</span>
</header>
${frames.join('\n')}
</body></html>`;
}
