import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { Plugin, ProxyOptions } from 'vite'
import { resolve } from 'path'
import { createRequire } from 'node:module'
import pkg from './package.json'

const FRONTEND_PORT = Number(process.env.HERMES_WEB_UI_FRONTEND_PORT || 8649)
const BACKEND_PORT = process.env.HERMES_WEB_UI_BACKEND_PORT || '8648'
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`
const optionalRequire = createRequire(import.meta.url)
const auroraPwaManifest = {
  name: 'Aurora OS',
  short_name: 'Aurora',
  description: 'Aurora OS Quant Station and AI Operating Layer',
  start_url: '/#/hermes/chat',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  theme_color: '#0a0a14',
  background_color: '#05050a',
  icons: [
    {
      src: '/icons/aurora-touch-icon.svg',
      sizes: '180x180',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    },
    {
      src: '/icons/aurora-touch-icon.svg',
      sizes: '512x512',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    },
  ],
}

function createProxyConfig(): ProxyOptions {
  return {
    target: BACKEND,
    changeOrigin: true,
    ws: true,
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

function auroraPwaFallbackPlugin(): Plugin {
  return {
    name: 'aurora-pwa-fallback',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: `${JSON.stringify(auroraPwaManifest, null, 2)}\n`,
      })
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: [
          "const AURORA_CACHE = 'aurora-os-v0.1';",
          "self.addEventListener('install', event => { self.skipWaiting(); event.waitUntil(caches.open(AURORA_CACHE)); });",
          "self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });",
          "self.addEventListener('fetch', event => {",
          "  if (event.request.method !== 'GET') return;",
          "  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));",
          '});',
          '',
        ].join('\n'),
      })
    },
  }
}

function createAuroraPwaPlugin(): Plugin {
  try {
    const pwaModule = optionalRequire('vite-plugin-pwa') as {
      VitePWA?: (options: Record<string, unknown>) => Plugin
    }
    if (typeof pwaModule.VitePWA === 'function') {
      return pwaModule.VitePWA({
        registerType: 'autoUpdate',
        manifest: auroraPwaManifest,
        injectRegister: 'auto',
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
          navigateFallback: '/index.html',
        },
        devOptions: {
          enabled: false,
        },
      })
    }
  } catch {
    // vite-plugin-pwa is optional here; fallback emits the manifest and service worker.
  }
  return auroraPwaFallbackPlugin()
}

export default defineConfig({
  root: 'packages/client',
  plugins: [vue(), createAuroraPwaPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
        manualChunks(id: string) {
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
            if (id.includes('node_modules/markdown-it')) {
              return 'markdown-vendor'
            }
            if (id.includes('node_modules/highlight.js')) {
              return 'highlight-vendor'
            }
            if (id.includes('node_modules/lightweight-charts')) {
              return 'charts-vendor'
            }
            if (id.includes('node_modules/socket.io-client') || id.includes('node_modules/engine.io-client')) {
              return 'realtime-vendor'
            }
            if (id.includes('node_modules/@multiavatar')) {
              return 'avatar-vendor'
            }
            if (id.includes('node_modules/qrcode')) {
              return 'qr-vendor'
            }
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
    port: FRONTEND_PORT,
    strictPort: true,
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
