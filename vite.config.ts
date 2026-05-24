import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { ProxyOptions } from 'vite'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
import pkg from './package.json'

const BACKEND = 'http://127.0.0.1:8648'

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

function createProxyConfig(): ProxyOptions {
  return {
    target: BACKEND,
    changeOrigin: true,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.removeHeader('origin')
        proxyReq.removeHeader('referer')
      })
      proxy.on('proxyRes', (proxyRes) => {
        proxyRes.headers['cache-control'] = 'no-cache'
        proxyRes.headers['x-accel-buffering'] = 'no'
      })
    },
  }
}

export default defineConfig({
  root: 'packages/client',
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_GIT_SHA__: JSON.stringify(gitMetadata.sha),
    __APP_GIT_BRANCH__: JSON.stringify(gitMetadata.branch),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/client/src'),
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // Use esbuild for minification (much faster than terser)
    minify: 'esbuild',
    // Disable sourcemap generation for faster builds
    sourcemap: false,
    target: 'es2020',
    // Increase chunk size warning limit (default: 500KB)
    chunkSizeWarningLimit: 1000,
    // CSS code splitting for better caching
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Manual chunk splitting to speed up rendering
        manualChunks(id) {
          // Separate large heavy packages to avoid blocking other chunks
          if (id.includes('node_modules/monaco-editor')) {
            return 'monaco-editor'
          }
          if (id.includes('node_modules/mermaid')) {
            return 'mermaid'
          }
          if (id.includes('node_modules/@xterm')) {
            return 'xterm'
          }
          if (id.includes('node_modules')) {
            if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router')) {
              return 'vue-vendor'
            }
            if (id.includes('naive-ui')) {
              return 'ui-vendor'
            }
            return 'vendor'
          }
        },
        // Optimize chunk file names for better caching
        chunkFileNames: 'assets/js/[name]-[hash].js',
        entryFileNames: 'assets/js/[name]-[hash].js',
        assetFileNames: 'assets/[ext]/[name]-[hash].[ext]',
      },
    },
  },
  optimizeDeps: {
    // Pre-bundle all large dependencies for faster builds
    include: [
      'monaco-editor',
      'mermaid',
      'vue',
      'vue-router',
      'pinia',
      'naive-ui',
    ],
  },
  server: {
    proxy: {
      '/api': createProxyConfig(),
      '/v1': createProxyConfig(),
      '/health': createProxyConfig(),
      '/upload': createProxyConfig(),
      '/webhook': createProxyConfig(),
      '/socket.io': {
        target: BACKEND,
        ws: true,
      },
    },
  },
})
