import { vi } from 'vitest'

const workerId = process.env.VITEST_POOL_ID || process.env.VITEST_WORKER_ID || '0'
const pathSeparator = process.platform === 'win32' ? '\\' : '/'
const tempRoot = (
  process.env.TMPDIR
  || process.env.TEMP
  || process.env.TMP
  || (process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp')
).replace(/[\\/]+$/, '')
const workerStateDir = `${tempRoot}${pathSeparator}hermes-studio-vitest-${process.pid}-${workerId}`
process.env.HERMES_WEB_UI_HOME = workerStateDir
process.env.HERMES_WEBUI_STATE_DIR = workerStateDir
process.env.UPLOAD_DIR = `${workerStateDir}${pathSeparator}upload`

// Vite injects this at build time; unit tests need a stable fallback.
;(globalThis as any).__APP_VERSION__ = 'test'
// Client-only setup (window/localStorage only exist in jsdom)
if (typeof window !== 'undefined') {
  // Mock window.matchMedia
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })

  // Mock localStorage
  const store: Record<string, string> = {}
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value }),
      removeItem: vi.fn((key: string) => { delete store[key] }),
      clear: vi.fn(() => { for (const k of Object.keys(store)) delete store[k] }),
      get length() { return Object.keys(store).length },
      key: vi.fn((i: number) => Object.keys(store)[i] ?? null),
    },
  })
}
