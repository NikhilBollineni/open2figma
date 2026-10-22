# open2figma

**Open-source "anything to Figma".** Point it at a URL, a local HTML file or a running Storybook and get native, editable Figma designs: real auto-layout frames, text with per-run styles, images, vectors, components with instances, and variables generated from your CSS custom properties.

The closed tools in this space (html.to.design, story.to.design, Anima, Locofy) all keep the converter behind a subscription. open2figma is MIT licensed, runs on your machine or in CI, and never sends your pages anywhere.

```
┌──────────────┐   Playwright    ┌──────────────┐   JSON (O2F)   ┌──────────────┐
│  URL / HTML  │ ──────────────▶ │  extractor   │ ─────────────▶ │ Figma plugin │
│  Storybook   │  real Chromium  │  DOM walker  │  bridge/file   │  native nodes│
└──────────────┘                 └──────────────┘                └──────────────┘
```

## Why it is better than pasting screenshots or the closed tools

| Capability | open2figma | Typical closed converter |
| --- | --- | --- |
| Auto-layout from flex, grid **and** plain block flow | ✅ inferred and verified against rendered positions | flex only, often absolute |
| Falls back to absolute positioning only when the simulation disagrees with the browser | ✅ never visually wrong | ❌ frequent drift |
| Repeated elements become one component plus instances with text overrides | ✅ | rarely |
| CSS custom properties become Figma variables and fills are bound to them | ✅ | ❌ |
| Multiple breakpoints in one import, side by side | ✅ | one at a time |
| Per-run text styles (bold spans, links, underline, letter-spacing, line-clamp) | ✅ | partial |
| SVG kept as vectors, sprites inlined, `currentColor` resolved | ✅ | rasterised |
| Storybook: every story becomes a frame | ✅ | paid add-on |
| Runs in CI and pushes to a local bridge the plugin pulls from | ✅ | ❌ |
| Self-hosted, no account, no upload | ✅ | ❌ |

## Quick start

Requirements: Node 20+, the Figma desktop app.

```bash
git clone https://github.com/NikhilBollineni/open2figma && cd open2figma
npm install
npx playwright install chromium
npm run build
```

Capture a page at two breakpoints:

```bash
node packages/cli/dist/index.js capture https://example.com \
  --viewport "Desktop=1440x900,Mobile=390x844" \
  -o example.o2f.json --summary
```

Start the local bridge so the plugin can pull the file:

```bash
node packages/cli/dist/index.js serve example.o2f.json
```

Install the plugin in Figma: **Plugins → Development → Import plugin from manifest…** and choose `packages/figma-plugin/manifest.json`. Run it, click **Pull**, then **Import into Figma**.

The bundled example page captures in a few seconds:

```bash
npm run capture:example
node packages/cli/dist/index.js inspect examples/landing/landing.o2f.json --tree
```

## How the conversion works

1. **Render for real.** Playwright loads the page in headless Chromium at each requested viewport, pre-scrolls to trigger lazy content, freezes animations and waits for fonts.
2. **Walk the DOM.** An injected script visits every rendered element and reads computed styles and layout boxes. Each element becomes a `FRAME`, `TEXT`, `RECTANGLE`, `ELLIPSE` or `SVG` node in the O2F format (`packages/schema`).
3. **Infer auto-layout.** For every frame the walker asks: could Figma reproduce these child positions with an auto-layout? Flex and grid settings are mapped directly; plain block stacks and inline rows are detected geometrically. Every candidate is **simulated** the way Figma lays out children and compared against the browser's positions. If nothing matches within 1.5 px, the frame stays absolute, so the import is never wrong, only occasionally less editable. Leading and trailing block margins are folded into padding so frames become huggable.
4. **Detect components.** Subtrees with identical structure (tag, stable classes, child structure; text, sizes and hashed class names are ignored) become one main component and N instances. Text and image overrides are applied to the instances.
5. **Collect tokens.** Custom properties declared on `:root` or `html` are classified as colour, number or string. Any fill, stroke or text colour whose value equals a token is linked to it; the plugin creates a variable collection and binds the paints.
6. **Build native nodes.** The Figma plugin maps the tree one-to-one onto the Plugin API: `layoutMode`, padding, gaps, `layoutSizingHorizontal/Vertical` (FILL/HUG/FIXED with the API's constraints respected), per-range text styles, image fills, `createNodeFromSvg`, grid auto-layout where the Figma version supports it, and sections for multi-breakpoint imports. Fonts are resolved against what Figma actually has, picking the closest weight and italic, with substitutions reported.

## CLI reference

```
open2figma capture <url|file>      capture one page
  -o, --out <file>                 write O2F JSON (default: stdout)
  -v, --viewport <list>            "Desktop=1440x900,Mobile=390x844"
  -r, --root <selector>            capture a single element
  -w, --wait-for <selector>        wait before capturing
  -d, --delay <ms>                 extra settle time
  -H, --header Name=Value          extra HTTP header (repeatable; auth for staging)
  --no-images / --no-components / --no-scroll / --include-hidden
  --headed                         watch the browser
  --push [url]                     POST to a running bridge (default localhost:4747)
  --summary                        print statistics

open2figma storybook <url>         capture every story of a running Storybook
  -f, --filter <regex>             only stories matching "Title/Name"
  -v, --viewport <WxH>

open2figma serve [file]            local bridge for the plugin (port 4747)
open2figma inspect <file> [--tree] summarise a document
```

Programmatic use:

```ts
import { capture } from '@open2figma/extractor';

const doc = await capture('https://example.com', {
  viewports: [{ name: 'Desktop', width: 1440, height: 900 }],
  prepare: async (page) => { await page.click('text=Accept cookies'); },
});
```

## Continuous design sync

`.github/workflows/design-sync.yml` shows the pattern: on every push to `main`, capture the deployed preview and upload the O2F file as an artifact. Anyone on the design team downloads it and drops it on the plugin, or you run `open2figma serve` on a shared machine. Because the O2F format is plain JSON it also diffs nicely in a pull request.

## The O2F format

A deliberately Figma-shaped, DOM-free intermediate representation. See `packages/schema/src/index.ts`. Other sources can target it (React Native, Sketch exports, design-token files) and other sinks can consume it (Penpot, code generators). `validateDocument()` runs on both sides.

## Known limitations

- Vertical stacks with **uneven margins** (a heading with 20 px below it, then paragraphs with 32 px) stay absolutely positioned, because Figma has no per-child margins. Everything still lands pixel-exact.
- `::before` / `::after` pseudo-elements with content are counted and reported but not imported, since the browser exposes no boxes for them.
- Radial and conic gradients are approximated by their first stop; CSS transforms are baked into the captured box rather than carried as rotation.
- Images that fail CORS are replaced by a grey placeholder and listed in the warnings. Figma accepts PNG and JPEG only; SVG, WebP, AVIF and GIF images are rasterised during capture.
- Figma requires fonts to be installed locally or available in Figma; missing families are substituted and the substitution is reported.

## Development

```bash
npm test            # vitest: CSS parsing, layout inference, components, plugin builder (mock Figma API)
npm run typecheck
npm run build
npm run -w @open2figma/figma-plugin watch   # rebuild the plugin on change
```

Repository layout:

```
packages/schema        O2F types, validation, factories
packages/extractor     Playwright driver + injected DOM walker + component detection + Storybook
packages/cli           open2figma command line and local bridge
packages/figma-plugin  Figma plugin (manifest.json, src/code.ts, src/ui.html)
examples/landing       sample page used by `npm run capture:example`
```

## Roadmap

- Penpot exporter from the same O2F document
- Interactive states: capture `:hover` / `:focus` variants as component properties
- Text style and effect style generation alongside variables
- Figma REST ingestion for teams that cannot run plugins
- Visual regression check: capture the Figma render and diff against the browser screenshot

## License

MIT
