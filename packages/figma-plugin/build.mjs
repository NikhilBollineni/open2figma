import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });
copyFileSync(join(here, 'src/ui.html'), join(here, 'dist/ui.html'));

const options = {
  entryPoints: [join(here, 'src/code.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  outfile: join(here, 'dist/code.js'),
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
