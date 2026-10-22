/**
 * Maps CSS font requests (family stack + numeric weight + italic) onto fonts
 * actually available in Figma, and loads each resolved font once.
 */
import type { TextStyle } from '@open2figma/schema';

const WEIGHT_WORDS: [RegExp, number][] = [
  [/hairline|thin/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/\blight\b/i, 300],
  [/regular|normal|book|roman|\btext\b/i, 400],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

export function weightOfStyle(style: string): number {
  for (const [re, w] of WEIGHT_WORDS) if (re.test(style)) return w;
  return 400;
}

export function styleIsItalic(style: string): boolean {
  return /italic|oblique/i.test(style);
}

const GENERIC: Record<string, string[]> = {
  'sans-serif': ['Inter', 'Roboto', 'Helvetica', 'Arial'],
  'system-ui': ['Inter', 'SF Pro Text', 'Roboto', 'Helvetica'],
  '-apple-system': ['SF Pro Text', 'Inter', 'Helvetica'],
  blinkmacsystemfont: ['SF Pro Text', 'Inter', 'Helvetica'],
  'segoe ui': ['Segoe UI', 'Inter'],
  serif: ['Georgia', 'Times New Roman', 'Times'],
  monospace: ['Roboto Mono', 'SF Mono', 'Menlo', 'Courier New', 'Courier'],
  'ui-monospace': ['SF Mono', 'Menlo', 'Roboto Mono', 'Courier New'],
  'ui-sans-serif': ['Inter', 'SF Pro Text', 'Helvetica'],
  'ui-serif': ['Georgia', 'Times New Roman'],
  cursive: ['Comic Sans MS'],
};

export class FontResolver {
  private available = new Map<string, Map<string, string>>(); // lower family -> (lower style -> style)
  private families = new Map<string, string>(); // lower -> canonical
  private loaded = new Set<string>();
  private cache = new Map<string, FontName>();
  public substitutions = new Map<string, string>();

  constructor(private fallback = 'Inter') {}

  async init(): Promise<void> {
    const fonts = await figma.listAvailableFontsAsync();
    for (const f of fonts) {
      const fam = f.fontName.family.toLowerCase();
      if (!this.available.has(fam)) {
        this.available.set(fam, new Map());
        this.families.set(fam, f.fontName.family);
      }
      this.available.get(fam)!.set(f.fontName.style.toLowerCase(), f.fontName.style);
    }
  }

  /** Picks the closest available family/style for a text style. */
  resolve(style: Pick<TextStyle, 'fontFamily' | 'fontStack' | 'fontWeight' | 'italic'>): FontName {
    const key = `${style.fontStack.join('|')}|${style.fontWeight}|${style.italic}`;
    const hit = this.cache.get(key);
    if (hit) return hit;

    const candidates: string[] = [];
    for (const fam of style.fontStack.length ? style.fontStack : [style.fontFamily]) {
      const g = GENERIC[fam.toLowerCase()];
      if (g) candidates.push(...g);
      else candidates.push(fam);
    }
    candidates.push(this.fallback, 'Inter', 'Roboto', 'Arial');

    let family: string | undefined;
    for (const c of candidates) {
      const fam = this.families.get(c.toLowerCase());
      if (fam) {
        family = fam;
        break;
      }
    }
    if (!family) family = this.families.values().next().value ?? this.fallback;
    if (family.toLowerCase() !== style.fontFamily.toLowerCase()) this.substitutions.set(style.fontFamily, family);

    const styles = [...(this.available.get(family.toLowerCase())?.values() ?? ['Regular'])];
    const chosen = pickStyle(styles, style.fontWeight, style.italic);
    const name = { family, style: chosen };
    this.cache.set(key, name);
    return name;
  }

  async load(name: FontName): Promise<void> {
    const key = `${name.family}/${name.style}`;
    if (this.loaded.has(key)) return;
    await figma.loadFontAsync(name);
    this.loaded.add(key);
  }

  async resolveAndLoad(style: TextStyle): Promise<FontName> {
    const name = this.resolve(style);
    await this.load(name);
    return name;
  }
}

export function pickStyle(styles: string[], weight: number, italic: boolean): string {
  if (!styles.length) return 'Regular';
  let best = styles[0];
  let bestScore = Infinity;
  for (const s of styles) {
    const w = weightOfStyle(s);
    const it = styleIsItalic(s);
    // weight distance dominates; italic mismatch costs the same as 250 weight units
    const score = Math.abs(w - weight) + (it === italic ? 0 : 250) + (/condensed|narrow|expanded|display|mono/i.test(s) ? 50 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}
