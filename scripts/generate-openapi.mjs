#!/usr/bin/env node
/**
 * Auto-generate OpenAPI specification from existing Koa routes and controllers
 *
 * This script scans both route files and controller files to generate comprehensive
 * OpenAPI documentation without requiring code changes or decorators.
 */

import { readFileSync, writeFileSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(__dirname, '..')
const serverSourceDir = join(rootDir, 'packages/server/src')
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
  'modules/hermes/routes/profiles.ts': { name: 'Profiles', description: 'Hermes profile management' },
  'modules/hermes/routes/models.ts': { name: 'Models', description: 'Model configuration' },
  'modules/hermes/routes/providers.ts': { name: 'Providers', description: 'Model provider management' },
  'modules/hermes/routes/skills.ts': { name: 'Skills', description: 'Skill browsing and management' },
  'modules/hermes/routes/skill-bundles.ts': { name: 'Skill Bundles', description: 'Skill bundle browsing and management' },
  'modules/hermes/routes/plugins.ts': { name: 'Plugins', description: 'Plugin browsing and management' },
  'modules/hermes/routes/memory.ts': { name: 'Memory', description: 'Agent memory files' },
  'modules/hermes/routes/jobs.ts': { name: 'Jobs', description: 'Scheduled job management' },
  'modules/hermes/routes/cron-history.ts': { name: 'Jobs', description: 'Cron job history' },
  'modules/hermes/routes/kanban.ts': { name: 'Kanban', description: 'Kanban board and task management' },
  'modules/hermes/routes/weixin.ts': { name: 'Weixin', description: 'Hermes WeChat QR code login' },
  'modules/hermes/routes/codex-auth.ts': { name: 'Codex Auth', description: 'OpenAI Codex OAuth' },
  'modules/hermes/routes/nous-auth.ts': { name: 'Nous Auth', description: 'Nous Research OAuth' },
  'modules/hermes/routes/copilot-auth.ts': { name: 'Copilot Auth', description: 'GitHub Copilot OAuth' },
  'modules/hermes/routes/xai-auth.ts': { name: 'xAI Auth', description: 'xAI OAuth' },
  'modules/hermes/routes/anthropic-auth.ts': { name: 'Anthropic Auth', description: 'Anthropic OAuth' },
  'modules/hermes/routes/minimax-auth.ts': { name: 'MiniMax Auth', description: 'MiniMax OAuth' },
  'modules/hermes/routes/config.ts': { name: 'Config', description: 'Configuration management' },
  'modules/studio/routes/files.ts': { name: 'Studio Files', description: 'Studio profile file browser and editor' },
  'modules/studio/routes/app-upload.ts': { name: 'Studio Files', description: 'Studio App chunked uploads' },
  'modules/studio/routes/download.ts': { name: 'Studio Files', description: 'Studio file download' },
  'modules/hermes/routes/mcp.ts': { name: 'MCP', description: 'MCP server and tool management' },
  'modules/hermes/routes/runtime-versions.ts': { name: 'Runtime Versions', description: 'Runtime and Web UI version management' },
  'modules/hermes/routes/write-gate.ts': { name: 'Write Gate', description: 'Hermes Agent write approval review' },
  'modules/hermes/routes/journey.ts': { name: 'Journey', description: 'Hermes Agent learning journey graph' },
  'modules/ekko/routes/memory.ts': { name: 'Ekko Memory', description: 'Ekko durable memory management' },
  'modules/ekko/routes/skills.ts': { name: 'Ekko Skills', description: 'Ekko reusable skill management' },
  'modules/ekko/routes/mcp.ts': { name: 'Ekko MCP', description: 'Ekko MCP server management' },
  'modules/ekko/routes/config.ts': { name: 'Ekko Config', description: 'Ekko runtime configuration management' },
  'modules/studio/routes/workflows.ts': { name: 'Workflows', description: 'Cross-agent workflow orchestration' },
  'modules/studio/routes/sessions.ts': { name: 'Sessions', description: 'Cross-agent chat session management' },
  'modules/studio/routes/logs.ts': { name: 'Logs', description: 'Cross-agent log file access' },
  'modules/studio/routes/social-messages.ts': { name: 'Social Messages', description: 'Unified outbound messaging for configured social platforms' },
  'modules/studio/routes/group-chat.ts': { name: 'Group Chat', description: 'Cross-agent group chat management' },
  'modules/studio/routes/chat-run.ts': { name: 'Chat Run', description: 'Cross-agent chat run HTTP and Socket.IO bridge operations' },
  'modules/studio/routes/chat-webhooks.ts': { name: 'Chat Webhooks', description: 'Cross-agent Chat Run webhook endpoint management' },
  'modules/studio/routes/tts.ts': { name: 'TTS', description: 'Text-to-speech generation and settings' },
  'modules/studio/routes/stt.ts': { name: 'STT', description: 'Speech-to-text transcription and settings' },
  'modules/studio/routes/media.ts': { name: 'Media', description: 'Media generation endpoints' },
  'modules/studio/routes/performance-monitor.ts': { name: 'Performance', description: 'Runtime performance monitoring' },
  'modules/studio/routes/petdex.ts': { name: 'Petdex', description: 'Desktop pet catalog and assets' },
  'modules/studio/routes/pets.ts': { name: 'Pets', description: 'Per-profile desktop pet settings' },
  'modules/studio/routes/health.ts': { name: 'Health', description: 'Health check' },
  'modules/studio/routes/update.ts': { name: 'Update', description: 'Studio self-update management' },
  'modules/studio/routes/upload.ts': { name: 'Studio Files', description: 'Studio runtime file upload' },
  'modules/studio/routes/auth.ts': { name: 'Auth', description: 'Authentication management' },
  'modules/studio/routes/app-connections.ts': { name: 'App Connections', description: 'Mobile App authorization and connection management' },
  'modules/studio/routes/app-relay.ts': { name: 'App Relay', description: 'Mobile App cloud relay route and connection management' },
  'modules/studio/routes/devices.ts': { name: 'Devices', description: 'Device pairing and LAN peer operations' },
  'modules/studio/routes/mcu-devices.ts': { name: 'MCU Devices', description: 'Microcontroller device management' },
  'modules/studio/routes/mcu-firmware.ts': { name: 'MCU Firmware', description: 'Microcontroller firmware distribution' },
  'modules/studio/routes/theme.ts': { name: 'Theme', description: 'Per-user appearance settings and background image' },
  'modules/studio/routes/api-docs.ts': { name: 'API Docs', description: 'OpenAPI route catalog' },
  'modules/studio/routes/agent-status.ts': { name: 'Agent Status', description: 'In-memory Agent installation, version, and source status' },
  'modules/coding-agents/routes/agents.ts': { name: 'Coding Agents', description: 'Coding agent installation, config, and runs' },
}

// Extract route definitions from route files
function scanRoutes() {
  const paths = {}

  for (const [routeFile, tagInfo] of Object.entries(tagMappings)) {
    const filePath = join(serverSourceDir, routeFile)
    try {
      scanRouteFile(filePath, tagInfo, paths)
    } catch (e) {
      // File might not exist, skip
    }
  }

  return paths
}

function scanRouteFile(filePath, tagInfo, paths) {
  const content = readFileSync(filePath, 'utf-8')
  const controllerContents = readControllerContents(filePath, content)
  const controllerAliases = [...controllerContents.keys()]

  // Pattern 1: controller functions - sessionRoutes.get('/path', middleware, ctrl.method)
  const ctrlRouteRegex = controllerAliases.length
    ? new RegExp(
        `\\w+Routes?\\.(get|post|put|delete|patch)\\(\\s*['"]([^'"]+)['"]\\s*,[^\\n]*?\\b(${controllerAliases.map(escapeRegExp).join('|')})\\.(\\w+)`,
        'g',
      )
    : null

  let match
  while (ctrlRouteRegex && (match = ctrlRouteRegex.exec(content)) !== null) {
    const [, method, path, controllerAlias, controllerMethod] = match
    const controller = controllerContents.get(controllerAlias)
    const controllerSource = controller
      ? extractHandlerSource(controller.filePath, controller.content, controllerMethod)
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

function readControllerContents(routeFilePath, routeContent) {
  const contents = new Map()
  for (const match of routeContent.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [, alias, importPath] = match
    const controllerPath = resolve(dirname(routeFilePath), `${importPath}.ts`)
    try {
      contents.set(alias, {
        content: readFileSync(controllerPath, 'utf-8'),
        filePath: controllerPath,
      })
    } catch {
      // Non-controller namespace imports are ignored by the route scanner.
    }
  }
  return contents
}

function extractHandlerSource(filePath, content, functionName) {
  const source = extractFunctionSource(content, functionName)
  if (!source) return ''

  // Module controllers may intentionally be thin HTTP boundaries that delegate
  // the implementation to a service. Include directly delegated handlers so
  // request parameters remain visible after moving business logic to services.
  const namedImports = readNamedImports(filePath, content)
  const delegatedSources = []
  const seen = new Set()

  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*ctx\s*\)/g)) {
    const localName = match[1]
    const imported = namedImports.get(localName)
    if (!imported || seen.has(localName)) continue
    seen.add(localName)

    try {
      const importedContent = readFileSync(imported.filePath, 'utf-8')
      const delegatedSource = extractFunctionSource(importedContent, imported.importedName)
      if (delegatedSource) delegatedSources.push(delegatedSource)
    } catch {
      // An unresolved delegated import should not prevent the remaining API
      // catalog from being generated.
    }
  }

  return [source, ...delegatedSources].join('\n')
}

function readNamedImports(importerPath, content) {
  const imports = new Map()

  for (const match of content.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, bindings, importPath] = match
    if (!importPath.startsWith('.')) continue

    const importedFilePath = resolveTypeScriptImport(importerPath, importPath)
    if (!importedFilePath) continue

    for (const binding of bindings.split(',')) {
      const parsed = binding.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (!parsed) continue
      const importedName = parsed[1]
      const localName = parsed[2] || importedName
      imports.set(localName, { filePath: importedFilePath, importedName })
    }
  }

  return imports
}

function resolveTypeScriptImport(importerPath, importPath) {
  const basePath = resolve(dirname(importerPath), importPath)
  for (const candidate of [`${basePath}.ts`, join(basePath, 'index.ts')]) {
    try {
      readFileSync(candidate, 'utf-8')
      return candidate
    } catch {
      // Try the next supported TypeScript module path.
    }
  }
  return null
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
  if (/SessionProviderApiMode|CodingAgentApiMode/.test(normalized)) {
    return { ...schema, type: 'string', enum: ['chat_completions', 'codex_responses', 'anthropic_messages'] }
  }
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
  const jsDocRegex = /\/\*\*[\s\S]*?\*\//g
  const matches = Array.from(content.matchAll(jsDocRegex))
  const match = matches.at(-1)
  if (match) {
    const trailingContent = content.slice((match.index || 0) + match[0].length)
    if (trailingContent.trim()) return null
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

  if (path === '/api/studio/group-chat/rooms/:roomId/workspace') {
    responses['403'] = { description: 'Forbidden - Workspace folder is not allowed' }
    responses['404'] = { $ref: '#/components/responses/NotFound' }
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
openapi.paths['/api/studio/chat-run/runs'] = {
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
