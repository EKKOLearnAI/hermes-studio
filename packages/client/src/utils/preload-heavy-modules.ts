let monacoEditorPreload: Promise<typeof import('monaco-editor')> | null = null
let mermaidPreload: Promise<typeof import('mermaid')> | null = null

export function preloadMonacoEditor(): Promise<typeof import('monaco-editor')> {
  monacoEditorPreload ||= import('monaco-editor')
  return monacoEditorPreload
}

export function preloadMermaidRenderer(): Promise<typeof import('mermaid')> {
  mermaidPreload ||= import('mermaid')
  return mermaidPreload
}
