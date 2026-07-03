#!/usr/bin/env node
/**
 * Auto-generate OpenAPI specification from existing Koa routes and controllers
 *
 * This script scans both route files and controller files to generate comprehensive
 * OpenAPI documentation without requiring code changes or decorators.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(__dirname, '..')
const routesDir = join(rootDir, 'packages/server/src/routes')
const controllersDir = join(rootDir, 'packages/server/src/controllers')
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))

// OpenAPI template
const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Hermes Studio API',
    description: 'Hermes Studio API — chat sessions, scheduled jobs, platform channels, model management, skills, memory, logs, file browser, group chat, and terminal.',
    version: packageJson.version,
  },
  servers: [
    { url: 'http://localhost:8648', description: 'Local development' },
  ],
  tags: [],
  paths: {},
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Token',
      },
    },
    schemas: {},
    responses: {},
  },
}

// Tag mappings based on route directories
const tagMappings = {
  'routes/hermes/sessions.ts': { name: 'Sessions', description: 'Chat session management' },
  'routes/hermes/profiles.ts': { name: 'Profiles', description: 'Hermes profile management' },
  'routes/hermes/gateways.ts': { name: 'Gateways', description: 'Gateway process management' },
  'routes/hermes/models.ts': { name: 'Models', description: 'Model configuration' },
  'routes/hermes/providers.ts': { name: 'Providers', description: 'Model provider management' },
  'routes/hermes/skills.ts': { name: 'Skills', description: 'Skill browsing and management' },
  'routes/hermes/plugins.ts': { name: 'Plugins', description: 'Plugin browsing and management' },
  'routes/hermes/memory.ts': { name: 'Memory', description: 'Agent memory files' },
  'routes/hermes/logs.ts': { name: 'Logs', description: 'Log file access' },
  'routes/hermes/jobs.ts': { name: 'Jobs', description: 'Scheduled job management' },
  'routes/hermes/cron-history.ts': { name: 'Jobs', description: 'Cron job history' },
  'routes/hermes/kanban.ts': { name: 'Kanban', description: 'Kanban board and task management' },
  'routes/hermes/weixin.ts': { name: 'Weixin', description: 'WeChat QR code login' },
  'routes/hermes/codex-auth.ts': { name: 'Codex Auth', description: 'OpenAI Codex OAuth' },
  'routes/hermes/nous-auth.ts': { name: 'Nous Auth', description: 'Nous Research OAuth' },
  'routes/hermes/copilot-auth.ts': { name: 'Copilot Auth', description: 'GitHub Copilot OAuth' },
  'routes/hermes/xai-auth.ts': { name: 'xAI Auth', description: 'xAI OAuth' },
  'routes/hermes/anthropic-auth.ts': { name: 'Anthropic Auth', description: 'Anthropic OAuth' },
  'routes/hermes/gemini-auth.ts': { name: 'Gemini Auth', description: 'Google Gemini OAuth' },
  'routes/hermes/group-chat.ts': { name: 'Group Chat', description: 'Group chat management' },
  'routes/hermes/chat-run.ts': { name: 'Chat Run', description: 'Chat run HTTP and Socket.IO bridge operations' },
  'routes/hermes/config.ts': { name: 'Config', description: 'Configuration management' },
  'routes/hermes/files.ts': { name: 'Files', description: 'Hermes file browser' },
  'routes/hermes/download.ts': { name: 'Download', description: 'File download' },
  'routes/hermes/tts.ts': { name: 'TTS', description: 'Text-to-speech generation and settings' },
  'routes/hermes/stt.ts': { name: 'STT', description: 'Speech-to-text transcription and settings' },
  'routes/hermes/media.ts': { name: 'Media', description: 'Media generation endpoints' },
  'routes/hermes/mcp.ts': { name: 'MCP', description: 'MCP server and tool management' },
  'routes/hermes/runtime-versions.ts': { name: 'Runtime Versions', description: 'Runtime and Web UI version management' },
  'routes/hermes/write-gate.ts': { name: 'Write Gate', description: 'Hermes Agent write approval review' },
  'routes/hermes/performance-monitor.ts': { name: 'Performance', description: 'Runtime performance monitoring' },
  'routes/hermes/journey.ts': { name: 'Journey', description: 'Hermes Agent learning journey graph' },
  'routes/hermes/terminal.ts': { name: 'Terminal', description: 'WebSocket terminal' },
  'routes/health.ts': { name: 'Health', description: 'Health check' },
  'routes/update.ts': { name: 'Update', description: 'Self-update management' },
  'routes/upload.ts': { name: 'Upload', description: 'File upload' },
  'routes/webhook.ts': { name: 'Webhook', description: 'Incoming webhooks' },
  'routes/auth.ts': { name: 'Auth', description: 'Authentication management' },
  'routes/devices.ts': { name: 'Devices', description: 'Device pairing and LAN peer operations' },
  'routes/coding-agents.ts': { name: 'Coding Agents', description: 'Coding agent installation, config, and runs' },
  'routes/api-docs.ts': { name: 'API Docs', description: 'OpenAPI route catalog' },
}

// Extract route definitions from route files
function scanRoutes() {
  const paths = {}

  // Scan hermes routes
  const hermesRoutesDir = join(routesDir, 'hermes')
  const hermesRouteFiles = readdirSync(hermesRoutesDir).filter(f => f.endsWith('.ts'))

  for (const file of hermesRouteFiles) {
    const routePath = join('hermes', file)
    const tagInfo = tagMappings[`routes/${routePath}`]
    if (tagInfo) {
      scanRouteFile(join(hermesRoutesDir, file), tagInfo, paths)
    }
  }

  // Scan top-level routes
  for (const [routeFile, tagInfo] of Object.entries(tagMappings)) {
    if (!routeFile.startsWith('routes/hermes/')) {
      const filePath = join(routesDir, routeFile.replace('routes/', ''))
      try {
        scanRouteFile(filePath, tagInfo, paths)
      } catch (e) {
        // File might not exist, skip
      }
    }
  }

  return paths
}

function scanRouteFile(filePath, tagInfo, paths) {
  const content = readFileSync(filePath, 'utf-8')
  const controllerContent = readControllerContent(filePath, content)

  // Pattern 1: controller functions - sessionRoutes.get('/path', middleware, ctrl.method)
  const ctrlRouteRegex = /\w+Routes?\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]\s*,[^\n]*?\bctrl\.(\w+)/g

  let match
  while ((match = ctrlRouteRegex.exec(content)) !== null) {
    const [, method, path, controllerMethod] = match
    const controllerSource = controllerContent
      ? extractFunctionSource(controllerContent, controllerMethod)
      : ''
    addEndpoint(paths, method, path, controllerMethod, tagInfo, content, match.index, controllerSource)
  }

  // Pattern 2: inline functions - groupChatRoutes.post('/path', async (ctx) => {...})
  const inlineRouteRegex = /\w+Routes?\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]\s*,[^\n]*?async\s*\(ctx\)/g

  while ((match = inlineRouteRegex.exec(content)) !== null) {
    const [, method, path] = match
    const controllerMethod = generateOperationIdFromPath(path, method)
    addEndpoint(paths, method, path, controllerMethod, tagInfo, content, match.index, extractInlineHandlerSource(content, match.index))
  }
}

function readControllerContent(routeFilePath, routeContent) {
  const importMatch = routeContent.match(/import\s+\*\s+as\s+ctrl\s+from\s+['"]([^'"]+)['"]/)
  if (!importMatch) return ''

  const controllerPath = resolve(dirname(routeFilePath), `${importMatch[1]}.ts`)
  try {
    return readFileSync(controllerPath, 'utf-8')
  } catch {
    return ''
  }
}

function extractFunctionSource(content, functionName) {
  const functionRegex = new RegExp(`export\\s+(?:async\\s+)?function\\s+${functionName}\\b`)
  const match = functionRegex.exec(content)
  if (!match) return ''

  const openBrace = content.indexOf('{', match.index)
  if (openBrace < 0) return ''
  const closeBrace = findMatchingBrace(content, openBrace)
  if (closeBrace < 0) return ''
  return content.slice(match.index, closeBrace + 1)
}

function extractInlineHandlerSource(content, routeIndex) {
  const asyncIndex = content.indexOf('async', routeIndex)
  if (asyncIndex < 0) return ''
  const openBrace = content.indexOf('{', asyncIndex)
  if (openBrace < 0) return ''
  const closeBrace = findMatchingBrace(content, openBrace)
  if (closeBrace < 0) return ''
  return content.slice(asyncIndex, closeBrace + 1)
}

function findMatchingBrace(content, openBrace) {
  let depth = 0
  let quote = null
  let escaped = false

  for (let i = openBrace; i < content.length; i += 1) {
    const ch = content[i]
    const prev = content[i - 1]

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote && (quote !== '`' || prev !== '\\')) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }

  return -1
}

function addEndpoint(paths, method, path, controllerMethod, tagInfo, content, matchIndex, controllerSource = '') {
  if (isInternalProxyRoute(path)) return

  // Clean path parameters
  const openapiPath = path
    .replace(/:([^/]+)/g, '{$1}')
    .replace(/\{\*([^}]+)\}/g, '{$1}')
    .replace(/\*\*([^/]*)/g, '{$1}')

  if (!paths[openapiPath]) {
    paths[openapiPath] = {}
  }

  // Generate operation ID
  const operationId = `${controllerMethod}`

  // Generate description from JSDoc comments above the route
  const precedingContent = content.substring(Math.max(0, matchIndex - 500), matchIndex)
  const description = extractJsDocDescription(precedingContent) || `${method.toUpperCase()} ${path}`

  const operation = {
    tags: [tagInfo.name],
    summary: generateSummary(path, method, controllerMethod),
    description,
    operationId,
    security: [{ BearerAuth: [] }],
    responses: generateResponses(path, method),
  }

  const parameters = generateParameters(openapiPath, controllerSource)
  if (parameters.length) operation.parameters = parameters

  const requestBody = generateRequestBody(method, controllerSource)
  if (requestBody) operation.requestBody = requestBody

  paths[openapiPath][method] = operation
}

function isInternalProxyRoute(path) {
  return path.startsWith('/api/codex-proxy/') || path.startsWith('/api/claude-code-proxy/')
}

function generateParameters(openapiPath, source) {
  const params = []
  const seen = new Set()

  for (const name of extractPathParamNames(openapiPath)) {
    seen.add(`path:${name}`)
    params.push({
      name,
      in: 'path',
      required: true,
      schema: { type: inferParamType(name, source) },
    })
  }

  for (const name of extractQueryParamNames(source)) {
    const key = `query:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    params.push({
      name,
      in: 'query',
      required: isRequiredQueryParam(name, source),
      schema: queryParamSchema(name, source),
    })
  }

  return params
}

function extractPathParamNames(openapiPath) {
  return Array.from(openapiPath.matchAll(/\{([^}]+)\}/g))
    .map(match => match[1])
    .filter(name => name && !name.startsWith('*'))
}

function extractQueryParamNames(source) {
  const names = new Set()
  if (!source) return []

  collectMatches(source, /ctx\.query\??\.(\w+)/g, names)
  collectMatches(source, /ctx\.query\[['"]([^'"]+)['"]\]/g, names)

  for (const match of source.matchAll(/const\s+\{([^}]+)\}\s*=\s*ctx\.query/g)) {
    for (const name of parseDestructuredNames(match[1])) names.add(name)
  }

  for (const match of source.matchAll(/ctx\.query\s+as\s*\{([\s\S]*?)\}/g)) {
    for (const field of parseTypeLiteralFields(match[1])) names.add(field.name)
  }

  if (/\brequestBoard\(ctx\)/.test(source)) names.add('board')

  return Array.from(names).filter(Boolean).sort()
}

function collectMatches(source, regex, names) {
  for (const match of source.matchAll(regex)) names.add(match[1])
}

function parseDestructuredNames(text) {
  return parseDestructuredEntries(text).map(entry => entry.name)
}

function parseDestructuredEntries(text) {
  return text
    .split(',')
    .map(part => {
      const [rawName, rawLocal] = part.trim().split(':')
      const name = rawName?.trim()
      const local = (rawLocal || rawName)?.trim().replace(/\s*=.*$/, '')
      return { name, local }
    })
    .filter(entry => /^[A-Za-z_$][\w$]*$/.test(entry.name) && /^[A-Za-z_$][\w$]*$/.test(entry.local))
}

function queryParamSchema(name, source) {
  const type = inferParamType(name, source)
  const schema = { type }

  const enumValues = inferEnumValues(name, source)
  if (enumValues.length) schema.enum = enumValues

  return schema
}

function inferParamType(name, source) {
  const escaped = escapeRegExp(name)
  if (new RegExp(`parseInt\\([^)]*\\b${escaped}\\b`).test(source) || new RegExp(`Number\\([^)]*\\b${escaped}\\b`).test(source)) {
    return 'integer'
  }
  if (new RegExp(`\\b${escaped}\\b[^\\n]*(?:===|!==)\\s*['"](?:true|false|0|1)['"]`).test(source)) {
    return 'boolean'
  }
  if (new RegExp(`boolQuery\\([^)]*\\b${escaped}\\b`).test(source)) {
    return 'boolean'
  }
  return 'string'
}

function isRequiredQueryParam(name, source) {
  return extractRequiredNamesFromMessages(source).has(name)
}

function inferEnumValues(name, source) {
  const escaped = escapeRegExp(name)
  const values = new Set()
  const comparisonRegex = new RegExp(`\\b${escaped}\\b\\s*(?:===|!==)\\s*['"]([^'"]+)['"]`, 'g')
  collectMatches(source, comparisonRegex, values)
  const allowedRegex = new RegExp(`${escaped}\\s+must be\\s+([^'"\`\\n]+)`, 'i')
  const allowedMatch = source.match(allowedRegex)
  if (allowedMatch) {
    allowedMatch[1]
      .split(/,|\bor\b/)
      .map(value => value.trim())
      .filter(value => /^[A-Za-z0-9_.-]+$/.test(value))
      .forEach(value => values.add(value))
  }
  return Array.from(values)
}

function generateRequestBody(method, source) {
  if (!['post', 'put', 'patch'].includes(method)) return null
  if (!source || !/(ctx\.request\??\.body|requestBody\(ctx\))/.test(source)) return null

  const fields = extractBodyFields(source)
  const schema = {
    type: 'object',
    properties: {},
  }

  for (const field of fields) {
    schema.properties[field.name] = field.schema
  }

  const required = fields.filter(field => field.required).map(field => field.name)
  if (required.length) schema.required = required
  if (!fields.length) schema.additionalProperties = true

  return {
    required: true,
    content: {
      'application/json': {
        schema,
      },
    },
  }
}

function extractBodyFields(source) {
  const fields = new Map()
  const requiredNames = inferRequiredBodyNames(source)

  for (const typeLiteral of extractRequestBodyTypeLiterals(source)) {
    for (const field of parseTypeLiteralFields(typeLiteral)) {
      addBodyField(fields, {
        name: field.name,
        schema: schemaFromType(field.type),
        required: requiredNames.has(field.name) || !field.optional,
      })
    }
  }

  for (const name of extractDestructuredBodyNames(source)) {
    addBodyField(fields, {
      name,
      schema: schemaFromName(name, source),
      required: requiredNames.has(name),
    })
  }

  for (const name of extractBodyPropertyNames(source)) {
    addBodyField(fields, {
      name,
      schema: schemaFromName(name, source),
      required: requiredNames.has(name),
    })
  }

  return Array.from(fields.values()).sort((a, b) => a.name.localeCompare(b.name))
}

function addBodyField(fields, next) {
  if (!next.name || !/^[A-Za-z_$][\w$]*$/.test(next.name)) return
  const existing = fields.get(next.name)
  if (!existing) {
    fields.set(next.name, next)
    return
  }
  existing.required = existing.required || next.required
  existing.schema = mergeSchema(existing.schema, next.schema)
}

function mergeSchema(current, next) {
  if (current.type === 'object' && Object.keys(current).length === 1) return next
  if (next.type === 'object' && Object.keys(next).length === 1) return current
  return current
}

function extractRequestBodyTypeLiterals(source) {
  const literals = []
  const markers = ['ctx.request.body as {', '(ctx.request.body || {}) as {', '(ctx.request?.body || {}) as {']

  for (const marker of markers) {
    let index = source.indexOf(marker)
    while (index >= 0) {
      const openBrace = source.indexOf('{', index)
      const closeBrace = findMatchingBrace(source, openBrace)
      if (openBrace >= 0 && closeBrace > openBrace) {
        literals.push(source.slice(openBrace + 1, closeBrace))
      }
      index = source.indexOf(marker, index + marker.length)
    }
  }

  return literals
}

function parseTypeLiteralFields(typeLiteral) {
  const fields = []
  for (const entry of splitTopLevel(typeLiteral)) {
    const match = entry.trim().match(/^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/)
    if (!match) continue
    fields.push({
      name: match[1],
      optional: Boolean(match[2]),
      type: match[3].trim().replace(/[,;]$/, ''),
    })
  }
  return fields
}

function splitTopLevel(text) {
  const parts = []
  let start = 0
  let angleDepth = 0
  let braceDepth = 0
  let bracketDepth = 0
  let parenDepth = 0
  let quote = null

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '<') angleDepth += 1
    if (ch === '>') angleDepth = Math.max(0, angleDepth - 1)
    if (ch === '{') braceDepth += 1
    if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    if (ch === '[') bracketDepth += 1
    if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1)
    if (ch === '(') parenDepth += 1
    if (ch === ')') parenDepth = Math.max(0, parenDepth - 1)

    if ((ch === '\n' || ch === ';' || ch === ',') && angleDepth === 0 && braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.filter(part => part.trim())
}

function extractDestructuredBodyNames(source) {
  return extractDestructuredBodyEntries(source).map(entry => entry.name)
}

function extractDestructuredBodyEntries(source) {
  const entries = []
  for (const match of source.matchAll(/const\s+\{([^}]+)\}\s*=\s*(?:\([^)]*\)\s*)?ctx\.request\??\.body/g)) {
    entries.push(...parseDestructuredEntries(match[1]))
  }
  const byName = new Map()
  for (const entry of entries) byName.set(entry.name, entry)
  return Array.from(byName.values())
}

function extractBodyPropertyNames(source) {
  const names = new Set()
  const bodyVariableNames = extractBodyVariableNames(source)
  bodyVariableNames.push('bodyResult.body')

  for (const variableName of bodyVariableNames) {
    const escaped = escapeRegExp(variableName)
    collectMatches(source, new RegExp(`\\b${escaped}\\.([A-Za-z_$][\\w$]*)`, 'g'), names)
  }

  collectMatches(source, /ctx\.request\??\.body\??\.([A-Za-z_$][\w$]*)/g, names)
  collectMatches(source, /\(ctx\.request\.body as any\)\??\.([A-Za-z_$][\w$]*)/g, names)
  return Array.from(names)
}

function extractBodyVariableNames(source) {
  const names = []
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*)?ctx\.request\??\.body/g)) {
    names.push(match[1])
  }
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:bodyResult\.body|requestBody\(ctx\)\.body)/g)) {
    names.push(match[1])
  }
  return Array.from(new Set(names))
}

function inferRequiredBodyNames(source) {
  const names = extractRequiredNamesFromMessages(source)
  collectMatches(source, /required\w*\([^,]+,\s*['"]([^'"]+)['"]/g, names)
  for (const entry of extractDestructuredBodyEntries(source)) {
    const escaped = escapeRegExp(entry.local)
    if (new RegExp(`if\\s*\\([^)]*!\\s*${escaped}\\b`).test(source)
      || new RegExp(`\\|\\|\\s*!\\s*${escaped}\\b`).test(source)
      || new RegExp(`&&\\s*!\\s*${escaped}\\b`).test(source)) {
      names.add(entry.name)
    }
  }
  return names
}

function extractRequiredNamesFromMessages(source) {
  const names = new Set()
  for (const match of source.matchAll(/['"`]([^'"`]*\brequired\b[^'"`]*)['"`]/gi)) {
    const message = match[1]
    const beforeRequired = message.split(/\brequired\b/i)[0] || ''
    beforeRequired
      .replace(/\bis\b|\bare\b|\bmust\b|\bbe\b/gi, ' ')
      .split(/,|\band\b|\/|\s+/)
      .map(part => part.trim())
      .filter(part => /^[A-Za-z_$][\w$]*$/.test(part))
      .forEach(part => {
        names.add(part)
        names.add(part.charAt(0).toLowerCase() + part.slice(1))
      })
  }
  return names
}

function schemaFromName(name, source) {
  const escaped = escapeRegExp(name)
  if (new RegExp(`optionalBoolean\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'boolean' }
  if (new RegExp(`optional(?:Positive)?Integer\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'integer' }
  if (new RegExp(`(?:optional|required)\\w*StringArray\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'array', items: { type: 'string' } }
  if (new RegExp(`(?:StringArray|task_ids|ids)`, 'i').test(name)) return { type: 'array', items: { type: 'string' } }
  return { type: 'string' }
}

function schemaFromType(type) {
  const normalized = type.replace(/\s+/g, ' ')
  const schema = {}

  if (/\bnull\b/.test(normalized)) schema.nullable = true
  if (/string\[\]|Array<string>/.test(normalized)) {
    return { ...schema, type: 'array', items: { type: 'string' } }
  }
  if (/number/.test(normalized)) return { ...schema, type: 'number' }
  if (/boolean/.test(normalized)) return { ...schema, type: 'boolean' }
  if (/Record<|unknown|any|object|\{/.test(normalized)) return { ...schema, type: 'object', additionalProperties: true }
  if (/string/.test(normalized)) return { ...schema, type: 'string' }
  return { ...schema, type: 'object' }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function generateOperationIdFromPath(path, method) {
  const parts = path.split('/').filter(Boolean)
  const lastPart = parts[parts.length - 1]

  if (lastPart && !lastPart.includes(':') && !lastPart.includes('*')) {
    const actionMap = {
      get: 'get',
      post: 'create',
      put: 'update',
      patch: 'patch',
      delete: 'delete',
    }
    return `${actionMap[method]}${lastPart.charAt(0).toUpperCase() + lastPart.slice(1)}`
  }

  const parentPart = parts[parts.length - 2]
  if (parentPart) {
    return `${method}${parentPart.charAt(0).toUpperCase() + parentPart.slice(1)}`
  }

  return method
}

function extractJsDocDescription(content) {
  const jsDocRegex = /\/\*\*[\s\S]*?\*\//
  const match = content.match(jsDocRegex)
  if (match) {
    const jsDoc = match[0]
    // Extract description text
    const description = jsDoc
      .replace(/\/\*\*|\*\//g, '')
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').trim())
      .filter(line => line && !line.startsWith('@'))
      .join('\n')
    return description || null
  }
  return null
}

function generateSummary(path, method, controllerMethod) {
  const parts = path.split('/').filter(Boolean)
  const resource = parts[parts.length - 1] || 'root'

  // Use controller method name to generate better summary
  const methodMap = {
    list: 'List',
    get: 'Get',
    create: 'Create',
    update: 'Update',
    remove: 'Delete',
    delete: 'Delete',
    rename: 'Rename',
    pause: 'Pause',
    resume: 'Resume',
    run: 'Run',
    search: 'Search',
    add: 'Add',
  }

  const action = methodMap[controllerMethod] || {
    get: 'Get',
    post: 'Create',
    put: 'Update',
    patch: 'Update',
    delete: 'Delete',
  }[method]

  if (resource.includes('{')) {
    const paramName = resource.match(/\{([^}]+)\}/)?.[1] || 'id'
    const parentResource = parts[parts.length - 2] || 'resource'
    return `${action} ${parentResource} by ${paramName}`
  }

  return `${action} ${resource}`
}

function generateResponses(path, method) {
  const responses = {
    '200': {
      description: 'Success',
    },
    '401': {
      $ref: '#/components/responses/Unauthorized',
    },
  }

  if (method === 'get' && path.includes('/')) {
    responses['404'] = { description: 'Not found' }
  }

  if (method === 'post' || method === 'put' || method === 'patch') {
    responses['400'] = { $ref: '#/components/responses/BadRequest' }
  }

  return responses
}

// Add standard responses
openapi.components.responses = {
  Unauthorized: {
    description: 'Unauthorized - Invalid or missing authentication token',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Unauthorized' },
          },
        },
      },
    },
  },
  BadRequest: {
    description: 'Bad Request - Invalid parameters',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Invalid request' },
          },
        },
      },
    },
  },
  NotFound: {
    description: 'Resource not found',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'Not found' },
          },
        },
      },
    },
  },
}

// Add WebSocket terminal endpoint
openapi.paths['/api/hermes/terminal'] = {
  'get': {
    tags: ['Terminal'],
    summary: 'WebSocket terminal connection',
    description: 'Establish a WebSocket connection for interactive terminal access. Uses the `ws` or `wss` protocol with `?token=` for authentication.',
    operationId: 'terminalWebSocket',
    responses: {
      '101': { description: 'Switching Protocols - WebSocket connection established' },
      '401': { $ref: '#/components/responses/Unauthorized' },
    },
  },
}

// Add Terminal tag
if (!openapi.tags.find(t => t.name === 'Terminal')) {
  openapi.tags.push({ name: 'Terminal', description: 'WebSocket terminal access' })
}

// Run scanner
console.log('Scanning routes...')
openapi.paths = scanRoutes()

// Collect all tags
const tagSet = new Set()
Object.values(openapi.paths).forEach(pathItem => {
  Object.values(pathItem).forEach(operation => {
    operation.tags?.forEach(tag => tagSet.add(tag))
  })
})

openapi.tags = Array.from(tagSet).map(tag => {
  const tagInfo = Object.values(tagMappings).find(t => t.name === tag)
  return {
    name: tag,
    description: tagInfo?.description || '',
  }
})

// Sort paths
const sortedPaths = {}
Object.keys(openapi.paths).sort().forEach(key => {
  sortedPaths[key] = openapi.paths[key]
})
openapi.paths = sortedPaths

// Add special endpoints after sorting
// Add non-streaming Chat Run HTTP wrapper endpoint
openapi.paths['/api/chat-run/runs'] = {
  post: {
    tags: ['Chat Run'],
    summary: 'Run chat and wait for completion',
    description: 'Starts a Hermes Studio chat run through the chat-run transport and waits for a terminal result. Use this from HTTP/MCP callers that cannot consume Socket.IO streams.',
    operationId: 'runChatOnce',
    security: [{ BearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['input'],
            properties: {
              input: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: true,
                    },
                  },
                ],
                description: 'User message text or content blocks.',
              },
              session_id: {
                type: 'string',
                description: 'Optional session id. Omit this to create a new session automatically. Provide an existing session id to continue that session.',
              },
              profile: {
                type: 'string',
                description: 'Hermes Studio profile name. Defaults to the authenticated request profile or default.',
              },
              provider: {
                type: 'string',
                description: 'Model provider key to use for this run, for example openai, anthropic, deepseek, or a configured custom provider key.',
              },
              model: {
                type: 'string',
                description: 'Model id to use for this run, for example gpt-5.1 or deepseek-v4-pro.',
              },
              model_groups: {
                type: 'array',
                description: 'Optional provider/model fallback groups.',
                items: {
                  type: 'object',
                  required: ['provider', 'models'],
                  properties: {
                    provider: { type: 'string' },
                    models: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
              source: {
                type: 'string',
                enum: ['cli', 'coding_agent', 'global_agent'],
                description: 'Run backend source. Use cli for Hermes bridge runs, coding_agent for Claude Code/Codex, or global_agent for global-agent sessions. Omit source for normal Hermes chat runs; do not use the legacy api_server source.',
              },
              session_source: {
                type: 'string',
                enum: ['global_agent'],
                description: 'Marks a coding-agent or bridge session as launched from the global agent.',
              },
              instructions: {
                type: 'string',
                description: 'Optional extra run instructions appended after the system prompt.',
              },
              workspace: {
                type: 'string',
                nullable: true,
                description: 'Optional current working directory for the run.',
              },
              reasoning_effort: {
                type: 'string',
                description: 'Optional per-run reasoning effort override.',
              },
              coding_agent_id: {
                type: 'string',
                enum: ['claude-code', 'codex'],
                description: 'Coding agent id when source is coding_agent.',
              },
              agent_id: {
                type: 'string',
                enum: ['claude-code', 'codex'],
                description: 'Alias for coding_agent_id.',
              },
              mode: {
                type: 'string',
                enum: ['scoped', 'global'],
                description: 'Coding-agent launch mode.',
              },
              baseUrl: {
                type: 'string',
                description: 'Optional provider base URL for coding-agent runs.',
              },
              apiKey: {
                type: 'string',
                description: 'Optional provider API key for coding-agent runs.',
              },
              apiMode: {
                type: 'string',
                enum: ['chat_completions', 'codex_responses', 'anthropic_messages'],
                description: 'Optional provider wire API mode for coding-agent runs.',
              },
              timeout_ms: {
                type: 'integer',
                minimum: 1,
                maximum: 1800000,
                default: 300000,
                description: 'Maximum time to wait for run.completed or run.failed.',
              },
              include_events: {
                type: 'boolean',
                default: false,
                description: 'Include recorded run events in the HTTP response.',
              },
            },
            additionalProperties: true,
          },
        },
      },
    },
    responses: {
      '200': {
        description: 'Run completed',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean', example: true },
                status: { type: 'string', example: 'completed' },
                session_id: { type: 'string' },
                run_id: { type: 'string' },
                output: { type: 'string' },
                reasoning: { type: 'string' },
                events: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
          },
        },
      },
      '400': { $ref: '#/components/responses/BadRequest' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '409': { description: 'Run requires approval or clarification' },
      '500': { description: 'Run failed' },
      '504': { description: 'Run timed out' },
    },
  },
}

// Add WebSocket terminal endpoint
openapi.paths['/api/hermes/terminal'] = {
  'get': {
    tags: ['Terminal'],
    summary: 'WebSocket terminal connection',
    description: 'Establish a WebSocket connection for interactive terminal access. Uses the `ws` or `wss` protocol with `?token=` for authentication.',
    operationId: 'terminalWebSocket',
    responses: {
      '101': { description: 'Switching Protocols - WebSocket connection established' },
      '401': { $ref: '#/components/responses/Unauthorized' },
    },
  },
}

// Add Terminal tag
if (!openapi.tags.find(t => t.name === 'Terminal')) {
  openapi.tags.push({ name: 'Terminal', description: 'WebSocket terminal access' })
}

// Write output
const outputPath = join(rootDir, 'docs/openapi.json')
writeFileSync(outputPath, JSON.stringify(openapi, null, 2))

console.log(`✓ Generated OpenAPI spec: ${outputPath}`)
console.log(`  ${Object.keys(openapi.paths).length} endpoints`)
console.log(`  ${openapi.tags.length} tags`)
