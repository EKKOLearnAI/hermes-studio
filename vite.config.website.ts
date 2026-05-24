import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
import pkg from './package.json'

function getGitBuildMetadata(repoRoot: string) {
  const sha = process.env.HERMES_WEB_UI_GIT_SHA?.trim()
    || process.env.GIT_SHA?.trim()
    || process.env.GITHUB_SHA?.trim()
    || process.env.CI_COMMIT_SHA?.trim()
    || (() => {
      try {
        return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf-8' }).trim()
      } catch {
        return ''
      }
    })()
    || 'unknown'

  const branch = process.env.HERMES_WEB_UI_GIT_BRANCH?.trim()
    || process.env.GIT_BRANCH?.trim()
    || process.env.GITHUB_REF_NAME?.trim()
    || process.env.CI_COMMIT_REF_NAME?.trim()
    || (() => {
      try {
        return execFileSync('git', ['-C', repoRoot, 'branch', '--show-current'], { encoding: 'utf-8' }).trim()
      } catch {
        return ''
      }
    })()
    || ''

  return { sha, branch: branch === 'HEAD' ? '' : branch }
}

const gitMetadata = getGitBuildMetadata(__dirname)

export default defineConfig({
  root: 'packages/website',
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_GIT_SHA__: JSON.stringify(gitMetadata.sha),
    __APP_GIT_BRANCH__: JSON.stringify(gitMetadata.branch),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/website/src'),
      '@client': resolve(__dirname, 'packages/client/src'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        additionalData: `@use "@/styles/variables" as *;\n`,
      },
    },
  },
  build: {
    outDir: '../../dist/website',
    emptyOutDir: true,
    minify: 'esbuild',
    sourcemap: false,
    target: 'es2020',
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('vue') || id.includes('vue-router') || id.includes('vue-i18n') || id.includes('pinia')) {
              return 'vue-vendor'
            }
            if (id.includes('naive-ui')) {
              return 'ui-vendor'
            }
            return 'vendor'
          }
        },
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
  },
  server: {
    port: 3000,
  },
})
