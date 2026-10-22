/**
 * Capture driver: launches Chromium, loads the target, injects the walker and
 * assembles an O2F document (one breakpoint per requested viewport).
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { O2FDocument, Breakpoint, FontUsage, Token } from '@open2figma/schema';
import { O2F_VERSION } from '@open2figma/schema';
import type { RawExtract, ExtractOptions } from './browser/walker.js';
import { detectComponents } from './components.js';

export interface Viewport {
  name?: string;
  width: number;
  height: number;
}

export interface CaptureOptions {
  viewports?: Viewport[];
  /** CSS selector to capture instead of the whole page. */
  root?: string;
  /** Wait for this selector before extracting. */
  waitFor?: string;
  /** Extra delay in ms after load. */
  delay?: number;
  /** Scroll through the page first to trigger lazy loading. */
  scroll?: boolean;
  includeHidden?: boolean;
  inlineImages?: boolean;
  maxNodes?: number;
  components?: boolean;
  /** Disable CSS animations/transitions so the capture is deterministic. */
  freezeAnimations?: boolean;
  timeout?: number;
  headless?: boolean;
  /** Extra HTTP headers, e.g. auth for a staging site. */
  headers?: Record<string, string>;
  /** Reuse an existing browser. */
  browser?: Browser;
  /** Progress callback. */
  onProgress?: (msg: string) => void;
  /** Called for each viewport right before extraction, e.g. to click through a cookie banner. */
  prepare?: (page: Page, viewport: Viewport) => Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export function walkerSource(): string {
  const candidates = [join(here, 'walker.iife.js'), join(here, '..', 'dist', 'walker.iife.js')];
  for (const c of candidates) if (existsSync(c)) return readFileSync(c, 'utf8');
  throw new Error('walker bundle not found; run `npm run build` in packages/extractor');
}

export function toUrl(input: string): string {
  if (/^[a-z]+:\/\//i.test(input)) return input;
  const abs = resolve(input);
  if (existsSync(abs)) return pathToFileURL(abs).href;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(input)) return `https://${input}`;
  throw new Error(`cannot resolve "${input}" as a URL or file`);
}

export async function capture(input: string, options: CaptureOptions = {}): Promise<O2FDocument> {
  const url = toUrl(input);
  const viewports = options.viewports?.length ? options.viewports : [{ name: 'Desktop', width: 1440, height: 900 }];
  const log = options.onProgress ?? (() => {});
  const ownBrowser = !options.browser;
  const browser = options.browser ?? (await chromium.launch({ headless: options.headless ?? true }));
  const walker = walkerSource();

  const breakpoints: Breakpoint[] = [];
  const assets: O2FDocument['assets'] = {};
  const tokens = new Map<string, Token>();
  const fonts = new Map<string, FontUsage>();
  const warnings = new Set<string>();
  let title: string | undefined;

  try {
    for (const vp of viewports) {
      const name = vp.name ?? `${vp.width}×${vp.height}`;
      log(`capturing ${name}`);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
        extraHTTPHeaders: options.headers,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: 'load', timeout: options.timeout ?? 45000 });
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => log('network did not settle; continuing'));
        if (options.waitFor) await page.waitForSelector(options.waitFor, { timeout: options.timeout ?? 45000 });
        if (options.freezeAnimations ?? true) {
          await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
        }
        if (options.scroll ?? true) await scrollThrough(page);
        await page.evaluate(() => (document as Document & { fonts: FontFaceSet }).fonts.ready);
        if (options.delay) await page.waitForTimeout(options.delay);
        if (options.prepare) await options.prepare(page, vp);
        await page.evaluate(() => window.scrollTo(0, 0));

        await page.addScriptTag({ content: walker });
        const extractOpts: ExtractOptions = {
          rootSelector: options.root,
          includeHidden: options.includeHidden,
          inlineImages: options.inlineImages,
          maxNodes: options.maxNodes,
        };
        const raw = (await page.evaluate((o) => window.__o2f.extract(o), extractOpts)) as RawExtract;
        title = title ?? raw.title;
        raw.root.name = `${raw.title || 'Page'} / ${name}`;
        breakpoints.push({ name, width: vp.width, height: vp.height, root: raw.root });
        Object.assign(assets, raw.assets);
        for (const t of raw.tokens) tokens.set(t.name, t);
        for (const f of raw.fonts) {
          const key = `${f.family}|${f.italic}`;
          const e = fonts.get(key) ?? { family: f.family, weights: [], italic: f.italic };
          for (const w of f.weights) if (!e.weights.includes(w)) e.weights.push(w);
          fonts.set(key, e);
        }
        for (const w of raw.warnings) warnings.add(`${name}: ${w}`);
        log(`${name}: ${countNodes(raw.root)} nodes, ${Object.keys(raw.assets).length} assets`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (ownBrowser) await browser.close();
  }

  const doc: O2FDocument = {
    version: O2F_VERSION,
    generator: 'open2figma-extractor/0.1.0',
    createdAt: new Date().toISOString(),
    source: { url, title },
    breakpoints,
    components: {},
    assets,
    tokens: [...tokens.values()],
    fonts: [...fonts.values()].map((f) => ({ ...f, weights: f.weights.sort((a, b) => a - b) })),
    warnings: [...warnings],
  };
  if (options.components ?? true) detectComponents(doc);
  return doc;
}

async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.max(200, window.innerHeight * 0.8);
    const max = document.documentElement.scrollHeight;
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
}

function countNodes(root: RawExtract['root']): number {
  let n = 0;
  const walk = (node: { children?: unknown[] }) => {
    n++;
    for (const c of (node.children ?? []) as { children?: unknown[] }[]) walk(c);
  };
  walk(root);
  return n;
}

export function parseViewports(spec: string): Viewport[] {
  return spec.split(',').map((s) => {
    const m = s.trim().match(/^(?:([\w-]+)=)?(\d+)x(\d+)$/i);
    if (!m) throw new Error(`bad viewport "${s}", expected WIDTHxHEIGHT or name=WIDTHxHEIGHT`);
    return { name: m[1], width: parseInt(m[2], 10), height: parseInt(m[3], 10) };
  });
}
