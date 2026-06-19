import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

describe('personal state service', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hwui-personal-state-'))
    process.env.HERMES_HOME = hermesHome
  })

  afterEach(() => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    if (hermesHome) rmSync(hermesHome, { recursive: true, force: true })
    hermesHome = ''
  })

  it('creates, reviews, and exposes approved Personal State tasks from Hermes home', async () => {
    const {
      getPersonalStateDbPath,
      getPersonalStateOverview,
      proposePersonalStateChange,
      approvePersonalStateProposal,
    } = await import('../../packages/server/src/services/hermes/personal-state')

    const proposal = proposePersonalStateChange({
      title: 'Create Studio migration task',
      summary: 'Personal State should be visible from Hermes Studio.',
      riskLevel: 'medium',
      proposedAction: {
        type: 'task.create',
        payload: { title: 'Verify Studio Personal State' },
      },
    })

    expect(getPersonalStateDbPath()).toBe(join(hermesHome, 'personal_state.db'))

    const pending = getPersonalStateOverview()
    expect(pending.pendingProposals).toHaveLength(1)
    expect(pending.memoryContext.relevantRecordIds).toEqual([proposal.id])

    const approved = approvePersonalStateProposal(proposal.id, 'user')
    expect(approved.status).toBe('approved')

    const after = getPersonalStateOverview()
    expect(after.pendingProposals).toHaveLength(0)
    expect(after.tasks[0]).toMatchObject({
      title: 'Verify Studio Personal State',
      status: 'open',
      sourceProposalId: proposal.id,
    })
    expect(after.memoryContext.contextBlocks[0]).toMatchObject({
      kind: 'task',
      title: 'Verify Studio Personal State',
    })
  })
})
