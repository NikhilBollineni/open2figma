// Bundles the in-page walker into a single IIFE that the capture driver injects.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'src/browser/walker.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__o2f',
  target: ['chrome110'],
  outfile: join(here, 'dist/walker.iife.js'),
  minify: false,
  logLevel: 'info',
});
