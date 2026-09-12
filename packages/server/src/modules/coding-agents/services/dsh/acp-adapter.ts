import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshPackageDirectory } from './installation'
import { DshPluginError } from './errors'

// Published rc.1 and rc.2 have identical ACP artifacts. Each supported upgrade
// must review these setup/flush seams and pass the real Web-to-ACP tests.
export const DSH_ACP_ARTIFACT_SHA256 = 'dcfa3790c65b58280d812e656ac439fe40303bf9b2f3b45842bdfb2345899cde'
export const DSH_ACP_ADAPTER_REVISION = 2

export async function writeDshAcpAdapter(installation: string, destination: string) {
  const directory = await dshPackageDirectory('@deepseek-ai/dsh-acp', [installation])
  const filename = join(directory, 'lib/index.js')
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  let source = await readFile(filename, 'utf8')
  if (!['0.1.5-rc.1', '0.1.5-rc.2'].includes(manifest.version) || createHash('sha256').update(source).digest('hex') !== DSH_ACP_ARTIFACT_SHA256) {
    throw new DshPluginError(422, 'DSH_CAPABILITY_UNSUPPORTED', 'This DSH ACP version has not been validated for Web presets')
  }
  const replace = (before: string, after: string, count = 1) => {
    if (source.split(before).length - 1 !== count) throw new Error('DSH ACP adapter source contract changed')
    source = source.split(before).join(after)
  }
  replace('agentOptions: agentOptions(config),\n\t\t\t\t\tfallbackSelection:', 'agentOptions: agentOptions(config),\n\t\t\t\t\tagentPreset: params._meta?.agentPreset,\n\t\t\t\t\tfallbackSelection:')
  replace('meta: { cwd: options.cwd },', 'meta: { cwd: options.cwd, agentPreset: options.agentPreset },')
  replace('await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);',
    'await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);\n\t\t\t\tawait ctx.agentPresets.mount(agentCtx, options.agentPreset);', 2)
  replace('const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);',
    'options.agentPreset ??= ctx.agentPresets.defaultId;\n\t\tconst modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);')
  // Restoring uses the saved preset, including when the Web default changed.
  // Legacy ACP histories have no preset; they adopt the current Web default.
  replace('if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) throw invalidParams(`session is not resumable: ${sessionId}`);',
    'if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) throw invalidParams(`session is not resumable: ${sessionId}`);\n\t\t\t\tconst agentPreset = persisted.agentPreset ?? ctx.agentPresets.defaultId;')
  replace('agentOptions: agentOptions(config),\n\t\t\t\t\t\tfallbackSelection:', 'agentOptions: agentOptions(config),\n\t\t\t\t\t\tagentPreset,\n\t\t\t\t\t\tfallbackSelection:')
  replace('if (inflight.messageQueued) {\n\t\t\t\tawait this.agent.whenIdle();\n\t\t\t\tawait this.outputTail;', 'if (inflight.messageQueued) {\n\t\t\t\tawait this.agent.whenIdle();\n\t\t\t\tawait this.outputTail;\n\t\t\t\tawait this.ctx.sessions.flush(this.agent.session);')
  // Apply after native restoration/preset initialization, before any prompt.
  // This also replaces persisted workspace-write/ask values on old sessions.
  replace('this.modelControl = modelControl;', 'this.modelControl = modelControl;\n\t\tsetSandboxMode(this.agent.session, "danger-full-access");\n\t\tsetApprovalPolicy(this.agent.session, "never");')
  source = 'import { setSandboxMode } from "@deepseek-ai/dsh-sandbox-policy";\nimport { setApprovalPolicy } from "@deepseek-ai/dsh-user-approval";\n' + source
  const require = createRequire(filename)
  // Absolute module URLs retain the installed release's dependency identity;
  // the adapter lives in Studio Home and must never resolve Studio's own SDK.
  source = source.replace(/from "([^"\n]+)"/g, (match, specifier: string) => specifier.startsWith('node:') ? match : `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`)
  const license = await readFile(join(directory, 'LICENSE'), 'utf8').catch(() => readFile(join(dirname(installation), 'LICENSE'), 'utf8'))
  await writeFile(destination + '.LICENSE', license)
  await writeFile(destination, `// Studio DSH ACP adapter revision ${DSH_ACP_ADAPTER_REVISION}; upstream ${manifest.version} (MIT).\n` + source, { mode: 0o600 })
}
