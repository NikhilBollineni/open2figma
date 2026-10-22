/**
 * Component detection: repeated subtrees with identical structure become one
 * main component plus instances. Runs on the Node side over the O2F tree.
 */
import type { O2FDocument, O2FNode, FrameNode } from '@open2figma/schema';
import { isFrame, countNodes } from '@open2figma/schema';
import { createHash } from 'node:crypto';

export interface ComponentOptions {
  /** Minimum nodes in a subtree before it can become a component. */
  minNodes?: number;
  /** Minimum repetitions. */
  minCount?: number;
}

const DYNAMIC_CLASS = /^(css|sc|jsx|_|is-|has-|active|selected|hover|focus)|[0-9a-f]{6,}$|__[A-Za-z0-9]{5,}$/;

/** Structural fingerprint: type, tag, stable classes and the fingerprints of in-flow children. Text and sizes are ignored. */
export function fingerprint(node: O2FNode): string {
  const classes = (node.meta.classes ?? []).filter((c) => !DYNAMIC_CLASS.test(c)).sort();
  const own = `${node.type}:${node.meta.tag ?? ''}:${classes.join('.')}`;
  const kids = isFrame(node) ? node.children.map(fingerprint) : [];
  const layout = isFrame(node) ? node.layout.mode : '';
  const h = createHash('sha1').update(`${own}|${layout}|${kids.join(',')}`).digest('hex').slice(0, 12);
  node.meta.fingerprint = h;
  return h;
}

export function detectComponents(doc: O2FDocument, opts: ComponentOptions = {}): void {
  const minNodes = opts.minNodes ?? 3;
  const minCount = opts.minCount ?? 2;
  const occurrences = new Map<string, O2FNode[]>();

  for (const bp of doc.breakpoints) {
    fingerprint(bp.root);
    // The root itself is a page, never a component, even when breakpoints share a structure.
    for (const child of bp.root.children) collect(child, occurrences);
  }

  const chosen = new Set<string>();
  for (const [fp, nodes] of occurrences) {
    if (nodes.length < minCount) continue;
    if (countNodes(nodes[0]) < minNodes) continue;
    chosen.add(fp);
  }

  // Prefer outermost components: unmark fingerprints that only occur inside another chosen component.
  for (const bp of doc.breakpoints) for (const child of bp.root.children) mark(child, chosen, false);

  doc.components = {};
  for (const bp of doc.breakpoints) {
    walkMarked(bp.root, (n) => {
      const key = n.meta.componentKey as string;
      const entry = doc.components[key] ?? { name: componentName(n), count: 0 };
      entry.count++;
      doc.components[key] = entry;
    });
  }
}

function collect(node: O2FNode, map: Map<string, O2FNode[]>): void {
  const fp = node.meta.fingerprint as string;
  if (!map.has(fp)) map.set(fp, []);
  map.get(fp)!.push(node);
  if (isFrame(node)) for (const c of node.children) collect(c, map);
}

function mark(node: O2FNode, chosen: Set<string>, insideComponent: boolean): void {
  const fp = node.meta.fingerprint as string;
  let inside = insideComponent;
  if (!insideComponent && chosen.has(fp) && node.type === 'FRAME') {
    node.meta.componentKey = fp;
    inside = true;
  }
  if (isFrame(node)) for (const c of node.children) mark(c, chosen, inside);
}

function walkMarked(node: O2FNode, fn: (n: FrameNode) => void): void {
  if (node.meta.componentKey && isFrame(node)) fn(node);
  if (isFrame(node)) for (const c of node.children) walkMarked(c, fn);
}

function componentName(n: O2FNode): string {
  const base = n.name.replace(/^#/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}
