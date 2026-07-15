export interface ResponsesAdapterTarget {
  model: string
}

const HERMES_STUDIO_NAMESPACE = 'mcp__hermes_studio'

const HERMES_STUDIO_MCP_TOOLS = [
  {
    name: 'hermes_studio_lan_devices_list',
    description: 'List known LAN and remote devices from Hermes Web UI, including pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_lan_devices_scan',
    description: 'Refresh LAN device discovery cache and return known devices with pairing and online status.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_lan_peer_connect',
    description: 'Connect to a paired LAN device by device id.',
    inputSchema: inputSchema({ device_id: { type: 'string' } }, ['device_id']),
  },
  {
    name: 'hermes_studio_lan_peer_connections',
    description: 'List active LAN peer socket connections.',
    inputSchema: inputSchema(),
  },
  {
    name: 'hermes_studio_lan_peer_disconnect',
    description: 'Disconnect an active LAN peer socket connection.',
    inputSchema: inputSchema({ connection_id: { type: 'string' } }, ['connection_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_create',
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
    description: 'List interactive terminals tracked for a connected LAN peer, including IDs that can be read or closed.',
    inputSchema: inputSchema({ connection_id: { type: 'string' } }, ['connection_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_input',
    description: 'Write input to an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
      data: { type: 'string' },
    }, ['connection_id', 'terminal_id', 'data']),
  },
  {
    name: 'hermes_studio_lan_terminal_read',
    description: 'Read buffered terminal output from an interactive terminal.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
    }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'hermes_studio_lan_terminal_resize',
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
    description: 'Close an interactive terminal on a connected LAN peer.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      terminal_id: { type: 'string' },
    }, ['connection_id', 'terminal_id']),
  },
  {
    name: 'hermes_studio_lan_command_exec',
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
    description: 'Upload a local file path from this machine to a connected LAN peer remote path.',
    inputSchema: inputSchema({
      connection_id: { type: 'string' },
      local_path: { type: 'string' },
      remote_path: { type: 'string' },
      timeout_ms: { type: 'number' },
    }, ['connection_id', 'local_path', 'remote_path']),
  },
]

const HERMES_STUDIO_MCP_TOOL_NAMES = new Set(HERMES_STUDIO_MCP_TOOLS.map(tool => tool.name))

function inputSchema(properties: Record<string, unknown> = {}, required: string[] = []) {
  return {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description: 'Optional Hermes Web UI bearer token. Usually omit this and pass profile so the MCP server can read the temporary profile token.',
      },
      profile: {
        type: 'string',
        description: 'Hermes profile name for profile-scoped Web UI requests and temporary profile token lookup.',
      },
      ...properties,
    },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  }
}

function normalizedNamespaceName(value: unknown): string {
  return String(value || '').trim().replace(/-/g, '_')
}

function expandedResponseTools(tools: unknown): any[] {
  if (!Array.isArray(tools)) return []
  const mapped: any[] = []
  const seen = new Set<string>()
  const addFunctionTool = (tool: any) => {
    const name = String(tool?.name || '').trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    mapped.push({
      type: 'function',
      name,
      description: String(tool?.description || ''),
      parameters: tool?.parameters || tool?.inputSchema || { type: 'object', properties: {} },
      ...(tool?.namespace ? { namespace: tool.namespace } : {}),
    })
  }
  for (const tool of tools) {
    if (tool?.type === 'function') {
      addFunctionTool(tool)
      continue
    }
    if (tool?.type === 'namespace' && normalizedNamespaceName(tool?.name) === HERMES_STUDIO_NAMESPACE) {
      for (const mcpTool of HERMES_STUDIO_MCP_TOOLS) {
        addFunctionTool({
          type: 'function',
          name: mcpTool.name,
          description: `${mcpTool.description} MCP namespace: ${HERMES_STUDIO_NAMESPACE}.`,
          parameters: mcpTool.inputSchema,
          namespace: HERMES_STUDIO_NAMESPACE,
        })
      }
      continue
    }
    if (tool?.type === 'namespace') {
      const namespace = normalizedNamespaceName(tool?.name)
      if (namespace.startsWith('mcp__')) {
        addFunctionTool({
          type: 'function',
          name: namespace,
          description: `${String(tool?.description || `Tools in the ${namespace} MCP namespace.`)} Call a tool in this MCP namespace by passing the tool name and its JSON arguments.`,
          parameters: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                description: 'Name of the MCP tool to call inside this namespace.',
              },
              arguments: {
                type: 'object',
                description: 'JSON arguments for the MCP tool.',
                additionalProperties: true,
              },
            },
            required: ['tool', 'arguments'],
            additionalProperties: false,
          },
          namespace,
        })
      }
    }
  }
  return mapped
}

export function responseToolNamespaceForName(name: unknown): string | undefined {
  return HERMES_STUDIO_MCP_TOOL_NAMES.has(String(name || '')) ? HERMES_STUDIO_NAMESPACE : undefined
}

export function normalizeResponseFunctionCall(name: unknown, argumentsValue: unknown): { name: string; arguments: string; namespace?: string } {
  const rawName = String(name || 'tool')
  const rawArguments = String(argumentsValue || '{}')
  const namespace = normalizedNamespaceName(rawName)
  if (namespace.startsWith('mcp__')) {
    const parsed = safeJsonParse(rawArguments)
    const toolName = String(parsed?.tool || parsed?.name || '').trim()
    if (toolName) {
      const toolArguments = parsed?.arguments && typeof parsed.arguments === 'object'
        ? parsed.arguments
        : parsed?.input && typeof parsed.input === 'object'
          ? parsed.input
          : {}
      return {
        name: toolName,
        arguments: JSON.stringify(toolArguments),
        namespace,
      }
    }
  }

  const knownNamespace = responseToolNamespaceForName(rawName)
  return {
    name: rawName,
    arguments: rawArguments,
    ...(knownNamespace ? { namespace: knownNamespace } : {}),
  }
}

export function targetReasoningEffort(target: any): string {
  const effort = String(target?.reasoningEffort || '').trim()
  return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : ''
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const block = item as any
        if (typeof block.text === 'string') return block.text
        if (typeof block.output === 'string') return block.output
      }
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
  }
  if (value == null) return ''
  return JSON.stringify(value)
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
function responseContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyContent(content)
  return content.map((part: any) => {
    if (typeof part === 'string') return part
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
      return String(part.text || '')
    }
    return stringifyContent(part)
  }).filter(Boolean).join('\n')
}

function chatRoleForResponsesRole(role: unknown): string {
  const value = String(role || '').trim()
  if (value === 'developer') return 'system'
  if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'user'
}

function responsesInputToChatMessages(body: any): any[] {
  const messages: any[] = []
  if (body?.instructions) {
    messages.push({ role: 'system', content: stringifyContent(body.instructions) })
  }

  const input = body?.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }

  let pendingToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = []
  let pendingToolOutputs = new Map<string, any>()
  const flushCompletedToolCalls = () => {
    if (!pendingToolCalls.length) return
    const outputs = pendingToolCalls.map(call => pendingToolOutputs.get(call.id))
    if (outputs.every(Boolean)) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: pendingToolCalls,
      })
      for (let index = 0; index < pendingToolCalls.length; index += 1) {
        messages.push({
          role: 'tool',
          tool_call_id: pendingToolCalls[index].id,
          content: stringifyContent(outputs[index].output),
        })
      }
    }
    pendingToolCalls = []
    pendingToolOutputs = new Map()
  }

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call') {
      const callId = String(item.call_id || item.id || `call_${messages.length}`)
      pendingToolCalls.push({
        id: callId,
        type: 'function',
        function: {
          name: String(item.name || 'tool'),
          arguments: String(item.arguments || '{}'),
        },
      })
      continue
    }
    if (item.type === 'function_call_output') {
      const callId = String(item.call_id || '')
      if (pendingToolCalls.some(call => call.id === callId)) {
        pendingToolOutputs.set(callId, item)
        if (pendingToolCalls.every(call => pendingToolOutputs.has(call.id))) {
          flushCompletedToolCalls()
        }
      }
      continue
    }
    flushCompletedToolCalls()
    if (item.role) {
      messages.push({
        role: chatRoleForResponsesRole(item.role),
        content: responseContentToText(item.content),
      })
    }
  }
  flushCompletedToolCalls()

  return messages.length ? messages : [{ role: 'user', content: '' }]
}

function responsesToolsToChatTools(tools: unknown): any[] | undefined {
  const mapped = expandedResponseTools(tools).map((tool: any) => {
    if (tool?.type !== 'function') return null
    return {
      type: 'function',
      function: {
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }
  }).filter((tool: any) => tool?.function?.name)
  return mapped.length ? mapped : undefined
}

export function responsesToOpenAiChat(body: any, target: ResponsesAdapterTarget, stream = false): any {
  const tools = responsesToolsToChatTools(body?.tools)
  const reasoningEffort = targetReasoningEffort(target)
  return {
    model: target.model,
    messages: responsesInputToChatMessages(body),
    ...(typeof body?.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function responsesRoleToAnthropicRole(role: unknown): 'user' | 'assistant' {
  return String(role || '') === 'assistant' ? 'assistant' : 'user'
}

function responsesContentToAnthropicContent(content: unknown, role: 'user' | 'assistant'): any[] {
  const parts = Array.isArray(content) ? content : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: stringifyContent(content) }]
  const mapped = parts.map((part: any) => {
    if (typeof part === 'string') return { type: 'text', text: part }
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
      return { type: 'text', text: String(part.text || '') }
    }
    return null
  }).filter(Boolean)
  return mapped.length ? mapped : [{ type: 'text', text: '' }]
}

function responsesInputToAnthropicMessages(body: any): any[] {
  const messages: any[] = []
  const input = body?.input
  if (typeof input === 'string') return [{ role: 'user', content: [{ type: 'text', text: input }] }]

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: String(item.call_id || item.id || `toolu_${messages.length}`),
          name: String(item.name || 'tool'),
          input: safeJsonParse(String(item.arguments || '{}')),
        }],
      })
      continue
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.call_id || ''),
          content: stringifyContent(item.output),
        }],
      })
      continue
    }
    if (item.role) {
      const role = responsesRoleToAnthropicRole(item.role)
      messages.push({
        role,
        content: responsesContentToAnthropicContent(item.content, role),
      })
    }
  }

  return messages.length ? messages : [{ role: 'user', content: [{ type: 'text', text: '' }] }]
}

function responsesToolsToAnthropicTools(tools: unknown): any[] | undefined {
  const mapped = expandedResponseTools(tools).map((tool: any) => {
    if (tool?.type !== 'function') return null
    return {
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      input_schema: tool.parameters || { type: 'object', properties: {} },
    }
  }).filter((tool: any) => tool?.name)
  return mapped.length ? mapped : undefined
}

export function responsesToAnthropicMessages(body: any, target: ResponsesAdapterTarget, stream = false): any {
  const tools = responsesToolsToAnthropicTools(body?.tools)
  const reasoningEffort = targetReasoningEffort(target)
  return {
    model: target.model,
    messages: responsesInputToAnthropicMessages(body),
    ...(body?.instructions ? { system: stringifyContent(body.instructions) } : {}),
    ...(typeof body?.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : { max_tokens: 4096 }),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function responseId(data: any): string {
  return String(data?.id || `resp_${Date.now()}`)
}

function usageFromChat(data: any) {
  return {
    input_tokens: Number(data?.usage?.prompt_tokens || 0),
    output_tokens: Number(data?.usage?.completion_tokens || 0),
    total_tokens: Number(data?.usage?.total_tokens || 0),
  }
}

function usageFromAnthropic(data: any) {
  const inputTokens = Number(data?.usage?.input_tokens || 0)
  const outputTokens = Number(data?.usage?.output_tokens || 0)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}

export function openAiChatToResponses(data: any, target: ResponsesAdapterTarget): any {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const output: any[] = []

  if (message.reasoning_content) {
    output.push({
      type: 'reasoning',
      id: `rs_${responseId(data)}`,
      summary: [{ type: 'summary_text', text: String(message.reasoning_content) }],
    })
  }

  if (message.content) {
    output.push({
      type: 'message',
      id: `msg_${responseId(data)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: String(message.content), annotations: [] }],
    })
  }

  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const normalizedCall = normalizeResponseFunctionCall(call.function?.name || 'tool', call.function?.arguments || '{}')
    output.push({
      type: 'function_call',
      id: String(call.id || `fc_${output.length}`),
      call_id: String(call.id || `call_${output.length}`),
      ...normalizedCall,
    })
  }

  return {
    id: responseId(data),
    object: 'response',
    created_at: Number(data?.created || Math.floor(Date.now() / 1000)),
    status: 'completed',
    model: target.model,
    output,
    usage: usageFromChat(data),
  }
}

export function anthropicMessageToResponses(data: any, target: ResponsesAdapterTarget): any {
  const output: any[] = []
  const textParts: string[] = []
  const reasoningParts: string[] = []
  for (const block of Array.isArray(data?.content) ? data.content : []) {
    if (block?.type === 'text' && block.text) textParts.push(String(block.text))
    if (block?.type === 'thinking' && block.thinking) reasoningParts.push(String(block.thinking))
    if (block?.type === 'redacted_thinking') reasoningParts.push('[redacted thinking]')
    if (block?.type === 'tool_use') {
      const normalizedCall = normalizeResponseFunctionCall(block.name || 'tool', JSON.stringify(block.input || {}))
      output.push({
        type: 'function_call',
        id: String(block.id || `fc_${output.length}`),
        call_id: String(block.id || `call_${output.length}`),
        ...normalizedCall,
      })
    }
  }
  if (textParts.length) {
    output.unshift({
      type: 'message',
      id: `msg_${responseId(data)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textParts.join('\n'), annotations: [] }],
    })
  }
  if (reasoningParts.length) {
    output.unshift({
      type: 'reasoning',
      id: `rs_${responseId(data)}`,
      summary: [{ type: 'summary_text', text: reasoningParts.join('\n') }],
    })
  }

  return {
    id: responseId(data),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: target.model,
    output,
    usage: usageFromAnthropic(data),
  }
}
