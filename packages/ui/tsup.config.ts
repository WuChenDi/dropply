import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  splitting: true,
  clean: true,
  dts: true,
  format: ['esm'],
  treeshake: true,
  sourcemap: !options.watch,
  minify: !options.watch,
}));
