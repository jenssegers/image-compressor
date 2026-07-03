import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  platform: 'node',
  // Bundle the CLI-only deps into cli.js so they can stay out of `dependencies`;
  // library consumers then never install them. sharp/bytes stay external (sharp is
  // native and can't be bundled; both are used by the library entry).
  deps: { alwaysBundle: ['commander', 'picocolors', 'tinyglobby'] },
  // Emit the conventional dual-package layout: index.js/.d.ts (ESM) + index.cjs/.d.cts (CJS).
  outExtensions: ({ format }) =>
    format === 'es' ? { js: '.js', dts: '.d.ts' } : { js: '.cjs', dts: '.d.cts' },
})
