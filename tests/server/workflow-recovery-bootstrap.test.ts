import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('workflow restart recovery bootstrap', () => {
  it('recovers after ChatRun registration and before WorkflowSocket initialization', () => {
    const source = readFileSync(resolve(process.cwd(), 'packages/server/src/index.ts'), 'utf8')
    const register = source.indexOf('setChatRunServer(chatRunServer)')
    const chatInit = source.indexOf('chatRunServer.init()', register)
    const recovery = source.indexOf('recoverActiveRuns()', chatInit)
    const workflowSocket = source.indexOf('workflowSocketServer.init()', recovery)
    expect(register).toBeGreaterThan(-1)
    expect(chatInit).toBeGreaterThan(register)
    expect(recovery).toBeGreaterThan(chatInit)
    expect(workflowSocket).toBeGreaterThan(recovery)
  })
})
