import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  platform: 'node',
  // Emit the conventional dual-package layout: index.js/.d.ts (ESM) + index.cjs/.d.cts (CJS).
  // Dependencies (sharp, bytes, ...) are externalized automatically.
  outExtensions: ({ format }) =>
    format === 'es' ? { js: '.js', dts: '.d.ts' } : { js: '.cjs', dts: '.d.cts' },
})
