import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument, stringify } from 'yaml'
import { writeManagedPromptFile } from '../prompt-file'
import { updateDshMcpServer } from './config'
import { DSH_STREAM_PLUGIN } from './stream-plugin'

export const DSH_MODEL_PROVIDER = 'ekko-studio'
export const DSH_API_KEY_ENV = 'HERMES_DSH_API_KEY'

export function dshReasoningEffort(value?: string): string | undefined {
  const level = value === 'max' ? 'xhigh' : value === 'none' ? 'off' : value
  return level && ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(level) ? level : undefined
}

export async function prepareDshRuntime(input: {
  sourceHome: string
  sharedSkills: string
  rootDir: string
  systemPrompt: string
  managedMcp: Record<string, Record<string, unknown>>
  model?: string
  baseUrl?: string
  contextWindow?: number
  outputLimit?: number
  imageInput?: boolean
  reasoningEffort?: string
}) {
  await mkdir(input.rootDir, { recursive: true })
  const read = async (name: string) => {
    try { return await readFile(join(input.sourceHome, name), 'utf8') }
    catch (error: any) { if (error.code === 'ENOENT') return ''; throw error }
  }
  for (const name of ['settings.yaml', '.credentials.yaml', '.env']) {
    let content = await read(name)
    if (name === 'settings.yaml' && input.model && content) {
      const doc = parseDocument(content, { logLevel: 'silent' })
      if (doc.errors.length) throw new Error(`Invalid DSH settings: ${doc.errors[0].message}`)
      // The settings layer overrides composition config. Pin only Studio's route;
      // other native provider settings remain available to user-installed plugins.
      const providerPath = ['llm-pi-ai', 'providers', DSH_MODEL_PROVIDER]
      if (doc.hasIn(providerPath)) doc.deleteIn(providerPath)
      content = String(doc)
    }
    await writeFile(join(input.rootDir, name), content || (name.endsWith('.yaml') ? '{}\n' : ''), { mode: 0o600 })
  }
  // Preserve profile-installed plugins, but keep sessions and writes in Studio's home.
  try {
    await cp(join(input.sourceHome, 'profiles', 'acp'), join(input.rootDir, 'profiles', 'acp'), { recursive: true })
  } catch (error: any) { if (error.code !== 'ENOENT') throw error }
  let patch = await read('cordis.patch.yml')
  for (const [name, config] of Object.entries(input.managedMcp)) patch = updateDshMcpServer(patch, name, config)
  await writeFile(join(input.rootDir, 'cordis.patch.yml'), patch || '[]\n', { mode: 0o600 })
  const promptFile = join(input.rootDir, 'AGENTS.md')
  await writeManagedPromptFile(promptFile, input.systemPrompt, await read('AGENTS.md'))
  const streamPluginPath = join(input.rootDir, 'studio-stream.mjs')
  await writeFile(streamPluginPath, DSH_STREAM_PLUGIN, { mode: 0o600 })
  const overlay: unknown[] = [
    { insert: [{ id: 'ekko-studio-assistant-stream', name: pathToFileURL(streamPluginPath).href }] },
    { id: 'session-persistence-jsonl', config: { root: join(input.rootDir, 'sessions'), compression: 'none' } },
    { id: 'skill-filesystem', config: { customSkillDirs: [join(input.sourceHome, 'skills'), input.sharedSkills] } },
  ]
  if (input.model) {
    overlay.push(
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-pi-ai', config: { providers: { [DSH_MODEL_PROVIDER]: {
        apiKeyEnv: DSH_API_KEY_ENV,
        api: 'openai-responses',
        baseURL: input.baseUrl,
        models: [{ id: input.model, contextWindow: input.contextWindow || 128_000, maxTokens: input.outputLimit || 8192,
          input: input.imageInput ? ['text', 'image'] : ['text'],
          ...(dshReasoningEffort(input.reasoningEffort) ? {
            reasoningEfforts: { off: null, minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh' },
          } : {}),
        }],
      } } } },
      { id: 'acp', config: { provider: DSH_MODEL_PROVIDER, model: input.model } },
    )
  }
  const overlayPath = join(input.rootDir, 'studio.patch.yml')
  await writeFile(overlayPath, stringify(overlay), { mode: 0o600 })
  return {
    promptFile,
    args: ['--profile', 'acp', '--patch', overlayPath],
    files: ['settings.yaml', 'cordis.patch.yml', 'AGENTS.md', 'studio.patch.yml'].map(path => ({ key: path, path, absolutePath: join(input.rootDir, path) })),
  }
}
