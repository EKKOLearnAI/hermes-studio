import { beforeEach, describe, expect, it, vi } from 'vitest'

const generateHermesTextMock = vi.fn()

vi.mock('../../packages/server/src/services/hermes/dynamic-llm', () => ({
  generateHermesText: generateHermesTextMock,
}))

describe('runStrategicDebate resilience', () => {
  beforeEach(() => {
    generateHermesTextMock.mockReset()
  })

  it('falls back locally when gateway output contains raw Python errors', async () => {
    const { SAFE_GATEWAY_ALERT, runStrategicDebate } = await import('../../packages/server/src/services/debateService')
    generateHermesTextMock.mockResolvedValue({
      text: 'Traceback (most recent call last): TypeError: NoneType object is not iterable',
      runtime: { mode: 'hermes-gateway' },
    })

    const result = await runStrategicDebate(
      { positions: [{ ticker: 'AVGO', pnl: 2.4 }] },
      'AI infrastructure demand remains strong.',
      { cash: 254300, monthlyCashflow: 12000 },
    )

    const serialized = JSON.stringify(result)
    expect(result.mode).toBe('local-fallback')
    expect(result.primeDecision).toContain(SAFE_GATEWAY_ALERT)
    expect(serialized).not.toContain('Traceback')
    expect(serialized).not.toContain('NoneType')
  })
})

describe('MiroFish Universal Brain debate', () => {
  it('creates dynamic cross-domain agents for non-financial topics', async () => {
    const { runMiroFishDebate } = await import('../../packages/server/src/services/hermes/quant-lab/MiroFishAgent')

    const result = await runMiroFishDebate({
      topic: '分析 Vite 替換 webpack 的風險',
      domain: 'universal',
      agentLabels: {
        context: 'Contextual Analyst',
        proponent: 'Proponent Agent',
        risk: 'Risk Assessor Agent',
        judge: 'Hermes Synthesizer',
      },
      phase: 'premarket',
      source: 'aurora-universal-brain',
      evidence: [
        {
          category: 'topic',
          source: 'Aurora OmniBar',
          title: 'Universal topic: Vite migration',
          summary: 'Evaluate whether replacing webpack with Vite improves developer velocity without breaking production builds.',
          importance: 'high',
        },
        {
          category: 'risk',
          source: 'Aurora Universal Brain',
          title: 'Migration risk',
          summary: 'Plugin compatibility, build parity, and rollback cost must be checked.',
          importance: 'high',
        },
      ],
    }, { mode: 'local' })

    const probabilityTotal = result.scenarios.bullish.probability +
      result.scenarios.neutral.probability +
      result.scenarios.bearish.probability

    expect(result.mode).toBe('local')
    expect(result.bull.title).toBe('Proponent Agent')
    expect(result.bear.title).toBe('Risk Assessor Agent')
    expect(result.macro.MacroInsight).toContain('分析 Vite 替換 webpack 的風險')
    expect(result.bull.content).not.toContain('paper watchlist')
    expect(result.bear.content).not.toContain('VIX')
    expect(probabilityTotal).toBeCloseTo(1, 2)
  })
})
