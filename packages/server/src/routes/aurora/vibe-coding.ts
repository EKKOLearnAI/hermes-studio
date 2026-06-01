import Router from '@koa/router'
import { appendFile, mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { resolve, sep } from 'path'
import { parseLLMJSON } from '../../lib/llm-json'
import { generateHermesText } from '../../services/hermes/dynamic-llm'

export const auroraVibeRoutes = new Router()

type SecuritySeverity = 'warning' | 'danger'

interface SecurityReportItem {
  id: string
  pattern: string
  message: string
  severity: SecuritySeverity
}

interface VibeBuildBody {
  intent?: unknown
}

interface VibeApplyBody {
  buildId?: unknown
  widgetName?: unknown
  code?: unknown
  spec?: unknown
}

interface LlmWidgetPayload {
  spec?: unknown
  uiMock?: unknown
  code?: unknown
  widgetName?: unknown
}

interface NormalizedWidgetPayload {
  spec: string
  uiMock: string
  code: string
  widgetName: string
}

interface WidgetAuditEntry {
  buildId?: string
  widgetName?: string
  spec?: string
  securityReport?: SecurityReportItem[]
  appliedAt?: string
}

interface GeneratedWidgetPermissionManifest {
  schemaVersion: 1
  widgetName: string
  componentPath: string
  buildId?: string
  permissions: {
    network: false
    localStorage: false
    workingMemory: false
    cookies: false
    filesystem: false
  }
  security: {
    status: 'passed' | 'blocked'
    scannedAt: string
    blockedPatterns: SecurityReportItem[]
  }
  provenance: {
    source: 'aurora-vibe-coding'
    spec?: string
    appliedAt: string
  }
}

const GENERATED_DIR = resolve(process.cwd(), 'packages/client/src/components/generated')
const AUDIT_LOG_PATH = resolve(GENERATED_DIR, '.aurora-vibe-audit.jsonl')
const MAX_INTENT_LENGTH = 1200
const MAX_CODE_LENGTH = 80_000

const SECURITY_PATTERNS: Array<{
  id: string
  pattern: RegExp
  label: string
  message: string
}> = [
  {
    id: 'eval',
    pattern: /\beval\s*\(/i,
    label: 'eval(',
    message: 'Dynamic eval execution is not allowed in generated widgets.',
  },
  {
    id: 'window-location',
    pattern: /\bwindow\.location\b/i,
    label: 'window.location',
    message: 'Generated widgets may not navigate or mutate window.location.',
  },
  {
    id: 'local-storage',
    pattern: /\blocalStorage\b/i,
    label: 'localStorage',
    message: 'Generated widgets may not silently read or write localStorage.',
  },
  {
    id: 'document-cookie',
    pattern: /\bdocument\.cookie\b/i,
    label: 'document.cookie',
    message: 'Generated widgets may not access cookies.',
  },
  {
    id: 'fs',
    pattern: /\bfs\./i,
    label: 'fs.',
    message: 'Filesystem APIs are blocked in client-side generated widgets.',
  },
  {
    id: 'child-process',
    pattern: /\bchild_process\b/i,
    label: 'child_process',
    message: 'Process execution APIs are blocked.',
  },
]

function stringBodyField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`Missing ${name}`)
  const trimmed = value.replace(/\r/g, '').trim()
  if (!trimmed) throw new Error(`Missing ${name}`)
  if (trimmed.length > maxLength) throw new Error(`${name} is too long`)
  return trimmed
}

function sanitizeWidgetName(input: string): string {
  const words = input
    .replace(/\.vue$/i, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)

  const name = words
    .map(word => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('')
    .replace(/[^A-Za-z0-9]/g, '')

  const fallback = 'AuroraGeneratedWidget'
  const normalized = name || fallback
  return /^[A-Za-z]/.test(normalized) ? normalized.slice(0, 64) : `${fallback}${normalized}`.slice(0, 64)
}

function assertSafeWidgetName(widgetName: string): string {
  const normalized = sanitizeWidgetName(widgetName)
  if (!/^[A-Z][A-Za-z0-9]{1,63}$/.test(normalized)) {
    throw new Error('Invalid widgetName')
  }
  return normalized
}

function assertSafeTargetPath(widgetName: string): string {
  const safeName = assertSafeWidgetName(widgetName)
  const target = resolve(GENERATED_DIR, `${safeName}.vue`)
  const prefix = `${GENERATED_DIR}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error('Unsafe generated component path')
  }
  return target
}

function assertSafeManifestPath(widgetName: string): string {
  const safeName = assertSafeWidgetName(widgetName)
  const target = resolve(GENERATED_DIR, `${safeName}.manifest.json`)
  const prefix = `${GENERATED_DIR}${sep}`
  if (!target.startsWith(prefix)) {
    throw new Error('Unsafe generated manifest path')
  }
  return target
}

function scanCode(code: string): SecurityReportItem[] {
  return SECURITY_PATTERNS
    .filter(item => item.pattern.test(code))
    .map(item => ({
      id: item.id,
      pattern: item.label,
      message: item.message,
      severity: 'danger' as const,
    }))
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:vue|html|ts|typescript)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function validateVueSfc(code: string): string {
  const clean = stripCodeFence(code)
  if (!clean.includes('<template') || !clean.includes('<script setup')) {
    throw new Error('Generated code must be a Vue SFC with <template> and <script setup>.')
  }
  if (clean.length > MAX_CODE_LENGTH) throw new Error('Generated code is too long.')
  return clean
}

function createPatchDiff(widgetName: string, code: string): string {
  const file = `packages/client/src/components/generated/${widgetName}.vue`
  const lines = code.split('\n')
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..aurora',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`),
  ].join('\n')
}

function fallbackWidgetName(intent: string): string {
  const core = intent
    .replace(/\b(build|create|make|generate|a|an|the|widget|component)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return sanitizeWidgetName(core ? `${core} Widget` : 'AuroraGeneratedWidget')
}

function normalizeLlmPayload(raw: unknown, intent: string): NormalizedWidgetPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('LLM response must be a JSON object.')
  }
  const data = raw as LlmWidgetPayload
  const spec = stringBodyField(data.spec, 'spec', 2400)
  const uiMock = stringBodyField(data.uiMock, 'uiMock', 2400)
  const code = validateVueSfc(stringBodyField(data.code, 'code', MAX_CODE_LENGTH))
  const widgetName = assertSafeWidgetName(
    typeof data.widgetName === 'string' && data.widgetName.trim()
      ? data.widgetName
      : fallbackWidgetName(intent),
  )
  return { spec, uiMock, code, widgetName }
}

function buildSystemPrompt(): string {
  return [
    'You are Aurora OS Vibe Coding, a senior Vue 3 frontend generator.',
    'Return ONLY valid JSON. No Markdown fences. No commentary.',
    'JSON schema: {"widgetName":"PascalCaseName","spec":"brief feature spec","uiMock":"brief visual layout","code":"Vue 3 SFC code string"}.',
    'The code MUST be a single Vue 3 Single File Component using <script setup lang="ts">.',
    'Use Composition API and Tailwind utility classes in the template.',
    'The visual style MUST match Aurora OS: Apple-like glassmorphism, backdrop blur, translucent white panels, subtle borders, rounded-2xl or softer, calm purple/blue accents.',
    'No imports beyond Vue built-ins. No network calls. No file-system calls. No eval. No cookies. No localStorage. No window.location.',
    'Do not include path traversal, scripts that mutate global state, or browser APIs unrelated to component UI.',
    'Keep the component self-contained and production-readable.',
  ].join('\n')
}

function buildUserPrompt(intent: string): string {
  return [
    `Build intent: ${intent}`,
    '',
    'Generate a polished widget component ready to save under packages/client/src/components/generated.',
    'Prefer accessible labels, keyboard-friendly controls, and stable responsive layout.',
  ].join('\n')
}

function makeBuildId(): string {
  return `vibe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

async function appendAudit(entry: Record<string, unknown>) {
  await mkdir(GENERATED_DIR, { recursive: true })
  await appendFile(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function writeWidgetPermissionManifest(input: {
  buildId: string
  widgetName: string
  spec: string
  appliedAt: string
  securityReport: SecurityReportItem[]
}) {
  const componentPath = `packages/client/src/components/generated/${input.widgetName}.vue`
  const manifest: GeneratedWidgetPermissionManifest = {
    schemaVersion: 1,
    widgetName: input.widgetName,
    componentPath,
    buildId: input.buildId || undefined,
    permissions: {
      network: false,
      localStorage: false,
      workingMemory: false,
      cookies: false,
      filesystem: false,
    },
    security: {
      status: input.securityReport.length > 0 ? 'blocked' : 'passed',
      scannedAt: input.appliedAt,
      blockedPatterns: input.securityReport,
    },
    provenance: {
      source: 'aurora-vibe-coding',
      spec: input.spec || undefined,
      appliedAt: input.appliedAt,
    },
  }
  const manifestPath = assertSafeManifestPath(input.widgetName)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return {
    manifest,
    manifestPath,
    relativeManifestPath: `packages/client/src/components/generated/${input.widgetName}.manifest.json`,
  }
}

function isGeneratedWidgetFile(fileName: string): boolean {
  return /^[A-Z][A-Za-z0-9]{1,63}\.vue$/.test(fileName)
}

async function readAuditEntries(): Promise<Map<string, WidgetAuditEntry>> {
  const entries = new Map<string, WidgetAuditEntry>()

  try {
    const raw = await readFile(AUDIT_LOG_PATH, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as WidgetAuditEntry
        if (typeof parsed.widgetName !== 'string') continue
        const widgetName = assertSafeWidgetName(parsed.widgetName)
        entries.set(widgetName, parsed)
      } catch {
        // Ignore malformed audit lines rather than breaking the library view.
      }
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }

  return entries
}

async function readGeneratedWidgetManifest() {
  await mkdir(GENERATED_DIR, { recursive: true })
  const [files, auditEntries] = await Promise.all([
    readdir(GENERATED_DIR),
    readAuditEntries(),
  ])

  const widgets = await Promise.all(
    files
      .filter(isGeneratedWidgetFile)
      .sort((a, b) => a.localeCompare(b))
      .map(async (fileName) => {
        const widgetName = fileName.replace(/\.vue$/i, '')
        const safeName = assertSafeWidgetName(widgetName)
        const target = assertSafeTargetPath(safeName)
        const code = await readFile(target, 'utf8')
        const currentSecurityReport = scanCode(code)
        const audit = auditEntries.get(safeName)
        const auditSecurityReport = Array.isArray(audit?.securityReport)
          ? audit.securityReport
          : []
        const securityReport = currentSecurityReport.length > 0
          ? currentSecurityReport
          : auditSecurityReport

        const manifestFile = `${safeName}.manifest.json`
        let manifest: GeneratedWidgetPermissionManifest | null = null
        try {
          manifest = JSON.parse(await readFile(assertSafeManifestPath(safeName), 'utf8')) as GeneratedWidgetPermissionManifest
        } catch {
          manifest = null
        }

        return {
          widgetName: safeName,
          fileName,
          componentPath: `packages/client/src/components/generated/${safeName}.vue`,
          manifestPath: `packages/client/src/components/generated/${manifestFile}`,
          permissions: manifest?.permissions || {
            network: false,
            localStorage: false,
            workingMemory: false,
            cookies: false,
            filesystem: false,
          },
          deployedAt: audit?.appliedAt || null,
          buildId: audit?.buildId || null,
          spec: audit?.spec || null,
          source: audit ? 'vibe-build' : 'filesystem',
          securityStatus: securityReport.length > 0 ? 'blocked' : 'passed',
          securityReport,
        }
      }),
  )

  return {
    generatedAt: new Date().toISOString(),
    root: 'packages/client/src/components/generated',
    widgets,
  }
}

auroraVibeRoutes.get('/api/aurora/generated-widgets', async (ctx) => {
  try {
    ctx.body = await readGeneratedWidgetManifest()
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error?.message || 'Failed to read generated widget manifest.' }
  }
})

auroraVibeRoutes.post('/api/aurora/vibe-build', async (ctx) => {
  const body = (ctx.request.body || {}) as VibeBuildBody
  let intent: string
  try {
    intent = stringBodyField(body.intent, 'intent', MAX_INTENT_LENGTH)
  } catch (error: any) {
    ctx.status = 400
    ctx.body = { error: error?.message || 'Invalid build intent' }
    return
  }

  try {
    const llm = await generateHermesText({
      instructions: buildSystemPrompt(),
      input: buildUserPrompt(intent),
      temperature: 0.18,
      maxTokens: 4200,
      timeoutMs: 60_000,
      priority: 'medium',
      taskKind: 'vibe-pipeline',
    })
    const payload = normalizeLlmPayload(parseLLMJSON(llm.text, 2), intent)
    const securityReport = scanCode(payload.code)

    ctx.body = {
      buildId: makeBuildId(),
      widgetName: payload.widgetName,
      componentPath: `packages/client/src/components/generated/${payload.widgetName}.vue`,
      spec: payload.spec,
      uiMock: payload.uiMock,
      code: payload.code,
      patchDiff: createPatchDiff(payload.widgetName, payload.code),
      securityReport,
      blocked: securityReport.length > 0,
      runtime: {
        mode: llm.runtime.mode,
        provider: llm.runtime.provider,
        model: llm.runtime.model,
      },
    }
  } catch (error: any) {
    ctx.status = 502
    ctx.body = { error: error?.message || 'Aurora vibe build generation failed.' }
  }
})

auroraVibeRoutes.post('/api/aurora/vibe-apply', async (ctx) => {
  const body = (ctx.request.body || {}) as VibeApplyBody
  let buildId = ''
  let spec = ''
  let widgetName: string
  let code: string

  try {
    buildId = typeof body.buildId === 'string' ? body.buildId.slice(0, 120) : ''
    spec = typeof body.spec === 'string' ? body.spec.slice(0, 2400) : ''
    widgetName = assertSafeWidgetName(stringBodyField(body.widgetName, 'widgetName', 80))
    code = validateVueSfc(stringBodyField(body.code, 'code', MAX_CODE_LENGTH))
  } catch (error: any) {
    ctx.status = 400
    ctx.body = { error: error?.message || 'Invalid apply payload' }
    return
  }

  const securityReport = scanCode(code)
  if (securityReport.length > 0) {
    ctx.status = 422
    ctx.body = {
      error: 'Generated code failed security scan and was not written.',
      securityReport,
    }
    return
  }

  try {
    await mkdir(GENERATED_DIR, { recursive: true })
    const target = assertSafeTargetPath(widgetName)
    await writeFile(target, `${code.trim()}\n`, 'utf8')
    const appliedAt = new Date().toISOString()
    const manifestResult = await writeWidgetPermissionManifest({
      buildId,
      widgetName,
      spec,
      appliedAt,
      securityReport,
    })

    const audit = {
      buildId,
      widgetName,
      path: target,
      spec,
      securityReport,
      manifestPath: manifestResult.manifestPath,
      appliedAt,
    }
    await appendAudit(audit)

    ctx.body = {
      ok: true,
      path: `packages/client/src/components/generated/${widgetName}.vue`,
      manifestPath: manifestResult.relativeManifestPath,
      manifest: manifestResult.manifest,
      audit,
    }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error?.message || 'Failed to write generated widget.' }
  }
})
