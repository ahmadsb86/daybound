import { defineConfig } from 'vite';

// VITE_DEMO=1 builds a single-file, sync-free demo (fonts inlined) for trying the UI anywhere.
const demo = process.env.VITE_DEMO === '1';

export default defineConfig({
  build: {
    target: 'es2022',
    assetsInlineLimit: demo ? 100_000_000 : 4096,
    cssCodeSplit: !demo,
    outDir: demo ? 'dist-demo' : 'dist',
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
