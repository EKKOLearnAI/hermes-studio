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
import ts from 'typescript'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(__dirname, '..')
const routesDir = join(rootDir, 'packages/server/src/routes')
const controllersDir = join(rootDir, 'packages/server/src/controllers')
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'))
const schemaSourceRoots = [
  join(rootDir, 'packages/client/src/api'),
  join(rootDir, 'packages/server/src/shared'),
]

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
  'routes/hermes/personal-twin.ts': { name: 'Personal Twin', description: 'Global personal digital twin state and legacy synchronization' },
  'routes/hermes/assistant-roles.ts': { name: 'Assistant Roles', description: 'Assistant role registry, profile mappings, scoped context previews, and context recipes' },
  'routes/hermes/action-fabric.ts': { name: 'Action Fabric', description: 'Governed capability discovery, durable action workflows, audit, and emergency controls' },
  'routes/hermes/health-loop.ts': { name: 'Health Loop', description: 'Protected health ingestion, artifact consent, intervention feedback, and automation settings' },
  'routes/hermes/home.ts': { name: 'Home', description: 'Personal Twin home state, inventory, governed Home Assistant commands, and workflow review' },
  'routes/hermes/internet-execution.ts': { name: 'Internet Execution', description: 'Governed semantic internet reads, durable receipts, and workflow status' },
  'routes/hermes/performance-monitor.ts': { name: 'Performance', description: 'Runtime performance monitoring' },
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
    const routeKey = `routes/hermes/${file}`
    const tagInfo = tagMappings[routeKey]
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
    const controllerSource = controllerContent ? extractControllerSource(controllerContent, controllerMethod) : ''
    addEndpoint(paths, method, path, controllerMethod, tagInfo, content, match.index, controllerSource, controllerContent)
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

function extractFunctionSource(content, functionName, exportedOnly = false) {
  const exportPrefix = exportedOnly ? 'export\\s+' : '(?:export\\s+)?'
  const functionRegex = new RegExp(`${exportPrefix}(?:async\\s+)?function\\s+${functionName}\\b`)
  const match = functionRegex.exec(content)
  if (!match) return ''

  let openBrace = content.indexOf('{', match.index)
  if (openBrace < 0) return ''
  let closeBrace = findMatchingBrace(content, openBrace)
  const beforeFirstBrace = content.slice(match.index, openBrace)
  if (/\)\s*:\s*$/.test(beforeFirstBrace) && closeBrace >= 0) {
    const bodyBrace = content.indexOf('{', closeBrace + 1)
    if (bodyBrace >= 0 && !content.slice(closeBrace + 1, bodyBrace).trim()) {
      openBrace = bodyBrace
      closeBrace = findMatchingBrace(content, openBrace)
    }
  }
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

function addEndpoint(paths, method, path, controllerMethod, tagInfo, content, matchIndex, controllerSource = '', controllerContent = '') {
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
    responses: generateResponses(path, method, extractOpenApiMetadata(controllerContent, controllerMethod)),
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
  collectMatches(source, /(?:stringQuery|integerQuery)\(\s*ctx\s*,\s*['"]([^'"]+)['"]\s*\)/g, names)
  collectMatches(source, /(?:queryIdentifier|queryEnum|queryBoolean|queryInteger|queryProfile|queryText)\(\s*ctx\s*,\s*['"]([^'"]+)['"]/g, names)
  if (/\bqueryLimit\(\s*ctx\s*\)/.test(source)) names.add('limit')

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
  if (new RegExp(`(?:integerQuery|queryInteger)\\(\\s*ctx\\s*,\\s*['"]${escaped}['"]`).test(source)
    || (name === 'limit' && /\bqueryLimit\(\s*ctx\s*\)/.test(source))) {
    return 'integer'
  }
  if (new RegExp(`parseInt\\([^)]*\\b${escaped}\\b`).test(source) || new RegExp(`Number\\([^)]*\\b${escaped}\\b`).test(source)) {
    return 'integer'
  }
  if (new RegExp(`\\b${escaped}\\b[^\\n]*(?:===|!==)\\s*['"](?:true|false|0|1)['"]`).test(source)) {
    return 'boolean'
  }
  if (new RegExp(`(?:boolQuery|queryBoolean)\\([^)]*\\b${escaped}\\b`).test(source)) {
    return 'boolean'
  }
  return 'string'
}

function isRequiredQueryParam(name, source) {
  return extractRequiredNamesFromMessages(source).has(name)
}

function inferEnumValues(name, source) {
  const escaped = escapeRegExp(name)
  const values = comparedBusinessLiterals(name, source)
  const queryEnumCall = source.match(new RegExp(`queryEnum\\(\\s*ctx\\s*,\\s*['"]${escaped}['"]\\s*,\\s*\\[([^\\]]*)\\]`))
  if (queryEnumCall) {
    collectMatches(queryEnumCall[1], /['"]([^'"]+)['"]/g, values)
    const spreadSet = queryEnumCall[1].match(/\.\.\.([A-Z][A-Z0-9_]*)/)?.[1]
    if (spreadSet) {
      const declaration = source.match(new RegExp(`const\\s+${escapeRegExp(spreadSet)}[\\s\\S]*?new\\s+Set(?:<[^>]+>)?\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`))
      if (declaration) collectMatches(declaration[1], /['"]([^'"]+)['"]/g, values)
    }
  }
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

function comparedBusinessLiterals(name, source) {
  const values = new Set()
  const sentinels = new Set(['string', 'number', 'boolean', 'object', 'undefined', 'function', 'symbol', 'bigint'])
  const file = ts.createSourceFile('controller-fragment.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  function visit(node) {
    if (ts.isBinaryExpression(node)
      && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
      && !ts.isTypeOfExpression(node.left)
      && ts.isStringLiteral(node.right)) {
      const leftName = ts.isIdentifier(node.left) ? node.left.text
        : ts.isPropertyAccessExpression(node.left) ? node.left.name.text
          : ts.isElementAccessExpression(node.left) && ts.isStringLiteral(node.left.argumentExpression) ? node.left.argumentExpression.text : ''
      if (leftName === name && !sentinels.has(node.right.text)) values.add(node.right.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return values
}

function guardedPrimitiveType(name, source) {
  const types = new Set()
  const file = ts.createSourceFile('controller-fragment.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  function visit(node) {
    if (ts.isBinaryExpression(node) && ts.isTypeOfExpression(node.left) && ts.isStringLiteral(node.right)) {
      const expression = node.left.expression
      const guardedName = ts.isIdentifier(expression) ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text
          : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : ''
      if (guardedName === name && ['string', 'number', 'boolean'].includes(node.right.text)) types.add(node.right.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return types.size === 1 ? Array.from(types)[0] : null
}

function generateRequestBody(method, source) {
  if (!['post', 'put', 'patch'].includes(method)) return null
  if (!source || !/(ctx\.request\??\.body|requestBody\(ctx\b|bodyObject\(ctx\))/.test(source)) return null

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
  schema.additionalProperties = /requestBody\(ctx,\s*(?:[A-Z_]+|new Set)/.test(source) ? false : true

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
      const explicitSchema = explicitTypeSchema(field.type, source)
      addBodyField(fields, {
        name: field.name,
        schema: explicitSchema || schemaFromType(field.type, field.name, source),
        explicit: Boolean(explicitSchema),
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

  for (const name of extractBodyValidatorFieldNames(source)) {
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
  if (existing.explicit) return
  if (next.explicit) {
    existing.schema = next.schema
    existing.explicit = true
    return
  }
  existing.schema = mergeSchema(existing.schema, next.schema)
}

function mergeSchema(current, next) {
  if (Object.keys(current).length === 0) return next
  if (Object.keys(next).length === 0) return current
  const isUnknownObject = schema => schema.type === 'object'
    && (Object.keys(schema).length === 1 || (schema.additionalProperties === true && !schema.properties))
  if (isUnknownObject(current)) return next
  if (isUnknownObject(next)) return current
  return current
}

function extractOpenApiMetadata(content, functionName) {
  if (!content) return null
  const functionMatch = new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\b`).exec(content)
  if (!functionMatch) return null
  const preceding = content.slice(0, functionMatch.index)
  const responseType = preceding.match(/\/\*\*([^*]|\*(?!\/))*@openapi-response\s+([A-Za-z_$][\w$]*)([^*]|\*(?!\/))*\*\/\s*$/)?.[2]
  if (!responseType) return null
  const errorsText = content.match(/@openapi-default-errors\s+([^*\r\n]+)/)?.[1] || ''
  const errors = Object.fromEntries(errorsText.split(',').map(entry => entry.trim().split(':')).filter(([status, type]) => /^\d{3}$/.test(status) && type))
  return { responseType, errors }
}

function extractControllerSource(content, functionName) {
  const file = ts.createSourceFile('controller.ts', content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const functions = new Map()
  const constants = new Map()
  const typeDeclarations = new Map()
  const isExported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  const hasHelperAnnotation = node => content.slice(node.getFullStart(), node.getStart(file)).includes('@openapi-helper')
  for (const statement of file.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      typeDeclarations.set(statement.name.text, statement)
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, { node: statement, exported: isExported(statement), callable: !isExported(statement) || hasHelperAnnotation(statement) })
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        constants.set(declaration.name.text, statement)
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          functions.set(declaration.name.text, {
            node: declaration.initializer,
            exported: isExported(statement),
            callable: !isExported(statement) || hasHelperAnnotation(statement),
          })
        }
      }
    }
  }
  const root = functions.get(functionName)
  if (!root?.exported) return ''

  const selected = []
  const visited = new Set()
  const collectBinding = (name, output) => {
    if (ts.isIdentifier(name)) output.add(name.text)
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) if (ts.isBindingElement(element)) collectBinding(element.name, output)
    }
  }
  function follow(name, entry, isRoot = false) {
    if (visited.has(name)) return
    visited.add(name)
    selected.push(entry.node)
    const localBindings = new Set()
    for (const parameter of entry.node.parameters || []) collectBinding(parameter.name, localBindings)
    function collectLocals(node) {
      if (ts.isVariableDeclaration(node)) collectBinding(node.name, localBindings)
      else if (ts.isFunctionDeclaration(node) && node !== entry.node && node.name) localBindings.add(node.name.text)
      ts.forEachChild(node, collectLocals)
    }
    collectLocals(entry.node.body)
    function visitCalls(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const called = node.expression.text
        const helper = functions.get(called)
        if (helper?.callable && !localBindings.has(called)) follow(called, helper)
      }
      ts.forEachChild(node, visitCalls)
    }
    visitCalls(entry.node.body)
  }
  follow(functionName, root, true)

  const referencedConstants = new Set()
  const referencedTypes = new Set()
  const collectTypeReferences = node => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && typeDeclarations.has(node.typeName.text)) {
      if (referencedTypes.has(node.typeName.text)) return
      referencedTypes.add(node.typeName.text)
      collectTypeReferences(typeDeclarations.get(node.typeName.text))
    }
    ts.forEachChild(node, collectTypeReferences)
  }
  for (const node of selected) collectTypeReferences(node)
  for (const node of selected) {
    function visitSpread(child) {
      if (ts.isSpreadElement(child) && ts.isIdentifier(child.expression) && constants.has(child.expression.text)) {
        referencedConstants.add(child.expression.text)
      }
      ts.forEachChild(child, visitSpread)
    }
    visitSpread(node)
  }
  return [
    ...Array.from(referencedTypes).sort().map(name => typeDeclarations.get(name).getText(file)),
    ...Array.from(referencedConstants).sort().map(name => constants.get(name).getText(file)),
    ...selected.map(node => node.getText(file)),
  ].join('\n')
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
  const file = ts.createSourceFile('controller-fragment.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const unwrap = node => {
    while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node))) node = node.expression
    return node
  }
  const isCtxBody = node => {
    node = unwrap(node)
    if (!node) return false
    const raw = node.getText(file).replace(/\?/g, '')
    if (/^(?:requestBody|bodyObject)\(ctx\b/.test(raw)) return true
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['requestBody', 'bodyObject'].includes(node.expression.text)) return true
    const text = raw
    return text === 'ctx.request.body' || text === 'bodyResult.body' || text === 'requestBody(ctx).body'
  }
  function inspectFunction(node) {
    const bodyVariables = new Set()
    const functionText = node.getText(file)
    for (const match of functionText.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:requestBody|bodyObject)\(ctx\b/g)) bodyVariables.add(match[1])
    function collectVariables(child) {
      if (child !== node && ts.isFunctionLike(child)) return
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && isCtxBody(child.initializer)) bodyVariables.add(child.name.text)
      ts.forEachChild(child, collectVariables)
    }
    collectVariables(node.body)
    for (const variable of bodyVariables) collectMatches(functionText, new RegExp(`\\b${escapeRegExp(variable)}\\.([A-Za-z_$][\\w$]*)`, 'g'), names)
    function collectProperties(child) {
      if (child !== node && ts.isFunctionLike(child)) return
      if (ts.isPropertyAccessExpression(child)) {
        const expression = unwrap(child.expression)
        if (ts.isIdentifier(expression) && bodyVariables.has(expression.text)) names.add(child.name.text)
        const text = expression?.getText(file).replace(/\?/g, '')
        if (text === 'ctx.request.body') names.add(child.name.text)
      }
      ts.forEachChild(child, collectProperties)
    }
    collectProperties(node.body)
  }
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement)) inspectFunction(statement)
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) inspectFunction(declaration.initializer)
    }
  }
  return Array.from(names)
}

function extractBodyVariableNames(source) {
  const names = []
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)\s*)?ctx\.request\??\.body/g)) {
    names.push(match[1])
  }
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:bodyResult\.body|requestBody\(ctx\b[^)]*\)(?:\.body)?)/g)) {
    names.push(match[1])
  }
  for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*bodyObject\(ctx\)/g)) {
    names.push(match[1])
  }
  return Array.from(new Set(names))
}

function inferRequiredBodyNames(source) {
  const names = extractRequiredNamesFromMessages(source)
  collectMatches(source, /required\w*\([^,]+,\s*['"]([^'"]+)['"]/g, names)
  collectMatches(source, /Number\.isSafeInteger\(\w+\.([A-Za-z_$][\w$]*)\)/g, names)
  for (const entry of extractDestructuredBodyEntries(source)) {
    const escaped = escapeRegExp(entry.local)
    if (new RegExp(`if\\s*\\([^)]*!\\s*${escaped}\\b`).test(source)
      || new RegExp(`\\|\\|\\s*!\\s*${escaped}\\b`).test(source)
      || new RegExp(`&&\\s*!\\s*${escaped}\\b`).test(source)) {
      names.add(entry.name)
    }
  }
  for (const match of source.matchAll(/const\s+input(?:\s*:[^=]+)?\s*=\s*\{/g)) {
    const openBrace = source.indexOf('{', match.index)
    const closeBrace = findMatchingBrace(source, openBrace)
    if (openBrace < 0 || closeBrace < 0) continue
    for (const entry of splitTopLevel(source.slice(openBrace + 1, closeBrace))) {
      const field = entry.trim().match(/^([A-Za-z_$][\w$]*)\s*:/)?.[1]
      if (field) names.add(field)
    }
  }
  return names
}

function extractBodyValidatorFieldNames(source) {
  const names = new Set()
  collectMatches(source, /(?:requiredString|requiredIdentifier|requiredText|requiredJsonObject|requiredInteger|optionalString|optionalBoolean)\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([^'"]+)['"]/g, names)
  for (const match of source.matchAll(/for\s*\(\s*const\s+[A-Za-z_$][\w$]*\s+of\s+\[([^\]]+)\]\s+as\s+const\s*\)/g)) {
    collectMatches(match[1], /['"]([^'"]+)['"]/g, names)
  }
  return Array.from(names)
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
  const guardedType = guardedPrimitiveType(name, source)
  if (guardedType) {
    const nullable = new RegExp(`\\b\\w+\\.${escaped}\\s*!==?\\s*null`).test(source)
    return { type: guardedType, ...(nullable ? { nullable: true } : {}) }
  }
  if (new RegExp(`requiredJsonObject\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) {
    return { type: 'object', additionalProperties: true }
  }
  if (new RegExp(`parseMoney\\(\\w+\\.${escaped}\\)`).test(source)) {
    return { type: 'object', properties: { currency: { type: 'string' }, amountMinor: { type: 'integer', minimum: 0 } }, required: ['currency', 'amountMinor'], additionalProperties: false }
  }
  if (new RegExp(`requiredInteger\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'integer' }
  const numericProperty = new RegExp(`Number\\.isSafeInteger\\(\\w+\\.${escaped}\\)`).test(source)
  if (numericProperty) {
    const propertyPattern = `(?:\\w+\\.${escaped}|\\(\\w+\\.${escaped}\\s+as\\s+number\\))`
    const minimum = source.match(new RegExp(`${propertyPattern}\\s*<\\s*(\\d+)`))?.[1]
    const maximum = source.match(new RegExp(`${propertyPattern}\\s*>\\s*(\\d+)`))?.[1]
    return { type: 'integer', ...(minimum ? { minimum: Number(minimum) } : {}), ...(maximum ? { maximum: Number(maximum) } : {}) }
  }
  if (new RegExp(`optionalBoolean\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'boolean' }
  if (new RegExp(`optional(?:Positive)?Integer\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'integer' }
  if (new RegExp(`(?:optional|required)\\w*StringArray\\([^,]+,\\s*['"]${escaped}['"]`).test(source)) return { type: 'array', items: { type: 'string' } }
  if (new RegExp(`stringArray\\(\\s*\\w+\\.${escaped}\\b`).test(source)) return { type: 'array', items: { type: 'string' } }
  if (new RegExp(`objectArray\\(\\s*\\w+\\.${escaped}\\b`).test(source)) return { type: 'array', items: { type: 'object', additionalProperties: true } }
  if (new RegExp(`jsonObject\\(\\s*\\w+\\.${escaped}\\b`).test(source)) return { type: 'object', additionalProperties: true }
  const validatorSchema = schemaFromObjectValidator(name, source)
  if (validatorSchema) return validatorSchema
  const validatedSchema = schemaFromValidation(name, source)
  if (validatedSchema) return validatedSchema
  if (new RegExp(`\\b\\w+\\.${escaped}\\s*!==?\\s*null`).test(source)) return { type: 'string', nullable: true }
  if (new RegExp(`(?:StringArray|task_ids|ids)`, 'i').test(name)) return { type: 'array', items: { type: 'string' } }
  return { type: 'string' }
}

function schemaFromObjectValidator(name, source) {
  const escaped = escapeRegExp(name)
  const call = source.match(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\(\\s*\\w+\\.${escaped}\\b`))
  if (!call) return null
  const validatorSource = extractFunctionSource(source, call[1])
  const signature = validatorSource.match(new RegExp(`function\\s+${escapeRegExp(call[1])}\\s*\\(\\s*([A-Za-z_$][\\w$]*)`))
  if (!validatorSource || !signature) return null

  const valueName = signature[1]
  const validatorFile = ts.createSourceFile('validator.ts', validatorSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const primitiveTypes = new Set()
  let objectGuard = false
  let arrayGuard = false
  let arrayItemType = null
  const propertyNames = new Set()
  function visit(node) {
    if (ts.isBinaryExpression(node) && ts.isTypeOfExpression(node.left) && ts.isIdentifier(node.left.expression)
      && node.left.expression.text === valueName && ts.isStringLiteral(node.right)) {
      if (['string', 'number', 'boolean', 'bigint'].includes(node.right.text)) primitiveTypes.add(node.right.text)
      if (node.right.text === 'object') objectGuard = true
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(validatorFile) === 'Array' && node.expression.name.text === 'isArray'
      && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === valueName) {
      if (ts.isPrefixUnaryExpression(node.parent) && node.parent.operator === ts.SyntaxKind.ExclamationToken) arrayGuard = true
    }
    if (ts.isTypeOfExpression(node) && ts.isIdentifier(node.expression) && node.expression.text !== valueName
      && ts.isBinaryExpression(node.parent) && ts.isStringLiteral(node.parent.right)
      && ['string', 'number', 'boolean'].includes(node.parent.right.text)) arrayItemType = node.parent.right.text
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === valueName) {
      const isMethodCall = ts.isCallExpression(node.parent) && node.parent.expression === node
      if (!isMethodCall) propertyNames.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(validatorFile)
  if (primitiveTypes.size === 1) {
    const type = Array.from(primitiveTypes)[0]
    return { type: type === 'bigint' ? 'integer' : type }
  }
  if (!objectGuard && arrayGuard) return { type: 'array', items: arrayItemType ? { type: arrayItemType } : {} }
  const dataProperties = Array.from(propertyNames)
  if (!objectGuard && !dataProperties.length) return null

  const properties = {}
  for (const property of dataProperties) {
    const propertyPattern = `${escapeRegExp(valueName)}\\.${escapeRegExp(property)}`
    if (new RegExp(`stringArray\\(\\s*${propertyPattern}\\b`).test(validatorSource)) {
      properties[property] = { type: 'array', items: { type: 'string' } }
      continue
    }
    if (new RegExp(`typeof\\s+${propertyPattern}\\s*!==?\\s*['"]boolean['"]`).test(validatorSource)) {
      properties[property] = { type: 'boolean' }
      continue
    }
    if (new RegExp(`Number\\.isInteger\\(\\s*${propertyPattern}\\s*\\)`).test(validatorSource)) {
      const numberPattern = `(?:${propertyPattern}|\\(${propertyPattern}\\s+as\\s+number\\))`
      const minimum = validatorSource.match(new RegExp(`${numberPattern}\\s*<\\s*(\\d+)`))?.[1]
      const maximum = validatorSource.match(new RegExp(`${numberPattern}\\s*>\\s*(\\d+)`))?.[1]
      properties[property] = {
        type: 'integer',
        ...(minimum ? { minimum: Number(minimum) } : {}),
        ...(maximum ? { maximum: Number(maximum) } : {}),
      }
      continue
    }
    const enumValues = Array.from(validatorSource.matchAll(new RegExp(`${propertyPattern}\\s*!==?\\s*['"]([^'"]+)['"]`, 'g')))
      .map(match => match[1])
    properties[property] = enumValues.length
      ? { type: 'string', enum: [...new Set(enumValues)] }
      : { type: 'string' }
  }
  return { type: 'object', properties, required: dataProperties }
}

function schemaFromValidation(name, source) {
  const escaped = escapeRegExp(name)
  if (new RegExp(`Array\\.isArray\\([^)]*\\.${escaped}\\)[\\s\\S]{0,250}\\.${escaped}\\.some\\([^)]*typeof\\s+\\w+\\s*!==?\\s*['"]string['"]`).test(source)) {
    return { type: 'array', items: { type: 'string' } }
  }
  return null
}

function explicitTypeSchema(type, source) {
  const file = ts.createSourceFile('controller-types.ts', `${source}\ntype __OpenApiField = ${type}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = new Map()
  let root = null
  for (const statement of file.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) {
      if (statement.name.text === '__OpenApiField' && ts.isTypeAliasDeclaration(statement)) root = statement.type
      else declarations.set(statement.name.text, statement)
    }
  }
  const resolving = new Set()
  function resolveNode(node) {
    if (!node) return null
    if (node.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' }
    if (node.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' }
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' }
    if (node.kind === ts.SyntaxKind.UnknownKeyword || node.kind === ts.SyntaxKind.AnyKeyword) return null
    if (ts.isLiteralTypeNode(node)) {
      if (node.literal.kind === ts.SyntaxKind.NullKeyword) return { nullable: true }
      if (ts.isStringLiteral(node.literal)) return { type: 'string', enum: [node.literal.text] }
      if (ts.isNumericLiteral(node.literal)) return { type: 'number', enum: [Number(node.literal.text)] }
    }
    if (ts.isArrayTypeNode(node)) {
      const items = resolveNode(node.elementType)
      return items ? { type: 'array', items } : null
    }
    if (ts.isUnionTypeNode(node)) {
      const nullable = node.types.some(member => ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)
      const members = node.types.filter(member => !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword))
      const schemas = members.map(resolveNode)
      if (schemas.some(schema => !schema)) return null
      const literals = schemas.every(schema => schema.enum?.length === 1)
      const schema = literals
        ? { type: schemas.every(item => item.type === 'number') ? 'number' : 'string', enum: schemas.flatMap(item => item.enum) }
        : schemas.length === 1 ? schemas[0] : { oneOf: schemas }
      return nullable ? { ...schema, nullable: true } : schema
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      if (node.typeName.text === 'Array') {
        const items = resolveNode(node.typeArguments?.[0])
        return items ? { type: 'array', items } : null
      }
      if (node.typeName.text === 'Record') return { type: 'object', additionalProperties: true }
      const declaration = declarations.get(node.typeName.text)
      if (!declaration || resolving.has(node.typeName.text)) return null
      resolving.add(node.typeName.text)
      const result = ts.isTypeAliasDeclaration(declaration) ? resolveNode(declaration.type) : objectFromMembers(declaration.members)
      resolving.delete(node.typeName.text)
      return result
    }
    if (ts.isTypeLiteralNode(node)) return objectFromMembers(node.members)
    return null
  }
  function objectFromMembers(members) {
    const properties = {}
    const required = []
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.name) continue
      const schema = resolveNode(member.type)
      if (!schema) return null
      const name = member.name.getText(file).replace(/^['"]|['"]$/g, '')
      properties[name] = schema
      if (!member.questionToken) required.push(name)
    }
    return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
  }
  return resolveNode(root)
}

function schemaFromType(type, name = '', source = '') {
  const normalized = type.replace(/\s+/g, ' ')
  const schema = {}

  const explicit = explicitTypeSchema(type, source)
  if (explicit) return explicit

  const validatedSchema = name ? schemaFromValidation(name, source) : null
  if (validatedSchema) return validatedSchema
  const guardedType = name ? guardedPrimitiveType(name, source) : null
  if (guardedType) return { type: guardedType, ...(/\bnull\b/.test(normalized) ? { nullable: true } : {}) }
  if (/\bnull\b/.test(normalized)) schema.nullable = true
  if (/string\[\]|Array<string>/.test(normalized)) {
    return { ...schema, type: 'array', items: { type: 'string' } }
  }
  if (/number/.test(normalized)) return { ...schema, type: 'number' }
  if (/boolean/.test(normalized)) return { ...schema, type: 'boolean' }
  if (/^(?:unknown|any)$/.test(normalized)) return schema
  if (/Record<|object|\{/.test(normalized)) return { ...schema, type: 'object', additionalProperties: true }
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

function generateResponses(path, method, metadata) {
  if (metadata) {
    const responses = {
      '200': {
        description: 'Success',
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${metadata.responseType}` } } },
      },
    }
    for (const [status, type] of Object.entries(metadata.errors)) {
      responses[status] = {
        description: status === '401' ? 'Authentication required' : 'Request failed',
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${type}` } } },
      }
    }
    return responses
  }
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

function generateTypeScriptSchemas(filePath) {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const declarations = new Map()
  for (const node of source.statements) {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name) declarations.set(node.name.text, node)
  }

  const ref = name => ({ $ref: `#/components/schemas/${name}` })
  const isNullType = node => node.kind === ts.SyntaxKind.NullKeyword || (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword)
  const literalValue = node => ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : node.kind === ts.SyntaxKind.TrueKeyword ? true : false
  function nullable(schema) {
    return schema.$ref ? { allOf: [schema], nullable: true } : { ...schema, nullable: true }
  }
  function schemaForType(node) {
    if (!node) return {}
    if (node.kind === ts.SyntaxKind.StringKeyword) return { type: 'string' }
    if (node.kind === ts.SyntaxKind.NumberKeyword) return { type: 'number' }
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return { type: 'boolean' }
    if (node.kind === ts.SyntaxKind.UnknownKeyword || node.kind === ts.SyntaxKind.AnyKeyword) return {}
    if (ts.isLiteralTypeNode(node)) return { type: typeof literalValue(node.literal) === 'number' ? 'number' : typeof literalValue(node.literal), enum: [literalValue(node.literal)] }
    if (ts.isArrayTypeNode(node)) return { type: 'array', items: schemaForType(node.elementType) }
    if (ts.isParenthesizedTypeNode(node)) return schemaForType(node.type)
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(source)
      if (name === 'Array') return { type: 'array', items: schemaForType(node.typeArguments?.[0]) }
      if (name === 'Record') return { type: 'object', additionalProperties: schemaForType(node.typeArguments?.[1]) }
      return ref(name)
    }
    if (ts.isUnionTypeNode(node)) {
      const hasNull = node.types.some(isNullType)
      const members = node.types.filter(type => !isNullType(type))
      const literalMembers = members.filter(ts.isLiteralTypeNode)
      let schema
      if (literalMembers.length === members.length && members.length) {
        const values = literalMembers.map(type => literalValue(type.literal))
        schema = { type: values.every(value => typeof value === 'number') ? 'number' : 'string', enum: values }
      } else if (members.length === 1) schema = schemaForType(members[0])
      else schema = { oneOf: members.map(schemaForType) }
      return hasNull ? nullable(schema) : schema
    }
    if (ts.isTypeLiteralNode(node)) return objectSchema(node.members)
    if (ts.isMappedTypeNode(node)) {
      const keyType = node.typeParameter.constraint
      const keySchema = schemaForType(keyType)
      const keys = keySchema.$ref ? unionValues(keySchema.$ref.split('/').pop()) : keySchema.enum
      const properties = Object.fromEntries((keys || []).map(key => [String(key), schemaForType(node.type)]))
      return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
    }
    return {}
  }
  function unionValues(name) {
    const declaration = declarations.get(name)
    if (!declaration || !ts.isTypeAliasDeclaration(declaration)) return []
    return schemaForType(declaration.type).enum || []
  }
  function objectSchema(members, bases = []) {
    const properties = {}
    const required = []
    let additionalProperties = false
    for (const base of bases) {
      const baseSchema = schemaForName(base)
      Object.assign(properties, baseSchema.properties || {})
      required.push(...(baseSchema.required || []))
    }
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.name) {
        const name = member.name.getText(source).replace(/^['"]|['"]$/g, '')
        properties[name] = schemaForType(member.type)
        if (!member.questionToken) required.push(name)
      } else if (ts.isIndexSignatureDeclaration(member)) {
        additionalProperties = schemaForType(member.type)
      }
    }
    return { type: 'object', properties, ...(required.length ? { required: [...new Set(required)] } : {}), additionalProperties }
  }
  function schemaForName(name) {
    const declaration = declarations.get(name)
    if (!declaration) return {}
    if (ts.isTypeAliasDeclaration(declaration)) return schemaForType(declaration.type)
    const bases = declaration.heritageClauses?.flatMap(clause => clause.types.map(type => type.expression.getText(source))) || []
    return objectSchema(declaration.members, bases)
  }
  return Object.fromEntries(Array.from(declarations.keys()).map(name => [name, schemaForName(name)]))
}

function discoverTypeScriptSchemas(roots) {
  const files = []
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child)
    }
  }
  for (const root of roots) visit(root)
  const schemas = {}
  for (const file of files.sort()) {
    const source = readFileSync(file, 'utf8')
    if (!/^\s*\/\*\*[\s\S]*?@openapi-schema-source[\s\S]*?\*\//.test(source)) continue
    for (const [name, schema] of Object.entries(generateTypeScriptSchemas(file))) {
      if (schemas[name] && JSON.stringify(schemas[name]) !== JSON.stringify(schema)) {
        throw new Error(`Conflicting OpenAPI schema declaration: ${name}`)
      }
      schemas[name] = schema
    }
  }
  const missing = new Set()
  const inspect = value => {
    if (!value || typeof value !== 'object') return
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/components/schemas/')) {
      const name = value.$ref.slice('#/components/schemas/'.length)
      if (!schemas[name]) missing.add(name)
    }
    for (const child of Object.values(value)) inspect(child)
  }
  for (const schema of Object.values(schemas)) inspect(schema)
  if (missing.size) throw new Error(`Missing OpenAPI schema references: ${Array.from(missing).sort().join(', ')}`)
  return schemas
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
const controllerExtractionIndex = process.argv.indexOf('--extract-controller-source')
if (controllerExtractionIndex >= 0) {
  const [filePath, handler] = process.argv.slice(controllerExtractionIndex + 1)
  process.stdout.write(extractControllerSource(readFileSync(resolve(filePath), 'utf8'), handler))
  process.exit(0)
}
const bodyExtractionIndex = process.argv.indexOf('--extract-body-properties')
if (bodyExtractionIndex >= 0) {
  const [filePath, handler] = process.argv.slice(bodyExtractionIndex + 1)
  const content = readFileSync(resolve(filePath), 'utf8')
  process.stdout.write(`${JSON.stringify(extractBodyPropertyNames(extractControllerSource(content, handler)))}\n`)
  process.exit(0)
}
const requestInferenceIndex = process.argv.indexOf('--infer-controller-request')
if (requestInferenceIndex >= 0) {
  const [filePath, handler] = process.argv.slice(requestInferenceIndex + 1)
  const content = readFileSync(resolve(filePath), 'utf8')
  process.stdout.write(`${JSON.stringify(generateRequestBody('post', extractControllerSource(content, handler)))}\n`)
  process.exit(0)
}
const schemaValidationIndex = process.argv.indexOf('--validate-schema-sources')
const selectedSchemaRoots = schemaValidationIndex >= 0
  ? process.argv.slice(schemaValidationIndex + 1).map(path => resolve(path))
  : schemaSourceRoots
openapi.components.schemas = discoverTypeScriptSchemas(selectedSchemaRoots)
if (schemaValidationIndex >= 0) {
  process.stdout.write(`${JSON.stringify(openapi.components.schemas)}\n`)
  process.exit(0)
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

// Health Loop uses strict DTOs and multipart upload; keep these contracts explicit instead of
// relying on the generic body-field inference used by legacy controllers.
const healthId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' }
const healthDigest = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const healthTimestamp = { type: 'string', format: 'date-time', maxLength: 64 }
const exactObject = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false })
const schemaRef = name => ({ $ref: `#/components/schemas/${name}` })
const healthDomains = ['body_composition', 'measurements', 'posture', 'skin', 'diet', 'fitness', 'sleep', 'internal_health']
const healthManifest = exactObject({
  artifactIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', pattern: '^artifact-[a-f0-9]{64}$' } },
  processor: healthId,
  purpose: { type: 'string', enum: ['measurement', 'posture', 'skin', 'diet', 'internal_health'] },
  selectedRegions: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 160 } },
  requestedFields: { type: 'array', minItems: 1, maxItems: 128, items: { type: 'string', maxLength: 100 } },
  retention: { type: 'string', enum: ['no_retention', 'session', '24_hours'] },
}, ['artifactIds', 'processor', 'purpose', 'selectedRegions', 'requestedFields', 'retention'])
Object.assign(openapi.components.schemas, {
  HealthLoopError: exactObject({ error: { type: 'string' }, code: { type: 'string', pattern: '^HEALTH_[A-Z0-9_]+$' } }, ['error', 'code']),
  HealthSettingsDto: exactObject({ subjectId: healthId, liveDeliveryEnabled: { type: 'boolean' }, profile: { type: 'string', maxLength: 100 }, recipient: { type: 'string', enum: ['configured-self'] }, configuredConnectors: { type: 'array', maxItems: 32, items: healthId }, configuredProcessors: { type: 'array', maxItems: 32, items: healthId }, version: { type: 'integer', minimum: 1 }, updatedAt: healthTimestamp }, ['subjectId', 'liveDeliveryEnabled', 'profile', 'recipient', 'configuredConnectors', 'configuredProcessors', 'version', 'updatedAt']),
  HealthConnectorCapabilitiesDto: exactObject({ read: { type: 'array', uniqueItems: true, items: { type: 'string', enum: healthDomains } }, write: { type: 'array', uniqueItems: true, items: { type: 'string', enum: healthDomains } } }, ['read', 'write']),
  HealthFreshnessDto: exactObject(Object.fromEntries(healthDomains.map(domain => [domain, healthTimestamp]))),
  HealthConnectorDto: exactObject({ id: healthId, configured: { type: 'boolean' }, configurationState: { type: 'string', enum: ['configured', 'not_configured', 'invalid'] }, authorizationState: { type: 'string', enum: ['authorized', 'not_required', 'required', 'expired', 'unknown'] }, health: { type: 'string', enum: ['healthy', 'degraded', 'unhealthy', 'unavailable'] }, lastAttemptAt: healthTimestamp, lastSuccessAt: healthTimestamp, domains: { type: 'array', uniqueItems: true, items: { type: 'string', enum: healthDomains } }, freshnessByDomain: schemaRef('HealthFreshnessDto'), capabilities: schemaRef('HealthConnectorCapabilitiesDto'), errorCode: { type: 'string', pattern: '^CONNECTOR_[A-Z0-9_]+$' } }, ['id', 'configured', 'configurationState', 'authorizationState', 'health', 'domains', 'freshnessByDomain', 'capabilities']),
  HealthOverviewSummaryDto: exactObject({ interventionCount: { type: 'integer', minimum: 0 }, activeInterventionCount: { type: 'integer', minimum: 0 }, projectionCount: { type: 'integer', minimum: 0 } }, ['interventionCount', 'activeInterventionCount', 'projectionCount']),
  HealthActionIntentDto: exactObject({ id: healthId, capabilityId: healthId }, ['id', 'capabilityId']),
  HealthPolicyDecisionDto: exactObject({ id: healthId, outcome: { type: 'string', enum: ['allow', 'deny', 'waiting_user'] }, reasonCodes: { type: 'array', maxItems: 64, items: healthId } }, ['id', 'outcome', 'reasonCodes']),
  HealthAvailableActionsDto: exactObject({ approve: { type: 'boolean' }, reject: { type: 'boolean' }, cancel: { type: 'boolean' }, retry: { type: 'boolean' }, compensate: { type: 'boolean' } }, ['approve', 'reject', 'cancel', 'retry', 'compensate']),
  HealthWorkflowDto: exactObject({ id: healthId, state: { type: 'string', enum: ['draft', 'policy_check', 'preparing', 'executing', 'verifying', 'waiting_user', 'retrying', 'compensating', 'succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated'] }, version: { type: 'integer', minimum: 1 }, availableActions: schemaRef('HealthAvailableActionsDto') }, ['id', 'state', 'version', 'availableActions']),
  HealthAnalysisMetadataDto: exactObject({ purpose: { type: 'string', enum: ['measurement', 'posture', 'skin', 'diet', 'internal_health'] }, selectedRegions: { type: 'array', uniqueItems: true, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 160, pattern: '^[\\p{L}\\p{N}._:/-]+$' } }, requestedFields: { type: 'array', uniqueItems: true, maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z][A-Za-z0-9._:-]*$' } }, format: { type: 'string', enum: ['json', 'csv', 'report_text'] } }),
  HealthPublicMetadataDto: exactObject({ healthAnalysis: schemaRef('HealthAnalysisMetadataDto'), notes: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 1024 } } }),
  HealthArtifactDto: exactObject({ id: { type: 'string', pattern: '^artifact-[a-f0-9]{64}$' }, mediaType: { type: 'string', maxLength: 160 }, sizeBytes: { type: 'integer', minimum: 1, maximum: 262144000 }, manifestDigest: healthDigest, metadata: schemaRef('HealthPublicMetadataDto'), createdAt: healthTimestamp }, ['id', 'mediaType', 'sizeBytes', 'manifestDigest', 'metadata', 'createdAt']),
  HealthConsentManifestDto: healthManifest,
  HealthConsentGrantDto: exactObject({ consentId: healthId, manifestDigest: healthDigest, manifest: schemaRef('HealthConsentManifestDto'), issuedAt: healthTimestamp, expiresAt: healthTimestamp, token: { type: 'string', pattern: '^[a-f0-9]{64}$', writeOnly: true } }, ['consentId', 'manifestDigest', 'manifest', 'issuedAt', 'expiresAt', 'token']),
  HealthConsentRevocationDto: exactObject({ consentId: healthId, revokedAt: healthTimestamp }, ['consentId', 'revokedAt']),
  HealthInterventionDto: exactObject({ actionId: healthId, interventionId: healthId, workflowId: healthId, capabilityId: healthId, category: { type: 'string', enum: ['training', 'recovery', 'nutrition', 'posture', 'skin', 'internal_health'] }, priority: { type: 'integer', minimum: 0, maximum: 10000 }, risk: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'critical'] }, authority: { type: 'string', enum: ['auto', 'approval', 'inform_only'] }, status: { type: 'string', enum: ['active', 'completed', 'superseded'] }, effectiveDate: { type: 'string', format: 'date' }, createdAt: healthTimestamp, supersededAt: { ...healthTimestamp, nullable: true } }, ['actionId', 'interventionId', 'workflowId', 'capabilityId', 'category', 'priority', 'risk', 'authority', 'status', 'effectiveDate', 'createdAt', 'supersededAt']),
  HealthFeedbackDto: exactObject({ feedbackId: healthId, outcome: { type: 'string', enum: ['completed', 'partial', 'skipped', 'deferred', 'adverse_feedback', 'unsuitable', 'data_incorrect', 'expired'] }, actionId: healthId, interventionId: healthId, occurredAt: healthTimestamp, reviewRequired: { type: 'boolean' }, supersededActionIds: { type: 'array', maxItems: 256, items: healthId } }, ['feedbackId', 'outcome', 'actionId', 'interventionId', 'occurredAt', 'reviewRequired', 'supersededActionIds']),
  HealthLoopOverviewResponse: exactObject({ settings: schemaRef('HealthSettingsDto'), connectors: { type: 'array', items: schemaRef('HealthConnectorDto') }, summary: schemaRef('HealthOverviewSummaryDto') }, ['settings', 'connectors', 'summary']),
  HealthConnectorListResponse: exactObject({ connectors: { type: 'array', items: schemaRef('HealthConnectorDto') } }, ['connectors']),
  HealthActionResponse: exactObject({ intent: schemaRef('HealthActionIntentDto'), policyDecision: schemaRef('HealthPolicyDecisionDto'), workflow: schemaRef('HealthWorkflowDto') }, ['intent', 'policyDecision', 'workflow']),
  HealthArtifactResponse: exactObject({ artifact: schemaRef('HealthArtifactDto') }, ['artifact']),
  HealthConsentGrantResponse: exactObject({ consent: schemaRef('HealthConsentGrantDto') }, ['consent']),
  HealthConsentRevocationResponse: exactObject({ consent: schemaRef('HealthConsentRevocationDto') }, ['consent']),
  HealthInterventionListResponse: exactObject({ interventions: { type: 'array', maxItems: 200, items: schemaRef('HealthInterventionDto') } }, ['interventions']),
  HealthFeedbackResponse: exactObject({ feedback: schemaRef('HealthFeedbackDto') }, ['feedback']),
  HealthSettingsResponse: exactObject({ settings: schemaRef('HealthSettingsDto') }, ['settings']),
})
const healthJsonBody = (path, method, schema) => {
  openapi.paths[path][method].requestBody = { required: true, content: { 'application/json': { schema } } }
}
healthJsonBody('/api/hermes/health-loop/connectors/{id}/sync', 'post', exactObject({ cursor: { type: 'string', maxLength: 2048 }, requestedAt: healthTimestamp, idempotencyKey: healthId }))
openapi.paths['/api/hermes/health-loop/artifacts'].post.requestBody = { required: true, content: { 'multipart/form-data': { schema: exactObject({ file: { type: 'string', format: 'binary' }, sourceId: healthId, metadata: { type: 'object', additionalProperties: true } }, ['file', 'sourceId']) } } }
healthJsonBody('/api/hermes/health-loop/artifacts/{id}/analyze', 'post', { oneOf: [
  exactObject({ mode: { type: 'string', enum: ['local'] }, manifestDigest: healthDigest, idempotencyKey: healthId, requestedAt: healthTimestamp }, ['mode', 'manifestDigest']),
  exactObject({ mode: { type: 'string', enum: ['remote'] }, manifestDigest: healthDigest, processorId: healthId, consentToken: { type: 'string', pattern: '^[a-f0-9]{64}$', writeOnly: true }, manifest: schemaRef('HealthConsentManifestDto'), idempotencyKey: healthId, requestedAt: healthTimestamp }, ['mode', 'manifestDigest', 'processorId', 'consentToken', 'manifest', 'idempotencyKey']),
] })
healthJsonBody('/api/hermes/health-loop/consents', 'post', exactObject({ manifest: healthManifest, ttlMs: { type: 'integer', minimum: 1, maximum: 900000 } }, ['manifest']))
healthJsonBody('/api/hermes/health-loop/consents/{id}/revoke', 'post', exactObject({}))
healthJsonBody('/api/hermes/health-loop/interventions/{id}/feedback', 'post', exactObject({ feedbackId: healthId, outcome: { type: 'string', enum: ['completed', 'partial', 'skipped', 'deferred', 'adverse_feedback', 'unsuitable', 'data_incorrect', 'expired'] }, occurredAt: healthTimestamp }, ['feedbackId', 'outcome', 'occurredAt']))
healthJsonBody('/api/hermes/health-loop/settings', 'put', exactObject({ expectedVersion: { type: 'integer', minimum: 1 }, liveDeliveryEnabled: { type: 'boolean' }, recipient: { type: 'string', enum: ['configured-self'] }, configuredConnectors: { type: 'array', maxItems: 32, items: healthId }, configuredProcessors: { type: 'array', maxItems: 32, items: healthId } }, ['expectedVersion', 'liveDeliveryEnabled', 'recipient']))
for (const [path, method, status] of [
  ['/api/hermes/health-loop/connectors/{id}/sync', 'post', '202'],
  ['/api/hermes/health-loop/artifacts/{id}/analyze', 'post', '202'],
  ['/api/hermes/health-loop/artifacts', 'post', '201'],
  ['/api/hermes/health-loop/consents', 'post', '201'],
]) {
  const responses = openapi.paths[path][method].responses
  responses[status] = responses['200']
  delete responses['200']
}

// Home exposes only normalized Twin records and governed semantic commands. Provider service names,
// credentials, and arbitrary service payloads are intentionally absent from these schemas.
const homeId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' }
const homeExternalId = { type: 'string', pattern: '^[a-z0-9_]{1,64}\\.[a-z0-9_]{1,190}$' }
const homeTimestamp = { type: 'string', format: 'date-time', maxLength: 64 }
const homeJson = { type: 'object', additionalProperties: true }
const homeLegacyProfile = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' }
const homeLegacyId = { type: 'string', minLength: 1, maxLength: 160 }
const homeNullableNumber = { type: 'number', nullable: true }
const homeLegacyRoom = exactObject({ id: homeLegacyId, name: { type: 'string', maxLength: 200 }, floorName: { type: 'string', maxLength: 100 },
  x: homeNullableNumber, y: homeNullableNumber, w: homeNullableNumber, h: homeNullableNumber,
  color: { type: 'string', maxLength: 40 }, createdAt: homeTimestamp, updatedAt: homeTimestamp },
['id', 'name', 'floorName', 'x', 'y', 'w', 'h', 'color', 'createdAt', 'updatedAt'])
const homeLegacyFurniture = exactObject({ id: homeLegacyId, roomId: homeLegacyId, name: { type: 'string', maxLength: 200 },
  furnitureType: { type: 'string', maxLength: 100 }, x: homeNullableNumber, y: homeNullableNumber,
  w: homeNullableNumber, h: homeNullableNumber, createdAt: homeTimestamp, updatedAt: homeTimestamp },
['id', 'roomId', 'name', 'furnitureType', 'x', 'y', 'w', 'h', 'createdAt', 'updatedAt'])
const homeLegacyCompartment = exactObject({ id: homeLegacyId, furnitureId: homeLegacyId, name: { type: 'string', maxLength: 200 },
  createdAt: homeTimestamp, updatedAt: homeTimestamp }, ['id', 'furnitureId', 'name', 'createdAt', 'updatedAt'])
const homeLegacyInventory = exactObject({ id: homeLegacyId, name: { type: 'string', maxLength: 200 }, quantity: { type: 'number', minimum: 0 },
  unit: { type: 'string', maxLength: 40 }, expiryDate: { type: 'string', nullable: true, maxLength: 80 },
  notes: { type: 'string', maxLength: 2000 }, createdAt: homeTimestamp, updatedAt: homeTimestamp },
['id', 'name', 'quantity', 'unit', 'expiryDate', 'notes', 'createdAt', 'updatedAt'])
const homeLegacyPlacement = exactObject({ id: homeLegacyId,
  targetType: { type: 'string', pattern: '^(object|inventory_batch|asset|device)$', maxLength: 15 },
  targetId: homeLegacyId, roomId: { ...homeLegacyId, nullable: true }, furnitureId: { ...homeLegacyId, nullable: true },
  compartmentId: { ...homeLegacyId, nullable: true }, x: homeNullableNumber, y: homeNullableNumber, z: homeNullableNumber,
  createdAt: homeTimestamp, updatedAt: homeTimestamp },
['id', 'targetType', 'targetId', 'roomId', 'furnitureId', 'compartmentId', 'x', 'y', 'z', 'createdAt', 'updatedAt'])
const homeLegacyDevice = exactObject({ id: homeLegacyId, externalId: { type: 'string', minLength: 1, maxLength: 255 }, provider: { type: 'string', maxLength: 80 },
  name: { type: 'string', maxLength: 200 }, roomId: { ...homeLegacyId, nullable: true },
  capabilities: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 100 } }, state: homeJson,
  createdAt: homeTimestamp, updatedAt: homeTimestamp },
['id', 'externalId', 'provider', 'name', 'roomId', 'capabilities', 'state', 'createdAt', 'updatedAt'])
const homeLegacyOverviewProperties = { generatedAt: homeTimestamp, profile: homeLegacyProfile,
  rooms: { type: 'array', maxItems: 200, items: homeLegacyRoom },
  furniture: { type: 'array', maxItems: 200, items: homeLegacyFurniture },
  compartments: { type: 'array', maxItems: 200, items: homeLegacyCompartment },
  placements: { type: 'array', maxItems: 200, items: homeLegacyPlacement },
  devices: { type: 'array', maxItems: 200, items: homeLegacyDevice } }
const homeLegacyOverviewRequired = ['generatedAt', 'profile', 'rooms', 'furniture', 'compartments', 'placements', 'devices']
const homeAvailableActions = exactObject({ approve: { type: 'boolean' }, reject: { type: 'boolean' },
  cancel: { type: 'boolean' }, retry: { type: 'boolean' }, compensate: { type: 'boolean' } },
['approve', 'reject', 'cancel', 'retry', 'compensate'])
const homeWorkflowStates = ['draft', 'policy_check', 'preparing', 'executing', 'verifying', 'waiting_user',
  'retrying', 'compensating', 'succeeded', 'denied', 'cancelled', 'failed', 'dead_letter', 'compensated']
const homeWorkflowSummaryProperties = { id: homeId, state: { type: 'string', enum: homeWorkflowStates },
  version: { type: 'integer', minimum: 1 }, attempt: { type: 'integer', minimum: 0 },
  lastErrorCode: { type: 'string', nullable: true, maxLength: 160 }, availableActions: homeAvailableActions,
  createdAt: homeTimestamp, updatedAt: homeTimestamp, completedAt: { ...homeTimestamp, nullable: true } }
const homeWorkflowSummaryRequired = ['id', 'state', 'version', 'attempt', 'lastErrorCode', 'availableActions',
  'createdAt', 'updatedAt', 'completedAt']
Object.assign(openapi.components.schemas, {
  HomeApiError: exactObject({ error: { type: 'string' }, code: { type: 'string', pattern: '^HOME_[A-Z0-9_]+$' } }, ['error', 'code']),
  HomeProviderDto: exactObject({ provider: { type: 'string', enum: ['home-assistant'] }, profile: { type: 'string', maxLength: 100 },
    active: { type: 'boolean' }, configured: { type: 'boolean' },
    connectionStatus: { type: 'string', enum: ['stopped', 'unconfigured', 'disconnected', 'connecting', 'connected', 'degraded'] },
    executorEnabled: { type: 'boolean' }, authorizedTargetCount: { type: 'integer', minimum: 0, maximum: 64 },
    lastErrorCode: { type: 'string', nullable: true, pattern: '^HOME_[A-Z0-9_]+$' } },
  ['provider', 'profile', 'active', 'configured', 'connectionStatus', 'executorEnabled', 'authorizedTargetCount', 'lastErrorCode']),
  HomeOverviewSummaryDto: exactObject({ spaceCount: { type: 'integer', minimum: 0 }, deviceCount: { type: 'integer', minimum: 0 },
    unavailableDeviceCount: { type: 'integer', minimum: 0 }, inventoryItemCount: { type: 'integer', minimum: 0 },
    lowStockItemCount: { type: 'integer', minimum: 0 }, activeWorkflowCount: { type: 'integer', minimum: 0 } },
  ['spaceCount', 'deviceCount', 'unavailableDeviceCount', 'inventoryItemCount', 'lowStockItemCount', 'activeWorkflowCount']),
  HomeSpaceDto: exactObject({ id: homeId, kind: { type: 'string', enum: ['home', 'floor', 'room', 'zone', 'furniture', 'compartment', 'surface'] },
    name: { type: 'string', minLength: 1, maxLength: 200 }, parentSpaceId: { ...homeId, nullable: true }, attributes: homeJson,
    version: { type: 'integer', minimum: 1 }, createdAt: homeTimestamp, updatedAt: homeTimestamp },
  ['id', 'kind', 'name', 'parentSpaceId', 'attributes', 'version', 'createdAt', 'updatedAt']),
  HomeInventoryItemDto: exactObject({ id: homeId, name: { type: 'string', minLength: 1, maxLength: 200 },
    unit: { type: 'string', minLength: 1, maxLength: 40 }, quantity: { type: 'number', minimum: 0 },
    lowStockThreshold: { type: 'number', minimum: 0, nullable: true }, attributes: homeJson,
    version: { type: 'integer', minimum: 1 }, createdAt: homeTimestamp, updatedAt: homeTimestamp },
  ['id', 'name', 'unit', 'quantity', 'lowStockThreshold', 'attributes', 'version', 'createdAt', 'updatedAt']),
  HomeInventoryLedgerDto: exactObject({ id: homeId, itemId: homeId, delta: { type: 'number', not: { enum: [0] } },
    resultingQuantity: { type: 'number', minimum: 0 }, reason: { type: 'string', minLength: 1, maxLength: 200 },
    source: { type: 'string', enum: ['home-api'] }, sourceId: homeId, createdAt: homeTimestamp },
  ['id', 'itemId', 'delta', 'resultingQuantity', 'reason', 'source', 'sourceId', 'createdAt']),
  HomeBindingDto: exactObject({ id: homeId, deviceId: homeId, provider: { type: 'string', enum: ['home-assistant'] },
    externalId: homeExternalId, capabilities: { type: 'array', uniqueItems: true, maxItems: 64, items: homeId },
    version: { type: 'integer', minimum: 1 }, createdAt: homeTimestamp, updatedAt: homeTimestamp },
  ['id', 'deviceId', 'provider', 'externalId', 'capabilities', 'version', 'createdAt', 'updatedAt']),
  HomeDeviceStateDto: exactObject({ deviceId: homeId, key: homeId, value: {}, sourceEventId: homeId,
    observedAt: homeTimestamp, receivedAt: homeTimestamp, version: { type: 'integer', minimum: 1 } },
  ['deviceId', 'key', 'value', 'sourceEventId', 'observedAt', 'receivedAt', 'version']),
  HomeDeviceDto: exactObject({ id: homeId, name: { type: 'string', minLength: 1, maxLength: 200 },
    deviceClass: homeId, spaceId: { ...homeId, nullable: true }, availability: { type: 'string', enum: ['available', 'unavailable', 'unknown'] },
    attributes: homeJson, version: { type: 'integer', minimum: 1 }, createdAt: homeTimestamp, updatedAt: homeTimestamp,
    bindings: { type: 'array', maxItems: 50, items: schemaRef('HomeBindingDto') },
    states: { type: 'array', maxItems: 100, items: schemaRef('HomeDeviceStateDto') } },
  ['id', 'name', 'deviceClass', 'spaceId', 'availability', 'attributes', 'version', 'createdAt', 'updatedAt', 'bindings', 'states']),
  HomePolicyDecisionDto: exactObject({ id: homeId, outcome: { type: 'string', enum: ['allow', 'deny', 'waiting_user'] },
    reasonCodes: { type: 'array', maxItems: 64, items: homeId } }, ['id', 'outcome', 'reasonCodes']),
  HomeWorkflowSummaryDto: exactObject(homeWorkflowSummaryProperties, homeWorkflowSummaryRequired),
  HomeWorkflowStepDto: exactObject({ kind: homeId, state: { type: 'string' }, attempt: { type: 'integer', minimum: 0 },
    lastErrorCode: { type: 'string', nullable: true, maxLength: 160 }, output: { type: 'object', nullable: true }, updatedAt: homeTimestamp },
  ['kind', 'state', 'attempt', 'lastErrorCode', 'output', 'updatedAt']),
  HomeWorkflowDetailDto: exactObject({ ...homeWorkflowSummaryProperties,
    capabilityId: homeId, policyDecision: { ...schemaRef('HomePolicyDecisionDto'), nullable: true },
    steps: { type: 'array', maxItems: 16, items: schemaRef('HomeWorkflowStepDto') } },
  [...homeWorkflowSummaryRequired, 'capabilityId', 'policyDecision', 'steps']),
  HomeLegacyOverviewDto: exactObject({ ...homeLegacyOverviewProperties,
    inventory: { type: 'array', maxItems: 200, items: homeLegacyInventory } }, [...homeLegacyOverviewRequired, 'inventory']),
  HomeLegacyMapDto: exactObject(homeLegacyOverviewProperties, homeLegacyOverviewRequired),
  HomeMigrationCountsDto: exactObject(Object.fromEntries(['profiles', 'layouts', 'spaces', 'objects', 'inventory',
    'ledger', 'devices', 'bindings', 'stateEvents', 'placements', 'skipped'].map(key => [key, { type: 'integer', minimum: 0 }])),
  ['profiles', 'layouts', 'spaces', 'objects', 'inventory', 'ledger', 'devices', 'bindings', 'stateEvents', 'placements', 'skipped']),
  HomeLegacyImportDto: exactObject({ runId: homeId, status: { type: 'string', enum: ['completed'] },
    fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }, version: { type: 'string', pattern: '^home-migration-v[0-9]+$' },
    profiles: { type: 'array', maxItems: 50, uniqueItems: true, items: homeLegacyProfile }, counts: schemaRef('HomeMigrationCountsDto'),
    startedAt: homeTimestamp, completedAt: homeTimestamp },
  ['runId', 'status', 'fingerprint', 'version', 'profiles', 'counts', 'startedAt', 'completedAt']),
  HomeOverviewResponse: exactObject({ provider: schemaRef('HomeProviderDto'), summary: schemaRef('HomeOverviewSummaryDto'),
    overview: schemaRef('HomeLegacyOverviewDto') }, ['provider', 'summary', 'overview']),
  HomeLegacyMapResponse: exactObject({ map: schemaRef('HomeLegacyMapDto') }, ['map']),
  HomeLegacyLayoutResponse: exactObject({ layout: homeJson }, ['layout']),
  HomeLegacyImportResponse: exactObject({ import: schemaRef('HomeLegacyImportDto') }, ['import']),
  HomeProviderResponse: exactObject({ provider: schemaRef('HomeProviderDto') }, ['provider']),
  HomeSpaceListResponse: exactObject({ spaces: { type: 'array', maxItems: 200, items: schemaRef('HomeSpaceDto') } }, ['spaces']),
  HomeSpaceResponse: exactObject({ space: schemaRef('HomeSpaceDto') }, ['space']),
  HomeInventoryListResponse: exactObject({ items: { type: 'array', maxItems: 200, items: schemaRef('HomeInventoryItemDto') },
    inventory: { type: 'array', maxItems: 200, items: homeLegacyInventory } }, ['items', 'inventory']),
  HomeInventoryResponse: exactObject({ item: schemaRef('HomeInventoryItemDto') }, ['item']),
  HomeInventoryAdjustmentResponse: exactObject({ disposition: { type: 'string', enum: ['applied', 'duplicate'] },
    item: schemaRef('HomeInventoryItemDto'), entry: schemaRef('HomeInventoryLedgerDto') }, ['disposition', 'item', 'entry']),
  HomeDeviceListResponse: exactObject({ devices: { type: 'array', maxItems: 200, items: schemaRef('HomeDeviceDto') } }, ['devices']),
  HomeBindingListResponse: exactObject({ bindings: { type: 'array', maxItems: 200, items: schemaRef('HomeBindingDto') } }, ['bindings']),
  HomeActionResponse: exactObject({ intent: schemaRef('HealthActionIntentDto'), policyDecision: schemaRef('HomePolicyDecisionDto'),
    workflow: schemaRef('HomeWorkflowSummaryDto') }, ['intent', 'policyDecision', 'workflow']),
  HomeWorkflowResponse: exactObject({ workflow: schemaRef('HomeWorkflowDetailDto') }, ['workflow']),
})
const homeJsonBody = (path, method, schema) => {
  openapi.paths[path][method].requestBody = { required: true, content: { 'application/json': { schema } } }
}
homeJsonBody('/api/hermes/home/spaces', 'post', exactObject({ id: homeId,
  kind: { type: 'string', enum: ['home', 'floor', 'room', 'zone', 'furniture', 'compartment', 'surface'] },
  name: { type: 'string', minLength: 1, maxLength: 200 }, parentSpaceId: { ...homeId, nullable: true },
  attributes: homeJson, expectedVersion: { type: 'integer', minimum: 0 } }, ['id', 'kind', 'name', 'expectedVersion']))
homeJsonBody('/api/hermes/home/inventory/{id}', 'put', exactObject({ name: { type: 'string', minLength: 1, maxLength: 200 },
  unit: { type: 'string', minLength: 1, maxLength: 40 }, initialQuantity: { type: 'number', minimum: 0 },
  lowStockThreshold: { type: 'number', minimum: 0, nullable: true }, attributes: homeJson,
  expectedVersion: { type: 'integer', minimum: 0 } }, ['name', 'unit', 'expectedVersion']))
homeJsonBody('/api/hermes/home/inventory/{id}/adjust', 'post', exactObject({ delta: { type: 'number', not: { enum: [0] } },
  reason: { type: 'string', minLength: 1, maxLength: 200 }, occurredAt: homeTimestamp, idempotencyKey: homeId },
['delta', 'reason', 'occurredAt', 'idempotencyKey']))
homeJsonBody('/api/hermes/home/imports/legacy', 'post', exactObject({
  profiles: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: homeLegacyProfile },
}))
homeJsonBody('/api/hermes/home/devices/{id}/refresh', 'post', exactObject({ bindingId: homeId, externalId: homeExternalId,
  requestedAt: homeTimestamp, idempotencyKey: homeId }, ['bindingId', 'externalId', 'requestedAt', 'idempotencyKey']))
const commandBaseProperties = { bindingId: homeId, externalId: homeExternalId,
  expectedStateVersion: { type: 'integer', minimum: 0 }, verificationTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
  idempotencyKey: homeId }
const commandRequired = ['command', 'bindingId', 'externalId', 'expectedStateVersion', 'verificationTimeoutMs', 'idempotencyKey']
homeJsonBody('/api/hermes/home/devices/{id}/commands', 'post', { oneOf: [
  exactObject({ command: { type: 'string', enum: ['set_power'] }, ...commandBaseProperties, desiredPower: { type: 'boolean' } },
    [...commandRequired, 'desiredPower']),
  exactObject({ command: { type: 'string', enum: ['set_level'] }, ...commandBaseProperties,
    desiredLevel: { type: 'number', minimum: 0, maximum: 100 } }, [...commandRequired, 'desiredLevel']),
  exactObject({ command: { type: 'string', enum: ['set_temperature'] }, ...commandBaseProperties,
    desiredTemperatureC: { type: 'number', minimum: 5, maximum: 35 } }, [...commandRequired, 'desiredTemperatureC']),
] })
homeJsonBody('/api/hermes/home/scenes/{id}/activate', 'post', exactObject({ bindingId: homeId, externalId: homeExternalId,
  verificationTimeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }, idempotencyKey: homeId },
['bindingId', 'externalId', 'verificationTimeoutMs', 'idempotencyKey']))
homeJsonBody('/api/hermes/home/workflows/{id}/review', 'post', { oneOf: [
  exactObject({ action: { type: 'string', enum: ['approve'] } }, ['action']),
  exactObject({ action: { type: 'string', enum: ['reject'] }, reason: { type: 'string', minLength: 1, maxLength: 2000 } }, ['action', 'reason']),
] })
for (const [path, method, status] of [
  ['/api/hermes/home/spaces', 'post', '201'],
  ['/api/hermes/home/inventory/{id}', 'put', '201'],
  ['/api/hermes/home/inventory/{id}/adjust', 'post', '201'],
  ['/api/hermes/home/devices/{id}/refresh', 'post', '202'],
  ['/api/hermes/home/devices/{id}/commands', 'post', '202'],
  ['/api/hermes/home/scenes/{id}/activate', 'post', '202'],
]) {
  const responses = openapi.paths[path][method].responses
  responses[status] = responses['200']
  delete responses['200']
}

// Internet Execution accepts only provider-independent semantic read intents. Profile, provider,
// target, executor bindings, MCP tools, browser primitives, and URLs are all server-owned.
const internetId = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' }
const internetTimestamp = { type: 'string', format: 'date-time', maxLength: 64 }
const internetDigest = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const internetProfile = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^/\\\\\\u0000-\\u001f\\u007f]+$' }
const internetBvid = { type: 'string', pattern: '^BV[0-9A-Za-z]{10}$', minLength: 12, maxLength: 12 }
const internetNullableInteger = { type: 'integer', minimum: 0, nullable: true }
const internetVideo = exactObject({
  bvid: internetBvid,
  title: { type: 'string', minLength: 1, maxLength: 200 },
  author: { type: 'string', minLength: 1, maxLength: 120 },
  publishedAt: { ...internetTimestamp, nullable: true },
  durationSeconds: { type: 'integer', minimum: 0, maximum: 86400, nullable: true },
  viewCount: internetNullableInteger,
  canonicalUrl: { type: 'string', pattern: '^https://www\\.bilibili\\.com/video/BV[0-9A-Za-z]{10}/?$', maxLength: 44 },
}, ['bvid', 'title', 'author', 'publishedAt', 'durationSeconds', 'viewCount', 'canonicalUrl'])
const internetSearchInput = exactObject({
  query: { type: 'string', minLength: 1, maxLength: 120 },
  limit: { type: 'integer', minimum: 1, maximum: 20 },
  page: { type: 'integer', minimum: 1, maximum: 10 },
  order: { type: 'string', enum: ['relevance', 'newest', 'most_viewed'] },
}, ['query', 'limit', 'page', 'order'])
const internetInspectInput = exactObject({ bvid: internetBvid }, ['bvid'])
const internetSearchResult = exactObject({
  schemaVersion: { type: 'integer', enum: [1] },
  provider: { type: 'string', enum: ['bilibili'] },
  profile: internetProfile,
  operation: { type: 'string', enum: ['search'] },
  query: { type: 'string', minLength: 1, maxLength: 120 },
  status: { type: 'string', enum: ['succeeded', 'partial'] },
  videos: { type: 'array', maxItems: 20, items: internetVideo },
  totalCount: { type: 'integer', minimum: 0 },
  omittedCount: { type: 'integer', minimum: 0 },
}, ['schemaVersion', 'provider', 'profile', 'operation', 'query', 'status', 'videos', 'totalCount', 'omittedCount'])
const internetInspectResult = exactObject({
  schemaVersion: { type: 'integer', enum: [1] },
  provider: { type: 'string', enum: ['bilibili'] },
  profile: internetProfile,
  operation: { type: 'string', enum: ['inspect'] },
  status: { type: 'string', enum: ['succeeded'] },
  video: internetVideo,
  description: { type: 'string', maxLength: 2000 },
  tags: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 80 } },
}, ['schemaVersion', 'provider', 'profile', 'operation', 'status', 'video', 'description', 'tags'])
const internetReceiptStatuses = ['prepared', 'executing', 'executed', 'verifying', 'verified', 'unknown',
  'mismatch', 'failed', 'waiting_user']
Object.assign(openapi.components.schemas, {
  InternetApiError: exactObject({ error: { type: 'string' },
    code: { type: 'string', pattern: '^INTERNET_[A-Z0-9_]+$' } }, ['error', 'code']),
  InternetProviderDto: exactObject({
    provider: { type: 'string', enum: ['bilibili'] },
    profile: internetProfile,
    active: { type: 'boolean' },
    configured: { type: 'boolean' },
    discoveryStatus: { type: 'string', enum: ['stopped', 'unavailable', 'degraded', 'healthy'] },
    executorEnabled: { type: 'boolean' },
    selectedExecutorType: { type: 'string', enum: ['mcp', 'browser'], nullable: true },
    authorizedTargetCount: { type: 'integer', minimum: 0, maximum: 64 },
    lastErrorCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,127}$', nullable: true },
  }, ['provider', 'profile', 'active', 'configured', 'discoveryStatus', 'executorEnabled',
    'selectedExecutorType', 'authorizedTargetCount', 'lastErrorCode']),
  InternetExecutorDto: exactObject({
    type: { type: 'string', enum: ['mcp', 'browser'] },
    environment: { type: 'string', enum: ['production'] },
    enabled: { type: 'boolean' },
    health: { type: 'string', enum: ['unknown', 'healthy', 'degraded', 'unhealthy'] },
    selected: { type: 'boolean' },
  }, ['type', 'environment', 'enabled', 'health', 'selected']),
  InternetCapabilityDto: exactObject({
    id: { type: 'string', enum: ['bilibili.video.search', 'bilibili.video.inspect'] },
    provider: { type: 'string', enum: ['bilibili'] },
    available: { type: 'boolean' },
  }, ['id', 'provider', 'available']),
  InternetOverviewSummaryDto: exactObject({
    receiptCount: { type: 'integer', minimum: 0, maximum: 200 },
    verifiedReceiptCount: { type: 'integer', minimum: 0, maximum: 200 },
    waitingUserReceiptCount: { type: 'integer', minimum: 0, maximum: 200 },
    activeWorkflowCount: { type: 'integer', minimum: 0, maximum: 200 },
  }, ['receiptCount', 'verifiedReceiptCount', 'waitingUserReceiptCount', 'activeWorkflowCount']),
  InternetWorkflowSummaryDto: exactObject(homeWorkflowSummaryProperties, homeWorkflowSummaryRequired),
  InternetWorkflowStepDto: exactObject({
    kind: internetId,
    state: { type: 'string', maxLength: 80 },
    attempt: { type: 'integer', minimum: 0 },
    lastErrorCode: { type: 'string', nullable: true, maxLength: 160 },
    updatedAt: internetTimestamp,
  }, ['kind', 'state', 'attempt', 'lastErrorCode', 'updatedAt']),
  InternetWorkflowDetailDto: exactObject({ ...homeWorkflowSummaryProperties,
    capabilityId: { type: 'string', enum: ['bilibili.video.search', 'bilibili.video.inspect'] },
    policyDecision: { ...schemaRef('HomePolicyDecisionDto'), nullable: true },
    steps: { type: 'array', maxItems: 16, items: schemaRef('InternetWorkflowStepDto') },
  }, [...homeWorkflowSummaryRequired, 'capabilityId', 'policyDecision', 'steps']),
  InternetSemanticInputDto: { oneOf: [internetSearchInput, internetInspectInput] },
  InternetVideoDto: internetVideo,
  InternetSearchResultDto: internetSearchResult,
  InternetInspectResultDto: internetInspectResult,
  InternetResultDto: { oneOf: [schemaRef('InternetSearchResultDto'), schemaRef('InternetInspectResultDto')], nullable: true },
  InternetReceiptDto: exactObject({
    workflowId: internetId,
    intentId: internetId,
    capabilityId: { type: 'string', enum: ['bilibili.video.search', 'bilibili.video.inspect'] },
    provider: { type: 'string', enum: ['bilibili'] },
    profile: internetProfile,
    executorType: { type: 'string', enum: ['mcp', 'browser'] },
    environment: { type: 'string', enum: ['sandbox', 'production'] },
    operation: { type: 'string', enum: ['search', 'inspect'] },
    input: schemaRef('InternetSemanticInputDto'),
    safeToReplay: { type: 'boolean' },
    status: { type: 'string', enum: internetReceiptStatuses },
    result: schemaRef('InternetResultDto'),
    resultDigest: { ...internetDigest, nullable: true },
    errorCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,127}$', nullable: true },
    version: { type: 'integer', minimum: 1 },
    createdAt: internetTimestamp,
    updatedAt: internetTimestamp,
    completedAt: { ...internetTimestamp, nullable: true },
  }, ['workflowId', 'intentId', 'capabilityId', 'provider', 'profile', 'executorType', 'environment',
    'operation', 'input', 'safeToReplay', 'status', 'result', 'resultDigest', 'errorCode', 'version',
    'createdAt', 'updatedAt', 'completedAt']),
  InternetEvidenceDto: exactObject({
    ordinal: { type: 'integer', minimum: 0 },
    stage: { type: 'string', enum: ['provider_read', 'navigation', 'snapshot', 'verification'] },
    evidenceDigest: { ...internetDigest, nullable: true },
    observedAt: internetTimestamp,
  }, ['ordinal', 'stage', 'evidenceDigest', 'observedAt']),
  InternetOverviewResponse: exactObject({
    provider: schemaRef('InternetProviderDto'),
    executors: { type: 'array', minItems: 2, maxItems: 2, items: schemaRef('InternetExecutorDto') },
    capabilities: { type: 'array', minItems: 2, maxItems: 2, items: schemaRef('InternetCapabilityDto') },
    summary: schemaRef('InternetOverviewSummaryDto'),
  }, ['provider', 'executors', 'capabilities', 'summary']),
  InternetActionResponse: exactObject({
    intent: schemaRef('HealthActionIntentDto'),
    policyDecision: schemaRef('HomePolicyDecisionDto'),
    workflow: schemaRef('InternetWorkflowSummaryDto'),
  }, ['intent', 'policyDecision', 'workflow']),
  InternetReceiptListResponse: exactObject({
    receipts: { type: 'array', maxItems: 200, items: schemaRef('InternetReceiptDto') },
  }, ['receipts']),
  InternetReceiptResponse: exactObject({
    receipt: schemaRef('InternetReceiptDto'),
    evidence: { type: 'array', maxItems: 1000, items: schemaRef('InternetEvidenceDto') },
  }, ['receipt', 'evidence']),
  InternetWorkflowResponse: exactObject({ workflow: schemaRef('InternetWorkflowDetailDto') }, ['workflow']),
})
const internetJsonBody = (path, schema) => {
  openapi.paths[path].post.requestBody = { required: true, content: { 'application/json': { schema } } }
}
internetJsonBody('/api/hermes/internet-execution/bilibili/search', exactObject({
  query: { type: 'string', minLength: 1, maxLength: 120 },
  limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
  page: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
  order: { type: 'string', enum: ['relevance', 'newest', 'most_viewed'], default: 'relevance' },
  idempotencyKey: internetId,
}, ['query', 'idempotencyKey']))
internetJsonBody('/api/hermes/internet-execution/bilibili/inspect', exactObject({
  bvid: internetBvid,
  idempotencyKey: internetId,
}, ['bvid', 'idempotencyKey']))
openapi.paths['/api/hermes/internet-execution/receipts'].get.parameters = [
  { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: internetReceiptStatuses } },
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
]
for (const path of [
  '/api/hermes/internet-execution/bilibili/search',
  '/api/hermes/internet-execution/bilibili/inspect',
]) {
  const responses = openapi.paths[path].post.responses
  responses['202'] = responses['200']
  delete responses['200']
}

// Write output
const outputPath = join(rootDir, 'docs/openapi.json')
writeFileSync(outputPath, JSON.stringify(openapi, null, 2))

console.log(`✓ Generated OpenAPI spec: ${outputPath}`)
console.log(`  ${Object.keys(openapi.paths).length} endpoints`)
console.log(`  ${openapi.tags.length} tags`)
