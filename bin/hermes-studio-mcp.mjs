#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORT = process.env.HERMES_WEB_UI_PORT || process.env.PORT || '8648'
const DEFAULT_BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}`
const DISPLAY_COMMAND = 'hermes-studio-mcp'
const SERVER_NAME = process.env.HERMES_MCP_SERVER_NAME || DISPLAY_COMMAND
const TOOLSETS = new Set(['api', 'devices', 'use'])
const ALLOWED_PUBLIC_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'x-request-id',
])

const __dirname = dirname(fileURLToPath(import.meta.url))

function readPackageVersion() {
  const candidates = [
    resolve(__dirname, '../package.json'),
    resolve(__dirname, '../../package.json'),
    resolve(process.cwd(), 'package.json'),
  ]
  for (const packagePath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (typeof pkg.version === 'string' && pkg.version.trim()) return pkg.version.trim()
    } catch {
      // Try the next candidate path.
    }
  }
  return '0.0.0'
}

const VERSION = readPackageVersion()

function printHelp() {
  process.stdout.write(`${DISPLAY_COMMAND} v${VERSION}

Hermes Studio MCP stdio server.

Usage:
  ${DISPLAY_COMMAND} [api|devices|use]
  ${DISPLAY_COMMAND} --help
  ${DISPLAY_COMMAND} --version

Environment:
  HERMES_WEB_UI_URL       Web UI base URL. Default: ${DEFAULT_BASE_URL}
  HERMES_WEB_UI_HOME      Web UI state directory. Default: ~/.hermes-web-ui
  HERMES_WEBUI_STATE_DIR  Fallback Web UI state directory.
  HERMES_WEB_UI_PROFILE   Default Hermes profile when a tool call omits profile.
  HERMES_WEB_UI_TOKEN     Optional explicit API token.
  AUTH_TOKEN              Optional explicit API token fallback.
  HERMES_MCP_TOOLSET      Tool category to expose: api, devices, or use. Default: api.

When run without options, this process waits for MCP JSON-RPC messages on stdin.
`)
}

const positionalArgs = process.argv.slice(2).filter(arg => !arg.startsWith('-'))
const requestedToolset = String(positionalArgs[0] || process.env.HERMES_MCP_TOOLSET || 'api').trim().toLowerCase()
const ACTIVE_TOOLSET = TOOLSETS.has(requestedToolset) ? requestedToolset : 'api'

if (process.argv.includes('-h') || process.argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

if (process.argv.includes('-v') || process.argv.includes('--version')) {
  process.stdout.write(`${SERVER_NAME} v${VERSION}\n`)
  process.exit(0)
}

function appHome() {
  return process.env.HERMES_WEB_UI_HOME ||
    process.env.HERMES_WEBUI_STATE_DIR ||
    join(homedir(), '.hermes-web-ui')
}

function normalizeProfileSegment(profile) {
  const raw = String(profile || '').trim()
  if (!raw) return ''
  const sanitized = raw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  if (sanitized === '.' || sanitized === '..' || sanitized.length > 128) return ''
  return sanitized
}

function readProfileToken(profile) {
  const segment = normalizeProfileSegment(profile)
  if (!segment) return ''
  try {
    return readFileSync(join(appHome(), 'profiles', segment, '.model-run-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function readToken(tokenOverride, allowTokenFile = true, profile = '') {
  const explicit = tokenOverride || process.env.HERMES_WEB_UI_TOKEN || process.env.AUTH_TOKEN
  if (explicit) return explicit.trim()
  if (!allowTokenFile) return ''
  const profileToken = readProfileToken(profile)
  if (profileToken) return profileToken
  try {
    return readFileSync(join(appHome(), '.token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function defaultProfile() {
  return String(
    process.env.HERMES_WEB_UI_PROFILE ||
    process.env.HERMES_PROFILE ||
    process.env.PROFILE ||
    '',
  ).trim()
}

function authHint() {
  return `Web UI token was not accepted. Pass the current Hermes profile argument so this MCP server can read its temporary token, pass an explicit token argument, or set HERMES_WEB_UI_TOKEN.`
}

function baseUrl() {
  return (process.env.HERMES_WEB_UI_URL || DEFAULT_BASE_URL).replace(/\/$/, '')
}

function jsonText(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  }
}

function errorText(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  }
}

async function request(path, options = {}) {
  const envelope = await requestEnvelope(path, options)
  if (envelope.status < 200 || envelope.status >= 300) {
    if (envelope.status === 401) {
      throw new Error(`${envelope.body?.error || 'Unauthorized'}. ${authHint()}`)
    }
    throw new Error(envelope.body?.error || envelope.bodyText || `HTTP ${envelope.status}`)
  }
  return envelope.body
}

function appendQuery(path, query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return path
  const parsed = new URL(path, 'http://hermes-web-ui.local')
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) parsed.searchParams.append(key, String(item))
      }
      continue
    }
    parsed.searchParams.set(key, String(value))
  }
  return `${parsed.pathname}${parsed.search}`
}

function normalizePublicHeaders(headers) {
  const normalized = {}
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return normalized
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!ALLOWED_PUBLIC_REQUEST_HEADERS.has(lower) || value == null) continue
    normalized[lower] = Array.isArray(value) ? String(value.find(Boolean) || '') : String(value)
  }
  return normalized
}

async function requestEnvelope(path, options = {}) {
  const profile = typeof options.profile === 'string' && options.profile.trim()
    ? options.profile.trim()
    : defaultProfile()
  const token = readToken(options.token, options.allowTokenFile !== false, profile)
  const method = options.method || 'GET'
  const body = method === 'GET' || method === 'HEAD' ? undefined : options.body
  const headers = {
    ...normalizePublicHeaders(options.headers),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(profile ? { 'X-Hermes-Profile': profile } : {}),
  }
  const response = await fetch(`${baseUrl()}${appendQuery(path, options.query)}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const responseHeaders = {}
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  if (method === 'HEAD' || response.status === 204) {
    return { status: response.status, headers: responseHeaders, body: null }
  }
  const contentType = response.headers.get('content-type') || ''
  const bodyText = await response.text()
  let parsedBody = bodyText
  if (contentType.toLowerCase().includes('application/json')) {
    try {
      parsedBody = bodyText ? JSON.parse(bodyText) : null
    } catch {
      parsedBody = bodyText
    }
  }
  return { status: response.status, headers: responseHeaders, body: parsedBody, bodyText }
}

function normalizeApiMethod(method) {
  const value = String(method || 'GET').trim().toUpperCase()
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(value) ? value : null
}

function normalizeApiPath(path) {
  const raw = String(path || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null
  if (raw === '/v1' || raw.startsWith('/v1/')) return null
  const parsed = new URL(raw, 'http://hermes-web-ui.local')
  const normalized = `${parsed.pathname}${parsed.search}`
  if (parsed.pathname === '/api/openapi.json') return normalized
  if (parsed.pathname === '/health') return normalized
  if (parsed.pathname.startsWith('/api/')) return normalized
  return null
}

let cachedOpenApiDocument = null

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function openApiDocument(options = {}) {
  if (cachedOpenApiDocument) return cachedOpenApiDocument
  cachedOpenApiDocument = await request('/api/openapi.json', options)
  return cachedOpenApiDocument
}

function pathWithoutQuery(path) {
  return new URL(path, 'http://hermes-web-ui.local').pathname
}

function pathTemplateRegex(template) {
  const escaped = String(template).split('/').map(part => {
    if (/^\{[^/{}]+\}$/.test(part)) return '[^/]+'
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('/')
  return new RegExp(`^${escaped}$`)
}

function findOpenApiOperation(openapi, method, path) {
  const paths = isRecord(openapi?.paths) ? openapi.paths : {}
  const pathname = pathWithoutQuery(path)
  const exact = paths[pathname]?.[method.toLowerCase()]
  if (exact) return { operation: exact, pathTemplate: pathname }
  for (const [template, methods] of Object.entries(paths)) {
    if (!pathTemplateRegex(template).test(pathname)) continue
    const operation = isRecord(methods) ? methods[method.toLowerCase()] : null
    if (operation) return { operation, pathTemplate: template }
  }
  return null
}

function queryObjectFromPath(path, query) {
  const parsed = new URL(path, 'http://hermes-web-ui.local')
  const values = {}
  for (const [key, value] of parsed.searchParams.entries()) {
    if (values[key] === undefined) values[key] = value
    else if (Array.isArray(values[key])) values[key].push(value)
    else values[key] = [values[key], value]
  }
  if (isRecord(query)) {
    for (const [key, value] of Object.entries(query)) {
      if (value != null) values[key] = value
    }
  }
  return values
}

function missingValue(value) {
  return value === undefined || value === null || value === ''
}

function validateRequiredObjectFields(schema, value, location) {
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null
  if (!isRecord(value)) return `${location} must be an object with required fields: ${schema.required.join(', ')}`
  for (const field of schema.required) {
    if (missingValue(value[field])) return `missing required field ${location}.${field}`
  }
  return null
}

async function validateApiRequest(method, path, args) {
  if (pathWithoutQuery(path) === '/api/openapi.json' || pathWithoutQuery(path) === '/api/hermes/openapi.json') return null
  const openapi = await openApiDocument(withAuthArgs(args))
  const match = findOpenApiOperation(openapi, method, path)
  if (!match) return `Unknown endpoint in OpenAPI document: ${method} ${pathWithoutQuery(path)}`
  const { operation } = match
  const queryValues = queryObjectFromPath(path, args.query)
  for (const parameter of Array.isArray(operation.parameters) ? operation.parameters : []) {
    if (!parameter?.required) continue
    if (parameter.in === 'query' && missingValue(queryValues[parameter.name])) {
      return `missing required query parameter ${parameter.name}`
    }
    if (parameter.in === 'path') {
      // Path templates are already matched by the request path; no separate path arg exists.
      continue
    }
  }
  const requestBody = operation.requestBody
  if (!requestBody) return null
  const body = args.body
  if (requestBody.required && body === undefined) return `missing required request body for ${method} ${pathWithoutQuery(path)}`
  if (body === undefined) return null
  const schema = requestBody.content?.['application/json']?.schema
  return validateRequiredObjectFields(schema, body, 'body')
}

function schemaType(schema) {
  if (!isRecord(schema)) return undefined
  if (typeof schema.type === 'string') return schema.type
  if (Array.isArray(schema.oneOf)) return `oneOf(${schema.oneOf.map(schemaType).filter(Boolean).join('|')})`
  if (Array.isArray(schema.anyOf)) return `anyOf(${schema.anyOf.map(schemaType).filter(Boolean).join('|')})`
  if (schema.$ref) return String(schema.$ref).split('/').pop()
  return undefined
}

function compactParameters(parameters) {
  const path = []
  const query = []
  for (const parameter of Array.isArray(parameters) ? parameters : []) {
    if (!parameter?.name) continue
    const item = {
      name: parameter.name,
      required: parameter.required === true,
      type: schemaType(parameter.schema) || 'string',
      ...(Array.isArray(parameter.schema?.enum) ? { enum: parameter.schema.enum } : {}),
    }
    if (parameter.in === 'path') path.push(item)
    if (parameter.in === 'query') query.push(item)
  }
  return { path, query }
}

function compactBodyFields(requestBody) {
  const schema = requestBody?.content?.['application/json']?.schema
  if (!isRecord(schema?.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(schema.properties).map(([name, property]) => {
    return {
      name,
      required: required.has(name),
      type: schemaType(property) || 'unknown',
      ...(Array.isArray(property?.enum) ? { enum: property.enum } : {}),
      ...(property?.description ? { description: String(property.description) } : {}),
    }
  })
}

const moduleHints = {
  'API Docs': {
    purpose: 'Discover the Web UI API catalog and generated OpenAPI metadata.',
    keywords: ['操作手册', '接口文档', 'API 文档', 'openapi', 'route catalog'],
  },
  Auth: {
    purpose: 'Manage Web UI authentication state and tokens.',
    keywords: ['auth', 'login', 'token', 'session'],
  },
  'Chat Run': {
    purpose: 'Start a chat or coding-agent run through the HTTP bridge and wait for the result.',
    keywords: ['chat', 'run', 'execute', 'agent', 'model'],
  },
  'Coding Agents': {
    purpose: 'Install, configure, and run coding agents such as Codex or Claude Code.',
    keywords: ['codex', 'claude', 'coding agent', 'install', 'run'],
  },
  Config: {
    purpose: 'Read and update Hermes Web UI configuration.',
    keywords: ['config', 'settings', 'preferences'],
  },
  Devices: {
    purpose: 'Discover, pair, and operate LAN peer devices, terminals, commands, and file transfer.',
    keywords: ['device', 'lan', 'peer', 'terminal', 'file transfer'],
  },
  Files: {
    purpose: 'Browse and operate files exposed through the Hermes file browser.',
    keywords: ['files', 'browser', 'read', 'list', 'download'],
  },
  'Group Chat': {
    purpose: 'Manage multi-participant group chat rooms and messages.',
    keywords: ['group chat', 'room', 'participants', 'messages'],
  },
  Jobs: {
    purpose: 'Create, inspect, update, and run scheduled or background jobs.',
    keywords: ['jobs', 'schedule', 'cron', 'tasks', 'automation'],
  },
  Kanban: {
    purpose: 'Manage boards, columns, cards, and task workflow state.',
    keywords: ['kanban', 'board', 'task', 'card', 'workflow'],
  },
  MCP: {
    purpose: 'Manage MCP servers, tools, and Web UI MCP integration.',
    keywords: ['mcp', 'tools', 'server', 'integration'],
  },
  Media: {
    purpose: 'Generate or manage media assets.',
    keywords: ['media', 'image', 'generation', 'asset'],
  },
  Memory: {
    purpose: 'Read and manage agent memory files.',
    keywords: ['memory', 'agent memory', 'notes'],
  },
  Models: {
    purpose: 'Inspect and configure model ids available to Hermes.',
    keywords: ['models', 'model id', 'llm'],
  },
  Profiles: {
    purpose: 'Manage Hermes profiles and profile-scoped runtime state.',
    keywords: ['profile', 'workspace', 'account'],
  },
  Providers: {
    purpose: 'Manage model provider configuration and credentials metadata.',
    keywords: ['provider', 'model provider', 'api key', 'base url'],
  },
  Sessions: {
    purpose: 'List, inspect, create, update, and delete user-requested chat sessions. Do not use session operations as an internal delegation mechanism.',
    keywords: ['sessions', 'conversation', 'chat history'],
  },
  Skills: {
    purpose: 'Browse and manage skills available to Hermes agents.',
    keywords: ['skills', 'agent skill', 'capability'],
  },
  Terminal: {
    purpose: 'Open interactive terminal sessions over WebSocket.',
    keywords: ['terminal', 'shell', 'websocket'],
  },
  'Write Gate': {
    purpose: 'Review and approve Hermes Agent write operations.',
    keywords: ['approval', 'write gate', 'review'],
  },
}

function compactOperation(path, method, operation) {
  const parameters = compactParameters(operation.parameters)
  const body = compactBodyFields(operation.requestBody)
  return {
    method: method.toUpperCase(),
    path,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
    ...(Array.isArray(operation.tags) && operation.tags.length ? { tags: operation.tags } : {}),
    ...(operation.summary ? { summary: operation.summary } : {}),
    ...(parameters.path.length ? { pathParams: parameters.path } : {}),
    ...(parameters.query.length ? { queryParams: parameters.query } : {}),
    ...(operation.requestBody ? {
      requestBody: {
        required: operation.requestBody.required === true,
        fields: body,
      },
    } : {}),
  }
}

function collectOpenApiModules(openapi) {
  const descriptions = new Map()
  for (const tag of Array.isArray(openapi?.tags) ? openapi.tags : []) {
    if (typeof tag?.name === 'string') descriptions.set(tag.name, String(tag.description || ''))
  }

  const counts = new Map()
  const paths = isRecord(openapi?.paths) ? openapi.paths : {}
  for (const methods of Object.values(paths)) {
    if (!isRecord(methods)) continue
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue
      const tags = Array.isArray(operation?.tags) && operation.tags.length ? operation.tags : ['Untagged']
      for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1)
    }
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, operationCount]) => ({
      tag,
      operationCount,
      ...(moduleHints[tag]?.purpose ? { purpose: moduleHints[tag].purpose } : {}),
      ...(moduleHints[tag]?.keywords ? { keywords: moduleHints[tag].keywords } : {}),
      ...(descriptions.get(tag) ? { description: descriptions.get(tag) } : {}),
    }))
}

function compactOpenApiDocument(openapi, args = {}) {
  if (args.full === true) return openapi
  const filterPath = typeof args.path === 'string' && args.path.trim() ? pathWithoutQuery(args.path.trim()) : ''
  const filterMethod = typeof args.method === 'string' && args.method.trim()
    ? normalizeApiMethod(args.method)
    : null
  const filterTag = typeof args.tag === 'string' && args.tag.trim() ? args.tag.trim() : ''
  const filters = {
    ...(filterPath ? { path: filterPath } : {}),
    ...(filterMethod ? { method: filterMethod } : {}),
    ...(filterTag ? { tag: filterTag } : {}),
  }
  const hasFilters = Object.keys(filters).length > 0
  const modules = collectOpenApiModules(openapi)
  const operations = []
  const paths = isRecord(openapi?.paths) ? openapi.paths : {}
  for (const [path, methods] of Object.entries(paths)) {
    if (filterPath && path !== filterPath) continue
    if (!isRecord(methods)) continue
    for (const [method, operation] of Object.entries(methods)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue
      if (filterMethod && method !== filterMethod.toLowerCase()) continue
      if (filterTag && !(Array.isArray(operation?.tags) && operation.tags.includes(filterTag))) continue
      operations.push(compactOperation(path, method, operation))
    }
  }

  return {
    title: openapi?.info?.title || 'Hermes Studio API',
    version: openapi?.info?.version || '',
    usage: hasFilters
      ? 'Use the selected operation details to call hermes_studio_api_request with method, path, query, and body. Auth and profile are handled by the MCP server.'
      : 'This catalog is large. First read module purpose and keywords to choose the right module, then call hermes_studio_api_openapi_get again with tag, path, or method filters to fetch endpoint details on demand.',
    moduleCount: modules.length,
    modules,
    ...(Object.keys(filters).length ? { filters } : {}),
    operationCount: operations.length,
    ...(hasFilters ? { operations } : { operationsOmitted: true }),
  }
}

const authArgumentProperties = {
  token: {
    type: 'string',
    description: 'Optional Hermes Web UI bearer token. Usually omit this and pass profile so the MCP server can read the temporary profile token.',
  },
  profile: {
    type: 'string',
    description: 'Hermes profile name for profile-scoped Web UI requests and temporary profile token lookup.',
  },
}

function inputSchema(properties = {}, required = []) {
  return {
    type: 'object',
    properties: { ...authArgumentProperties, ...properties },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function withAuthArgs(args, options = {}) {
  return {
    ...options,
    token: args.token,
    profile: args.profile,
  }
}

function pickDefined(source, keys) {
  const picked = {}
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key]
  }
  return picked
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function cleanSessionContextPayload(payload, args = {}) {
  const turns = boundedInteger(args.turns, 10, 1, 50)
  const messages = Array.isArray(payload?.messages) ? payload.messages : []
  const cleanMessages = messages
    .filter(message => message?.role === 'user' || message?.role === 'assistant')
    .filter(message => !Array.isArray(message?.tool_calls) || message.tool_calls.length === 0)
    .filter(message => !message?.tool_call_id && !message?.tool_name)
    .map(message => pickDefined(message, [
      'id',
      'session_id',
      'role',
      'content',
      'timestamp',
      'reasoning',
      'reasoning_content',
    ]))
    .filter(message => typeof message.content === 'string' ? message.content.trim() : message.content != null)
  const maxMessages = turns * 2
  const returnedMessages = cleanMessages.slice(-maxMessages)
  return {
    ...payload,
    messages: returnedMessages,
    message_count: returnedMessages.length,
    clean_message_count: cleanMessages.length,
    requested_turns: turns,
  }
}

function summarizeWorkerRuntime(payload) {
  const workers = Array.isArray(payload?.bridge?.workers) ? payload.bridge.workers : []
  const summarizedWorkers = workers.map(worker => {
    const sessionCount = Number(worker?.sessionCount || 0)
    const interactingSessionCount = Number(worker?.runningSessionCount || 0)
    return {
      profile: worker?.profile || '',
      pid: worker?.pid || 0,
      running: Boolean(worker?.running),
      session_count: sessionCount,
      interacting_session_count: interactingSessionCount,
      completed_interaction_count: Math.max(0, sessionCount - interactingSessionCount),
      last_used_at: worker?.lastUsedAt || null,
      endpoint: worker?.endpoint || '',
    }
  })
  const interactingWorkers = summarizedWorkers.filter(worker => worker.interacting_session_count > 0)
  const completedWorkers = summarizedWorkers.filter(worker => worker.session_count > 0 && worker.interacting_session_count === 0)
  return {
    timestamp: payload?.timestamp || Date.now(),
    bridge_reachable: Boolean(payload?.bridge?.reachable),
    worker_count: summarizedWorkers.length,
    running_worker_count: summarizedWorkers.filter(worker => worker.running).length,
    session_count: summarizedWorkers.reduce((sum, worker) => sum + worker.session_count, 0),
    interacting_session_count: summarizedWorkers.reduce((sum, worker) => sum + worker.interacting_session_count, 0),
    completed_interaction_count: summarizedWorkers.reduce((sum, worker) => sum + worker.completed_interaction_count, 0),
    interacting_workers: interactingWorkers,
    completed_workers: completedWorkers,
    workers: summarizedWorkers,
  }
}

function availableModelGroups(payload) {
  const groups = Array.isArray(payload?.groups)
    ? payload.groups
    : Array.isArray(payload?.providers)
      ? payload.providers
      : []
  return groups
    .map(group => ({
      provider: String(group?.provider || group?.id || '').trim(),
      label: String(group?.label || group?.name || group?.provider || group?.id || '').trim(),
      models: Array.isArray(group?.models) ? group.models.map(model => String(model || '').trim()).filter(Boolean) : [],
      model_meta: group?.model_meta && typeof group.model_meta === 'object' && !Array.isArray(group.model_meta)
        ? group.model_meta
        : {},
    }))
    .filter(group => group.provider && group.models.length > 0)
}

function findProvidersForModel(payload, model) {
  const target = String(model || '').trim()
  if (!target) return { model: target, found: false, provider: null, providers: [], ambiguous: false }
  const targetLower = target.toLowerCase()
  const matches = []
  for (const group of availableModelGroups(payload)) {
    for (const candidate of group.models) {
      const alias = typeof group.model_meta?.[candidate]?.alias === 'string'
        ? group.model_meta[candidate].alias.trim()
        : ''
      const matchType = candidate === target
        ? 'exact'
        : candidate.toLowerCase() === targetLower
          ? 'case_insensitive'
          : alias && alias === target
            ? 'alias'
            : alias && alias.toLowerCase() === targetLower
              ? 'alias_case_insensitive'
              : ''
      if (!matchType) continue
      matches.push({
        provider: group.provider,
        label: group.label || group.provider,
        model: candidate,
        match: matchType,
        ...(alias ? { alias } : {}),
      })
    }
  }
  const defaultProvider = String(payload?.default_provider || '').trim()
  const defaultModel = String(payload?.default || '').trim()
  const preferred = matches.find(match => match.provider === defaultProvider && match.model === defaultModel) ||
    matches.find(match => match.match === 'exact') ||
    matches[0]
  return {
    model: target,
    found: matches.length > 0,
    provider: preferred?.provider || null,
    providers: matches,
    ambiguous: matches.length > 1,
  }
}

function modelAlias(group, model) {
  const alias = group.model_meta?.[model]?.alias
  return typeof alias === 'string' ? alias.trim() : ''
}

function compactAvailableModelsPayload(payload, args = {}) {
  if (args.include_details === true) return payload

  const query = String(args.query || '').trim()
  const queryLower = query.toLowerCase()
  const limit = boundedInteger(args.limit_per_provider, 20, 1, 100)
  const groups = availableModelGroups(payload)
  const providers = []
  let returnedModelCount = 0
  let matchedModelCount = 0

  for (const group of groups) {
    const providerMatches = queryLower &&
      (`${group.provider} ${group.label}`).toLowerCase().includes(queryLower)
    const matchedModels = queryLower
      ? group.models.filter(model => {
          const alias = modelAlias(group, model)
          return providerMatches ||
            model.toLowerCase().includes(queryLower) ||
            Boolean(alias && alias.toLowerCase().includes(queryLower))
        })
      : group.models
    if (queryLower && matchedModels.length === 0) continue

    const returnedModels = matchedModels.slice(0, limit)
    const aliases = {}
    for (const model of returnedModels) {
      const alias = modelAlias(group, model)
      if (alias) aliases[model] = alias
    }
    matchedModelCount += matchedModels.length
    returnedModelCount += returnedModels.length
    providers.push({
      provider: group.provider,
      label: group.label || group.provider,
      model_count: group.models.length,
      matched_model_count: matchedModels.length,
      returned_model_count: returnedModels.length,
      omitted_model_count: Math.max(0, matchedModels.length - returnedModels.length),
      models: returnedModels,
      ...(Object.keys(aliases).length ? { aliases } : {}),
    })
  }

  const totalModelCount = groups.reduce((sum, group) => sum + group.models.length, 0)
  return {
    default: payload?.default || '',
    default_provider: payload?.default_provider || '',
    provider_count: groups.length,
    model_count: totalModelCount,
    returned_provider_count: providers.length,
    returned_model_count: returnedModelCount,
    matched_model_count: queryLower ? matchedModelCount : totalModelCount,
    limit_per_provider: limit,
    ...(query ? { query } : {}),
    providers,
    note: 'Compact MCP response. Use query to narrow models, limit_per_provider to adjust returned models, or include_details=true to return the raw available-models payload.',
  }
}

const tools = [
  {
    name: 'hermes_studio_api_openapi_get',
    toolset: 'api',
    description: 'Return Hermes Studio API documentation as compact JSON. When the user asks to read/check the operation manual, API docs, endpoint docs, 接口文档, 接口手册, or 操作手册, call this tool without filters first to get the outline/module index. Without filters, returns only module purpose, keywords, and operation counts because the full API catalog is large. For endpoint details, call again with tag, path, or method filters, then use hermes_studio_api_request.',
    inputSchema: inputSchema({
        path: {
          type: 'string',
          description: 'Optional exact endpoint path filter for on-demand details, for example /api/chat-run/runs.',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'Optional HTTP method filter. Usually combine with path or tag.',
        },
        tag: {
          type: 'string',
          description: 'Optional module/tag filter. Recommended flow: call without filters to list modules, then call with one module tag for details.',
        },
        full: {
          type: 'boolean',
          description: 'Return the raw full OpenAPI JSON. Defaults to false; prefer compact JSON output for agent use.',
        },
      }),
  },
  {
    name: 'hermes_studio_api_request',
    toolset: 'api',
    description: 'Execute a Hermes Studio operation by calling an endpoint path. Use hermes_studio_api_openapi_get first as the operation manual to inspect method, parameters, requestBody, and responses. Do not use /api/chat-run/* or /api/hermes/sessions/* as an internal delegation mechanism.',
    inputSchema: inputSchema({
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP method. Defaults to GET.',
        },
        path: {
          type: 'string',
          description: 'Relative Hermes Studio endpoint path from the operation manual, for example /api/hermes/sessions?limit=20. Full URLs and // paths are rejected.',
        },
        body: {
          type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
          description: 'Optional JSON request body for POST/PUT/PATCH/DELETE. GET and HEAD ignore body.',
        },
        query: {
          type: 'object',
          description: 'Optional query parameters merged into path. Values are serialized as strings; arrays append repeated parameters.',
          additionalProperties: true,
        },
        headers: {
          type: 'object',
          description: 'Optional request headers. Allowed names: accept, accept-language, content-type, x-request-id. Authorization and X-Hermes-Profile are filled from token/profile.',
          additionalProperties: {
            type: ['string', 'number', 'boolean', 'array'],
          },
        },
      }, ['path']),
  },
  {
    name: 'hermes_studio_use_chat_run',
    toolset: 'use',
    description: 'Start one user-requested Hermes Studio chat or coding-agent run through the HTTP bridge and wait for completion. Do not use this as an internal delegation or subtask mechanism.',
    inputSchema: inputSchema({
        input: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'object', additionalProperties: true } },
          ],
          description: 'User message text or content blocks.',
        },
        session_id: {
          type: 'string',
          description: 'Optional existing session id. Omit to create a new session.',
        },
        provider: {
          type: 'string',
          description: 'Optional model provider key, for example openai, anthropic, or deepseek.',
        },
        model: {
          type: 'string',
          description: 'Optional model id for this run.',
        },
        model_groups: {
          type: 'array',
          description: 'Optional provider/model fallback groups.',
          items: { type: 'object', additionalProperties: true },
        },
        source: {
          type: 'string',
          enum: ['cli', 'coding_agent', 'global_agent'],
          description: 'Optional run backend source.',
        },
        session_source: {
          type: 'string',
          enum: ['global_agent'],
          description: 'Optional session source marker.',
        },
        instructions: {
          type: 'string',
          description: 'Optional extra run instructions.',
        },
        workspace: {
          type: ['string', 'null'],
          description: 'Optional working directory for the run.',
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
          type: 'number',
          description: 'Maximum time to wait for a terminal run event.',
        },
        include_events: {
          type: 'boolean',
          description: 'Include recorded run events in the response.',
        },
      }, ['input']),
  },
  {
    name: 'hermes_studio_use_sessions_list',
    toolset: 'use',
    description: 'List Hermes Studio chat sessions for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        limit: {
          type: 'number',
          description: 'Optional maximum number of sessions.',
        },
        source: {
          type: 'string',
          description: 'Optional session source filter.',
        },
      }),
  },
  {
    name: 'hermes_studio_use_sessions_count',
    toolset: 'use',
    description: 'Count Hermes Studio chat sessions without returning the session list. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        source: {
          type: 'string',
          description: 'Optional session source filter.',
        },
      }),
  },
  {
    name: 'hermes_studio_use_usage_stats',
    toolset: 'use',
    description: 'Query Hermes Studio usage totals, cost estimate, model breakdown, and daily trend for the selected profile.',
    inputSchema: inputSchema({
        days: {
          type: 'number',
          description: 'Number of days to include. Server clamps the range to 1-365. Defaults to 30.',
        },
      }),
  },
  {
    name: 'hermes_studio_use_session_get',
    toolset: 'use',
    description: 'Get one Hermes Studio session by id for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id.',
        },
      }, ['session_id']),
  },
  {
    name: 'hermes_studio_use_session_messages',
    toolset: 'use',
    description: 'Get messages for one Hermes Studio conversation. By default returns user and assistant messages only. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Conversation/session id.',
        },
        include_internal: {
          type: 'boolean',
          description: 'Set true to include internal/non-user-visible message roles.',
        },
      }, ['session_id']),
  },
  {
    name: 'hermes_studio_use_session_context',
    toolset: 'use',
    description: 'Get the latest clean user/assistant context for one session, defaulting to the last 10 conversation turns and excluding tool calls/tool results. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id.',
        },
        turns: {
          type: 'number',
          description: 'Number of recent conversation turns to return. Defaults to 10.',
        },
      }, ['session_id']),
  },
  {
    name: 'hermes_studio_use_session_delete',
    toolset: 'use',
    description: 'Delete one Hermes Studio session by id for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id to delete.',
        },
      }, ['session_id']),
  },
  {
    name: 'hermes_studio_use_session_rename',
    toolset: 'use',
    description: 'Rename one Hermes Studio session title for an explicit user-requested session operation. Do not use this as an internal delegation mechanism.',
    inputSchema: inputSchema({
        session_id: {
          type: 'string',
          description: 'Session id to rename.',
        },
        title: {
          type: 'string',
          description: 'New session title.',
        },
      }, ['session_id', 'title']),
  },
  {
    name: 'hermes_studio_use_profiles_list',
    toolset: 'use',
    description: 'List Hermes Studio profiles.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_use_available_models',
    toolset: 'use',
    description: 'List available Hermes Studio models for the selected profile as a compact provider/model summary. Use query to narrow results or include_details=true only when raw provider metadata is required.',
    inputSchema: inputSchema({
        query: {
          type: 'string',
          description: 'Optional case-insensitive provider, model, or alias substring filter.',
        },
        limit_per_provider: {
          type: 'number',
          description: 'Maximum model ids to return for each provider. Defaults to 20, maximum 100.',
        },
        include_details: {
          type: 'boolean',
          description: 'Return the raw /api/hermes/available-models payload, including full provider metadata. Defaults to false.',
        },
      }),
  },
  {
    name: 'hermes_studio_use_model_provider_get',
    toolset: 'use',
    description: 'Find provider candidates for a model id from the selected profile available-models catalog.',
    inputSchema: inputSchema({
        model: {
          type: 'string',
          description: 'Model id or visible model alias to look up.',
        },
      }, ['model']),
  },
  {
    name: 'hermes_studio_use_provider_add',
    toolset: 'use',
    description: 'Add or update a Hermes Studio model provider for the selected profile, then make it the active default provider/model.',
    inputSchema: inputSchema({
        name: {
          type: 'string',
          description: 'Provider display/config name. For custom providers this becomes the custom provider name.',
        },
        base_url: {
          type: 'string',
          description: 'Provider API base URL. For built-in providers this can be omitted only when the preset supplies a default URL.',
        },
        api_key: {
          type: 'string',
          description: 'Provider API key. Some built-in providers do not require this.',
        },
        model: {
          type: 'string',
          description: 'Default model id to use with this provider.',
        },
        context_length: {
          type: 'number',
          description: 'Optional context length metadata for the model.',
        },
        providerKey: {
          type: ['string', 'null'],
          description: 'Optional built-in or custom provider key. Omit for a normal custom provider; use values like openai-codex or custom:my-provider when needed.',
        },
        api_mode: {
          type: 'string',
          enum: ['chat_completions', 'codex_responses', 'anthropic_messages', 'bedrock_converse', 'codex_app_server'],
          description: 'Optional provider wire API mode.',
        },
      }, ['name', 'base_url', 'model']),
  },
  {
    name: 'hermes_studio_use_provider_delete',
    toolset: 'use',
    description: 'Delete a Hermes Studio model provider or clear a built-in provider credential for the selected profile.',
    inputSchema: inputSchema({
        pool_key: {
          type: 'string',
          description: 'Provider pool key to delete, for example custom:my-provider, openai, openai-codex, or deepseek.',
        },
        source: {
          type: 'string',
          enum: ['custom_providers', 'providers'],
          description: 'Optional custom provider storage source when removing one duplicate location.',
        },
        providerKey: {
          type: 'string',
          description: 'Optional providers-dict key to disambiguate dict-backed custom providers.',
        },
      }, ['pool_key']),
  },
  {
    name: 'hermes_studio_use_worker_status',
    toolset: 'use',
    description: 'Summarize current Hermes worker state, including worker count, completed interactions, and sessions still interacting.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_use_workflows_list',
    toolset: 'use',
    description: 'List Hermes Studio workflows for the selected or requested profile.',
    inputSchema: inputSchema({
        profile: {
          type: 'string',
          description: 'Optional profile filter. When omitted, the active MCP profile is used through X-Hermes-Profile.',
        },
      }),
  },
  {
    name: 'hermes_studio_use_workflow_get',
    toolset: 'use',
    description: 'Get one Hermes Studio workflow by id.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'hermes_studio_use_workflow_create',
    toolset: 'use',
    description: 'Create a Hermes Studio workflow with optional nodes, edges, viewport, workspace, and profile.',
    inputSchema: inputSchema({
        name: {
          type: 'string',
          description: 'Workflow name.',
        },
        profile: {
          type: 'string',
          description: 'Optional workflow profile. Defaults to the active MCP profile or server default.',
        },
        workspace: {
          type: ['string', 'null'],
          description: 'Optional workflow workspace path.',
        },
        nodes: {
          type: 'array',
          description: 'Optional workflow node array.',
          items: { type: 'object', additionalProperties: true },
        },
        edges: {
          type: 'array',
          description: 'Optional workflow edge array.',
          items: { type: 'object', additionalProperties: true },
        },
        viewport: {
          type: ['object', 'null'],
          description: 'Optional workflow viewport state.',
          additionalProperties: true,
        },
      }, ['name']),
  },
  {
    name: 'hermes_studio_use_workflow_update',
    toolset: 'use',
    description: 'Update a Hermes Studio workflow name, workspace, nodes, edges, or viewport.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        name: {
          type: 'string',
          description: 'Optional new workflow name.',
        },
        workspace: {
          type: ['string', 'null'],
          description: 'Optional workspace path update.',
        },
        nodes: {
          type: 'array',
          description: 'Optional replacement workflow node array.',
          items: { type: 'object', additionalProperties: true },
        },
        edges: {
          type: 'array',
          description: 'Optional replacement workflow edge array.',
          items: { type: 'object', additionalProperties: true },
        },
        viewport: {
          type: ['object', 'null'],
          description: 'Optional replacement workflow viewport state.',
          additionalProperties: true,
        },
      }, ['workflow_id']),
  },
  {
    name: 'hermes_studio_use_workflow_delete',
    toolset: 'use',
    description: 'Delete one Hermes Studio workflow by id, including its workflow run records.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id to delete.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'hermes_studio_use_workflow_runs_list',
    toolset: 'use',
    description: 'List recent run records and node sessions for one workflow.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        limit: {
          type: 'number',
          description: 'Optional maximum number of workflow runs.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'hermes_studio_use_workflow_run_start',
    toolset: 'use',
    description: 'Start a workflow run. Returns accepted status while the workflow continues asynchronously.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        start_node_ids: {
          type: 'array',
          description: 'Optional node ids to start from.',
          items: { type: 'string' },
        },
        input: {
          type: ['string', 'null'],
          description: 'Optional workflow input text.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional per-node run timeout in milliseconds.',
        },
      }, ['workflow_id']),
  },
  {
    name: 'hermes_studio_use_workflow_run_stop',
    toolset: 'use',
    description: 'Cancel a queued or running workflow run.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        run_id: {
          type: 'string',
          description: 'Workflow run id.',
        },
      }, ['workflow_id', 'run_id']),
  },
  {
    name: 'hermes_studio_use_workflow_run_rerun_from_node',
    toolset: 'use',
    description: 'Rerun an existing workflow run from a node. Use preserve_start_node=true to keep the selected node message and only rerun downstream nodes; false clears the selected node and downstream sessions.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        run_id: {
          type: 'string',
          description: 'Workflow run id.',
        },
        node_id: {
          type: 'string',
          description: 'Node id to rerun from.',
        },
        preserve_start_node: {
          type: 'boolean',
          description: 'When true, keep the selected node session and rerun downstream nodes only. Defaults to false on the server.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional per-node run timeout in milliseconds.',
        },
      }, ['workflow_id', 'run_id', 'node_id']),
  },
  {
    name: 'hermes_studio_use_workflow_run_delete',
    toolset: 'use',
    description: 'Delete one workflow run and its node session records.',
    inputSchema: inputSchema({
        workflow_id: {
          type: 'string',
          description: 'Workflow id.',
        },
        run_id: {
          type: 'string',
          description: 'Workflow run id.',
        },
      }, ['workflow_id', 'run_id']),
  },
  {
    name: 'hermes_studio_lan_devices_list',
    toolset: 'devices',
    description: 'List known LAN and remote devices from Hermes Web UI, including pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_lan_devices_scan',
    toolset: 'devices',
    description: 'Refresh LAN device discovery cache and return known devices with pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_lan_peer_connect',
    toolset: 'devices',
    description: 'Connect to a paired LAN device by device id.',
    inputSchema: inputSchema({ device_id: { type: 'string' } }, ['device_id']),
  },
  {
    name: 'hermes_studio_lan_peer_connections',
    toolset: 'devices',
    description: 'List active LAN peer socket connections.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_lan_peer_disconnect',
    toolset: 'devices',
    description: 'Disconnect an active LAN peer socket connection.',
    inputSchema: inputSchema({ connection_id: { type: 'string' } }, ['connection_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_create',
    toolset: 'devices',
    description: 'Create an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        shell: { type: 'string' },
        cols: { type: 'number' },
        rows: { type: 'number' },
      }, ['connection_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_list',
    toolset: 'devices',
    description: 'List interactive terminals tracked for a connected LAN peer, including IDs that can be read or closed.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
      }, ['connection_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_input',
    toolset: 'devices',
    description: 'Write input to an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
        data: { type: 'string' },
      }, ['connection_id', 'terminal_id', 'data']),
  },
  {
    name: 'hermes_studio_lan_terminal_read',
    toolset: 'devices',
    description: 'Read buffered terminal output from an interactive terminal.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
      }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_resize',
    toolset: 'devices',
    description: 'Resize an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
        cols: { type: 'number' },
        rows: { type: 'number' },
      }, ['connection_id', 'terminal_id', 'cols', 'rows']),
  },
  {
    name: 'hermes_studio_lan_terminal_close',
    toolset: 'devices',
    description: 'Close an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        terminal_id: { type: 'string' },
      }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'hermes_studio_lan_command_exec',
    toolset: 'devices',
    description: 'Run a command on a connected LAN peer using command plus args, without shell string execution.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number' },
      }, ['connection_id', 'command']),
  },
  {
    name: 'hermes_studio_lan_file_download',
    toolset: 'devices',
    description: 'Download a file from a connected LAN peer remote path to a local path on this machine.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        remote_path: { type: 'string' },
        local_path: { type: 'string' },
        timeout_ms: { type: 'number' },
      }, ['connection_id', 'remote_path', 'local_path']),
  },
  {
    name: 'hermes_studio_lan_file_upload',
    toolset: 'devices',
    description: 'Upload a local file path from this machine to a connected LAN peer remote path.',
    inputSchema: inputSchema({
        connection_id: { type: 'string' },
        local_path: { type: 'string' },
        remote_path: { type: 'string' },
        timeout_ms: { type: 'number' },
      }, ['connection_id', 'local_path', 'remote_path']),
  },
]

const TOOL_ALIASES = new Map([
  ['hermes_api_openapi_get', 'hermes_studio_api_openapi_get'],
  ['hermes_api_request', 'hermes_studio_api_request'],
  ['hermes_lan_devices_list', 'hermes_studio_lan_devices_list'],
  ['hermes_lan_devices_scan', 'hermes_studio_lan_devices_scan'],
  ['hermes_lan_peer_connect', 'hermes_studio_lan_peer_connect'],
  ['hermes_lan_peer_connections', 'hermes_studio_lan_peer_connections'],
  ['hermes_lan_peer_disconnect', 'hermes_studio_lan_peer_disconnect'],
  ['hermes_lan_terminal_create', 'hermes_studio_lan_terminal_create'],
  ['hermes_lan_terminal_list', 'hermes_studio_lan_terminal_list'],
  ['hermes_lan_terminal_input', 'hermes_studio_lan_terminal_input'],
  ['hermes_lan_terminal_read', 'hermes_studio_lan_terminal_read'],
  ['hermes_lan_terminal_resize', 'hermes_studio_lan_terminal_resize'],
  ['hermes_lan_terminal_close', 'hermes_studio_lan_terminal_close'],
  ['hermes_lan_command_exec', 'hermes_studio_lan_command_exec'],
  ['hermes_lan_file_download', 'hermes_studio_lan_file_download'],
  ['hermes_lan_file_upload', 'hermes_studio_lan_file_upload'],
])

function resolveToolName(name) {
  return TOOL_ALIASES.get(name) || name
}

function visibleTools() {
  const visible = tools.filter(tool => tool.toolset === ACTIVE_TOOLSET)
  return visible.map(({ toolset, ...tool }) => tool)
}

function isToolVisible(name) {
  return visibleTools().some(tool => tool.name === resolveToolName(name))
}

async function callTool(name, args = {}) {
  if (!isToolVisible(name)) {
    return errorText(`Tool is not available in the active '${ACTIVE_TOOLSET}' MCP toolset: ${name}`)
  }
  switch (resolveToolName(name)) {
    case 'hermes_studio_api_openapi_get':
      return jsonText(compactOpenApiDocument(await openApiDocument(withAuthArgs(args)), args))
    case 'hermes_studio_api_request': {
      const method = normalizeApiMethod(args.method)
      const path = normalizeApiPath(args.path)
      if (!method) return errorText('Invalid method. Allowed: GET, POST, PUT, PATCH, DELETE, HEAD.')
      if (!path) return errorText('Invalid path. Use a relative /api/... or /health path from hermes_studio_api_openapi_get; full URLs are not allowed.')
      const validationError = await validateApiRequest(method, path, args)
      if (validationError) return errorText(`Invalid API request for ${method} ${pathWithoutQuery(path)}: ${validationError}. Use hermes_studio_api_openapi_get to inspect required parameters and requestBody.`)
      const options = withAuthArgs(args, {
        method,
        query: args.query,
        headers: args.headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: args.body }),
      })
      return jsonText(await requestEnvelope(path, options))
    }
    case 'hermes_studio_use_chat_run':
      return jsonText(await request('/api/chat-run/runs', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'input',
          'session_id',
          'provider',
          'model',
          'model_groups',
          'source',
          'session_source',
          'instructions',
          'workspace',
          'reasoning_effort',
          'coding_agent_id',
          'agent_id',
          'mode',
          'baseUrl',
          'apiKey',
          'apiMode',
          'timeout_ms',
          'include_events',
        ]),
      })))
    case 'hermes_studio_use_sessions_list':
      return jsonText(await request('/api/hermes/sessions', withAuthArgs(args, {
        query: pickDefined(args, ['limit', 'source']),
      })))
    case 'hermes_studio_use_sessions_count':
      return jsonText(await request('/api/hermes/sessions/count', withAuthArgs(args, {
        query: pickDefined(args, ['source']),
      })))
    case 'hermes_studio_use_usage_stats':
      return jsonText(await request('/api/hermes/usage/stats', withAuthArgs(args, {
        query: pickDefined(args, ['days']),
      })))
    case 'hermes_studio_use_session_get':
      return jsonText(await request(`/api/hermes/sessions/${encodeURIComponent(args.session_id)}`, withAuthArgs(args)))
    case 'hermes_studio_use_session_messages':
      return jsonText(await request(`/api/hermes/sessions/conversations/${encodeURIComponent(args.session_id)}/messages`, withAuthArgs(args, {
        query: args.include_internal ? { humanOnly: '0' } : undefined,
      })))
    case 'hermes_studio_use_session_context':
      return jsonText(cleanSessionContextPayload(
        await request(`/api/hermes/sessions/${encodeURIComponent(args.session_id)}/context`, withAuthArgs(args)),
        args,
      ))
    case 'hermes_studio_use_session_delete':
      return jsonText(await request(`/api/hermes/sessions/${encodeURIComponent(args.session_id)}`, withAuthArgs(args, {
        method: 'DELETE',
      })))
    case 'hermes_studio_use_session_rename':
      return jsonText(await request(`/api/hermes/sessions/${encodeURIComponent(args.session_id)}/rename`, withAuthArgs(args, {
        method: 'POST',
        body: { title: args.title },
      })))
    case 'hermes_studio_use_profiles_list':
      return jsonText(await request('/api/hermes/profiles', withAuthArgs(args)))
    case 'hermes_studio_use_available_models':
      return jsonText(compactAvailableModelsPayload(
        await request('/api/hermes/available-models', withAuthArgs(args)),
        args,
      ))
    case 'hermes_studio_use_model_provider_get':
      return jsonText(findProvidersForModel(
        await request('/api/hermes/available-models', withAuthArgs(args)),
        args.model,
      ))
    case 'hermes_studio_use_provider_add':
      return jsonText(await request('/api/hermes/config/providers', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'name',
          'base_url',
          'api_key',
          'model',
          'context_length',
          'providerKey',
          'api_mode',
        ]),
      })))
    case 'hermes_studio_use_provider_delete':
      return jsonText(await request(`/api/hermes/config/providers/${encodeURIComponent(args.pool_key)}`, withAuthArgs(args, {
        method: 'DELETE',
        query: pickDefined(args, ['source', 'providerKey']),
      })))
    case 'hermes_studio_use_worker_status':
      return jsonText(summarizeWorkerRuntime(
        await request('/api/hermes/performance/runtime', withAuthArgs(args)),
      ))
    case 'hermes_studio_use_workflows_list':
      return jsonText(await request('/api/hermes/workflows', withAuthArgs(args, {
        query: pickDefined(args, ['profile']),
      })))
    case 'hermes_studio_use_workflow_get':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}`, withAuthArgs(args)))
    case 'hermes_studio_use_workflow_create':
      return jsonText(await request('/api/hermes/workflows', withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'name',
          'profile',
          'workspace',
          'nodes',
          'edges',
          'viewport',
        ]),
      })))
    case 'hermes_studio_use_workflow_update':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}`, withAuthArgs(args, {
        method: 'PATCH',
        body: pickDefined(args, [
          'name',
          'workspace',
          'nodes',
          'edges',
          'viewport',
        ]),
      })))
    case 'hermes_studio_use_workflow_delete':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}`, withAuthArgs(args, {
        method: 'DELETE',
      })))
    case 'hermes_studio_use_workflow_runs_list':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}/runs`, withAuthArgs(args, {
        query: pickDefined(args, ['limit']),
      })))
    case 'hermes_studio_use_workflow_run_start':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}/run`, withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'start_node_ids',
          'input',
          'timeout_ms',
        ]),
      })))
    case 'hermes_studio_use_workflow_run_stop':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}/runs/${encodeURIComponent(args.run_id)}/stop`, withAuthArgs(args, {
        method: 'POST',
      })))
    case 'hermes_studio_use_workflow_run_rerun_from_node':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}/runs/${encodeURIComponent(args.run_id)}/rerun-from-node`, withAuthArgs(args, {
        method: 'POST',
        body: pickDefined(args, [
          'node_id',
          'preserve_start_node',
          'timeout_ms',
        ]),
      })))
    case 'hermes_studio_use_workflow_run_delete':
      return jsonText(await request(`/api/hermes/workflows/${encodeURIComponent(args.workflow_id)}/runs/${encodeURIComponent(args.run_id)}`, withAuthArgs(args, {
        method: 'DELETE',
      })))
    case 'hermes_studio_lan_devices_list':
      return jsonText(await request('/api/devices', withAuthArgs(args)))
    case 'hermes_studio_lan_devices_scan':
      return jsonText(await request('/api/devices/scan', withAuthArgs(args, { method: 'POST' })))
    case 'hermes_studio_lan_peer_connect':
      return jsonText(await request(`/api/devices/${encodeURIComponent(args.device_id)}/connect`, withAuthArgs(args, { method: 'POST' })))
    case 'hermes_studio_lan_peer_connections':
      return jsonText(await request('/api/devices/peer-connections', withAuthArgs(args)))
    case 'hermes_studio_lan_peer_disconnect':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/disconnect`, withAuthArgs(args, { method: 'POST' })))
    case 'hermes_studio_lan_terminal_create':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal`, withAuthArgs(args, {
        method: 'POST',
        body: { shell: args.shell, cols: args.cols, rows: args.rows },
      })))
    case 'hermes_studio_lan_terminal_list':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminals`, withAuthArgs(args)))
    case 'hermes_studio_lan_terminal_input':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/input`, withAuthArgs(args, {
        method: 'POST',
        body: { data: args.data },
      })))
    case 'hermes_studio_lan_terminal_read':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/read`, withAuthArgs(args)))
    case 'hermes_studio_lan_terminal_resize':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/resize`, withAuthArgs(args, {
        method: 'POST',
        body: { cols: args.cols, rows: args.rows },
      })))
    case 'hermes_studio_lan_terminal_close':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/terminal/${encodeURIComponent(args.terminal_id)}/close`, withAuthArgs(args, { method: 'POST' })))
    case 'hermes_studio_lan_command_exec':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/exec`, withAuthArgs(args, {
        method: 'POST',
        body: { command: args.command, args: args.args || [], cwd: args.cwd, timeout_ms: args.timeout_ms },
      })))
    case 'hermes_studio_lan_file_download':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/download`, withAuthArgs(args, {
        method: 'POST',
        body: { remote_path: args.remote_path, local_path: args.local_path, timeout_ms: args.timeout_ms },
      })))
    case 'hermes_studio_lan_file_upload':
      return jsonText(await request(`/api/devices/peer-connections/${encodeURIComponent(args.connection_id)}/upload`, withAuthArgs(args, {
        method: 'POST',
        body: { local_path: args.local_path, remote_path: args.remote_path, timeout_ms: args.timeout_ms },
      })))
    default:
      return errorText(`Unknown tool: ${name}`)
  }
}

async function handle(message) {
  if (!message || message.id === undefined) return null

  try {
    switch (message.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: VERSION, toolset: ACTIVE_TOOLSET },
          },
        }
      case 'tools/list':
        return { jsonrpc: '2.0', id: message.id, result: { tools: visibleTools() } }
      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id: message.id,
          result: await callTool(message.params?.name, message.params?.arguments || {}),
        }
      default:
        return {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        }
    }
  } catch (err) {
    return { jsonrpc: '2.0', id: message.id, result: errorText(err?.message || String(err)) }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async line => {
  const text = line.trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  const response = await handle(message)
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
})
