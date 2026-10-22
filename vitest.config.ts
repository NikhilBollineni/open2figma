import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests import the schema package from source so they never depend on a prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@open2figma/schema': fileURLToPath(new URL('./packages/schema/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
