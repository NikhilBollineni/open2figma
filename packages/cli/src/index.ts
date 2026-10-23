#!/usr/bin/env node
import { Command } from 'commander';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { capture, captureStorybook, parseViewports } from '@open2figma/extractor';
import { validateDocument, type O2FDocument } from '@open2figma/schema';
import { startBridge, pushDocument } from './serve.js';
import { summarize, tree } from './inspect.js';
import { renderHtml } from './preview.js';

const program = new Command();
program
  .name('open2figma')
  .description('Turn any web page, component or Storybook into native, editable Figma designs.')
  .version('0.1.0');

const log = (msg: string) => process.stderr.write(`› ${msg}\n`);

async function writeDoc(doc: O2FDocument, out: string | undefined, push: string | undefined, source: string): Promise<void> {
  const json = JSON.stringify(doc);
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(out, json);
    log(`wrote ${out} (${(json.length / 1024).toFixed(0)} KB)`);
  }
  if (push) {
    await pushDocument(push, json, source);
    log(`pushed to ${push}`);
  }
  if (!out && !push) process.stdout.write(json);
}

function parseHeaders(list: string[] | undefined): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  const out: Record<string, string> = {};
  for (const h of list) {
    const i = h.indexOf('=');
    if (i < 0) throw new Error(`bad header "${h}", expected Name=Value`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

program
  .command('capture')
  .description('Capture a URL or local HTML file')
  .argument('<input>', 'URL or path to an HTML file')
  .option('-o, --out <file>', 'write the O2F document here (default: stdout)')
  .option('-v, --viewport <list>', 'comma list of WIDTHxHEIGHT or name=WIDTHxHEIGHT', 'Desktop=1440x900')
  .option('-r, --root <selector>', 'capture only this element')
  .option('-w, --wait-for <selector>', 'wait for this selector before capturing')
  .option('-d, --delay <ms>', 'extra delay after load', (v) => parseInt(v, 10))
  .option('-H, --header <name=value>', 'extra HTTP header (repeatable)', (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option('--no-images', 'do not inline images')
  .option('--no-components', 'skip component detection')
  .option('--no-scroll', 'do not pre-scroll for lazy content')
  .option('--include-hidden', 'include visibility:hidden elements')
  .option('--max-nodes <n>', 'stop after this many nodes', (v) => parseInt(v, 10), 20000)
  .option('--headed', 'show the browser')
  .option('--push [url]', 'push to a running bridge (default http://localhost:4747)')
  .option('--summary', 'print a summary to stderr')
  .action(async (input: string, o) => {
    const doc = await capture(input, {
      viewports: parseViewports(o.viewport),
      root: o.root,
      waitFor: o.waitFor,
      delay: o.delay,
      headers: parseHeaders(o.header),
      inlineImages: o.images,
      components: o.components,
      scroll: o.scroll,
      includeHidden: o.includeHidden,
      maxNodes: o.maxNodes,
      headless: !o.headed,
      onProgress: log,
    });
    const push = o.push === true ? 'http://localhost:4747' : o.push;
    await writeDoc(doc, o.out, push, input);
    if (o.summary) process.stderr.write(summarize(doc) + '\n');
  });

program
  .command('storybook')
  .description('Capture every story of a running Storybook')
  .argument('<url>', 'Storybook base URL, e.g. http://localhost:6006')
  .option('-o, --out <file>', 'write the O2F document here')
  .option('-f, --filter <pattern>', 'only stories whose "title/name" matches this regex')
  .option('-v, --viewport <WxH>', 'story viewport', '1024x768')
  .option('--no-images', 'do not inline images')
  .option('--push [url]', 'push to a running bridge')
  .action(async (url: string, o) => {
    const vp = parseViewports(o.viewport)[0];
    const doc = await captureStorybook(url, { filter: o.filter, viewport: vp, inlineImages: o.images, onProgress: log });
    const push = o.push === true ? 'http://localhost:4747' : o.push;
    await writeDoc(doc, o.out, push, url);
    process.stderr.write(summarize(doc) + '\n');
  });

program
  .command('serve')
  .description('Run the local bridge the Figma plugin pulls from')
  .argument('[file]', 'serve this O2F file (re-read when it changes)')
  .option('-p, --port <n>', 'port', (v) => parseInt(v, 10), 4747)
  .action(async (file: string | undefined, o) => {
    const bridge = await startBridge({ port: o.port, file, log });
    log(`bridge listening on http://localhost:${bridge.port}`);
    log(file ? `serving ${file}` : 'waiting for `open2figma capture <url> --push`');
    log('in Figma: Plugins → open2figma → "Pull from local bridge"');
    await new Promise(() => undefined);
  });

program
  .command('inspect')
  .description('Summarise an O2F document')
  .argument('<file>')
  .option('-t, --tree [depth]', 'print the node tree')
  .option('--html <out>', 'render a standalone HTML preview of the document')
  .action(async (file: string, o) => {
    const doc = JSON.parse(await readFile(file, 'utf8')) as O2FDocument;
    const problems = validateDocument(doc);
    if (o.html) {
      await writeFile(o.html, renderHtml(doc));
      log(`wrote preview ${o.html}`);
    }
    process.stdout.write(summarize(doc) + '\n');
    if (problems.length) process.stdout.write(`\nvalidation problems:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    if (o.tree) process.stdout.write('\n' + tree(doc, o.tree === true ? 4 : parseInt(o.tree, 10)) + '\n');
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
