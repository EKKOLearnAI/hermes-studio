import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

function stripCliShebangForVitest() {
  return {
    name: 'strip-cli-shebang-for-vitest',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/')
      if (!normalizedId.endsWith('/bin/hermes-web-ui.mjs')) return null

      // Vite SSR may skip transforming .mjs files; AsyncFunction cannot evaluate a shebang.
      return { code: code.replace(/^#!.*(?:\r?\n|$)/, ''), map: null }
    },
  }
}

export default defineConfig({
  plugins: [stripCliShebangForVitest(), vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
      electron: resolve(__dirname, 'tests/mocks/electron.ts'),
      '/logo.png': resolve(__dirname, 'packages/client/public/logo.png'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
})
