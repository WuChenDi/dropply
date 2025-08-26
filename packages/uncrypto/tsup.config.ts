import { defineConfig } from 'tsup'

export default defineConfig((options) => ({
  entry: ['src/crypto.node.ts', 'src/crypto.web.ts'],
  splitting: true,
  clean: true,
  dts: true,
  format: ['esm', 'cjs'],
}))
