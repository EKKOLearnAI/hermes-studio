/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __APP_GIT_SHA__: string
declare const __APP_GIT_BRANCH__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
