import { defineConfig } from 'tsup'

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  splitting: true,
  clean: true,
  dts: true,
  format: ['esm'],
  platform: 'browser',
  target: ['es2020', 'chrome80', 'edge18', 'firefox80', 'node18'],
  sourcemap: !options.watch,
  minify: !options.watch,
}))
