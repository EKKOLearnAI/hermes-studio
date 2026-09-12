export const DSH_COMPACT_METHOD = '_ekko/compact'

export interface DshCompactResult {
  compacted: boolean
  beforeTokens?: number
  afterTokens?: number
}

/** Installed only in the private ACP adapter. The selected Agent's
 * native backend owns history selection, summarization, cancellation and saving. */
export const DSH_COMPACTION_HANDLER = `
async function compactStudioDshSession(record, signal) {
  record.assertActive();
  const agent = record.agent;
  const compaction = record.ctx.agentPresets.serviceFor?.(agent, 'compaction');
  if (!compaction) throw new RequestError(-32000, 'The selected DSH preset does not provide native compaction');
  const meter = agent.ctx.get('tokenMeter');
  const beforeTokens = meter?.measure(agent.session).totalTokens;
  let result;
  try { result = await compaction.compactNow(agent, signal); }
  catch (error) { throw new RequestError(-32000, error.message || 'DSH native compaction failed'); }
  await record.ctx.sessions.flush(agent.session);
  await record.outputTail;
  const afterTokens = meter?.measure(agent.session).totalTokens;
  return { compacted: result !== null,
    ...(Number.isFinite(beforeTokens) ? { beforeTokens } : {}),
    ...(Number.isFinite(afterTokens) ? { afterTokens } : {}) };
}
`
