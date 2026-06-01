import type { Component } from 'vue'

export interface GeneratedWidgetModule {
  default: Component
}

export interface GeneratedWidgetEntry {
  widgetName: string
  componentPath: string
  modulePath: string
  loader: () => Promise<unknown>
}

const generatedWidgetModules = import.meta.glob('../../../components/generated/*.vue')

export function normalizeGeneratedWidgetName(input: string): string | null {
  const cleaned = input
    .replace(/\.vue$/i, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()

  if (!cleaned) return null

  const name = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('')

  return /^[A-Z][A-Za-z0-9]{1,63}$/.test(name) ? name : null
}

function extractWidgetName(path: string): string | null {
  const match = path.match(/\/([A-Z][A-Za-z0-9]{1,63})\.vue$/)
  return match ? match[1] : null
}

const generatedWidgetEntries: GeneratedWidgetEntry[] = Object.entries(generatedWidgetModules)
  .map(([modulePath, loader]) => {
    const widgetName = extractWidgetName(modulePath)
    if (!widgetName) return null
    return {
      widgetName,
      componentPath: `packages/client/src/components/generated/${widgetName}.vue`,
      modulePath,
      loader,
    }
  })
  .filter((entry): entry is GeneratedWidgetEntry => entry !== null)
  .sort((a, b) => a.widgetName.localeCompare(b.widgetName))

export function listGeneratedWidgets(): GeneratedWidgetEntry[] {
  return generatedWidgetEntries
}

export function findGeneratedWidget(widgetName: string): GeneratedWidgetEntry | null {
  const normalized = normalizeGeneratedWidgetName(widgetName)
  if (!normalized) return null
  return generatedWidgetEntries.find(entry => entry.widgetName === normalized) || null
}
