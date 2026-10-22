import type { O2FDocument, O2FNode } from '@open2figma/schema';
import { walk, isFrame } from '@open2figma/schema';

export function summarize(doc: O2FDocument): string {
  const lines: string[] = [];
  lines.push(`open2figma document v${doc.version} from ${doc.source.url ?? '?'}`);
  lines.push(`title: ${doc.source.title ?? ''}`);
  for (const bp of doc.breakpoints) {
    const counts: Record<string, number> = {};
    const layouts: Record<string, number> = {};
    let depth = 0;
    walk(bp.root, (n, d) => {
      counts[n.type] = (counts[n.type] ?? 0) + 1;
      if (isFrame(n)) layouts[n.layout.mode] = (layouts[n.layout.mode] ?? 0) + 1;
      depth = Math.max(depth, d);
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    lines.push(`\n[${bp.name}] ${bp.root.width}×${bp.root.height}  ${total} nodes, depth ${depth}`);
    lines.push(`  types:   ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    lines.push(`  layouts: ${Object.entries(layouts).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  }
  const comps = Object.entries(doc.components);
  lines.push(`\ncomponents: ${comps.length}`);
  for (const [key, c] of comps.slice(0, 20)) lines.push(`  ${c.name} ×${c.count}  (${key})`);
  lines.push(`assets: ${Object.keys(doc.assets).length}  (${(Object.values(doc.assets).reduce((a, b) => a + b.data.length, 0) / 1024).toFixed(0)} KB base64)`);
  lines.push(`tokens: ${doc.tokens.length}`);
  for (const t of doc.tokens.slice(0, 20)) lines.push(`  ${t.type.padEnd(6)} ${t.name} = ${t.raw}`);
  lines.push(`fonts: ${doc.fonts.map((f) => `${f.family}${f.italic ? ' italic' : ''} [${f.weights.join(',')}]`).join(', ')}`);
  if (doc.warnings.length) {
    lines.push(`\nwarnings (${doc.warnings.length}):`);
    for (const w of doc.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export function tree(doc: O2FDocument, maxDepth = 4): string {
  const out: string[] = [];
  const line = (n: O2FNode, d: number) => {
    if (d > maxDepth) return;
    const pad = '  '.repeat(d);
    const geo = `${n.x},${n.y} ${n.width}×${n.height}`;
    const extra = isFrame(n)
      ? `${n.layout.mode}${n.layout.mode !== 'NONE' ? ` gap=${n.layout.gap}` : ''}${n.meta.componentKey ? ' ◆' : ''}`
      : n.type === 'TEXT' ? `"${n.runs.map((r) => r.characters).join('').slice(0, 30)}"` : '';
    out.push(`${pad}${n.type.padEnd(9)} ${n.name.padEnd(28).slice(0, 28)} ${geo.padEnd(22)} ${extra}`);
  };
  for (const bp of doc.breakpoints) {
    out.push(`== ${bp.name}`);
    walk(bp.root, line);
  }
  return out.join('\n');
}
