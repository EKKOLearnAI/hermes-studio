// Minimal executable ACP fixture: only the lifecycle seams Studio adapts.
class AcpModelControl {
  constructor() {}
}
function agentOptions() { return {} }
async function mountAcpMcpServers() {}
function invalidParams(message) { return new Error(message) }
export class Session {
  constructor(ctx, agent, modelControl) {
    this.ctx = ctx;
    this.agent = agent;
    this.outputTail = Promise.resolve();
    this.modelControl = modelControl;
  }
  async settle(inflight) {
    if (inflight.messageQueued) {
				await this.agent.whenIdle();
				await this.outputTail;
    }
  }
}
export async function create(ctx, options) {
  const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);
  const metadata = { meta: { cwd: options.cwd }, };
  const agentCtx = { metadata };
  await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
  return { metadata, modelControl, options };
}
export async function restore(ctx, options) {
  const agentCtx = {};
  await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
  return options;
}
export function newOptions(config, params) {
  return {
    agentOptions: agentOptions(config),
					fallbackSelection: config.model
  };
}
export function resumeOptions(ctx, config, persisted, sessionId) {
  if (persisted === void 0 || persisted.origin === "subagent" || persisted.parentSession !== void 0) throw invalidParams(`session is not resumable: ${sessionId}`);
  return {
    agentOptions: agentOptions(config),
						fallbackSelection: config.model
  };
}
