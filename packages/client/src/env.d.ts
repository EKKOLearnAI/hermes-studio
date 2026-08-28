/// <reference types="vite/client" />

declare const __APP_VERSION__: string

interface Window {
  __HERMES_BOOT_ANIMATION_STARTED_AT__?: number
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
