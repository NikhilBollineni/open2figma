/**
 * Storybook support: reads the index of a running Storybook and captures each
 * story's iframe as its own frame.
 */
import { chromium } from 'playwright';
import type { O2FDocument } from '@open2figma/schema';
import { capture, type CaptureOptions, type Viewport } from './capture.js';

export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  type?: string;
}

export function parseStorybookIndex(json: unknown): StoryEntry[] {
  const data = json as { entries?: Record<string, StoryEntry>; stories?: Record<string, StoryEntry> };
  const entries = data.entries ?? data.stories ?? {};
  return Object.values(entries).filter((e) => !e.type || e.type === 'story').map((e) => ({ id: e.id, title: e.title, name: e.name, type: e.type }));
}

export async function fetchStorybookIndex(baseUrl: string): Promise<StoryEntry[]> {
  const base = baseUrl.replace(/\/$/, '');
  for (const path of ['/index.json', '/stories.json']) {
    const res = await fetch(base + path).catch(() => null);
    if (res && res.ok) return parseStorybookIndex(await res.json());
  }
  throw new Error(`no Storybook index found at ${base}/index.json`);
}

export interface StorybookOptions extends Omit<CaptureOptions, 'viewports' | 'root'> {
  /** Filter stories by title/name substring or regex. */
  filter?: string | RegExp;
  viewport?: Viewport;
}

export async function captureStorybook(baseUrl: string, options: StorybookOptions = {}): Promise<O2FDocument> {
  const base = baseUrl.replace(/\/$/, '');
  const stories = await fetchStorybookIndex(base);
  const filter = options.filter instanceof RegExp ? options.filter : options.filter ? new RegExp(options.filter, 'i') : null;
  const selected = filter ? stories.filter((s) => filter.test(`${s.title}/${s.name}`)) : stories;
  if (!selected.length) throw new Error('no stories matched');

  const browser = options.browser ?? (await chromium.launch({ headless: options.headless ?? true }));
  const vp = options.viewport ?? { width: 1024, height: 768 };
  try {
    let merged: O2FDocument | null = null;
    for (const story of selected) {
      options.onProgress?.(`story ${story.title} / ${story.name}`);
      const url = `${base}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
      const doc = await capture(url, { ...options, browser, root: '#storybook-root, #root', viewports: [{ ...vp, name: `${story.title} / ${story.name}` }], components: false });
      if (!merged) merged = doc;
      else {
        merged.breakpoints.push(...doc.breakpoints);
        Object.assign(merged.assets, doc.assets);
        for (const t of doc.tokens) if (!merged.tokens.some((x) => x.name === t.name)) merged.tokens.push(t);
        for (const f of doc.fonts) if (!merged.fonts.some((x) => x.family === f.family && x.italic === f.italic)) merged.fonts.push(f);
        merged.warnings.push(...doc.warnings);
      }
    }
    merged!.source = { url: base, title: 'Storybook' };
    return merged!;
  } finally {
    if (!options.browser) await browser.close();
  }
}
