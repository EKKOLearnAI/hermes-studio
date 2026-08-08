import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('approval system notification click targets', () => {
  it('routes a safe internal target through Service Worker and Electron notification clicks', () => {
    const serviceWorker = read('packages/client/public/notification-sw.js')
    const desktopMain = read('packages/desktop/src/main/index.ts')
    const desktopPreload = read('packages/desktop/src/preload/index.ts')
    const desktopBridge = read('packages/client/src/utils/desktop-bridge.ts')

    expect(serviceWorker).toContain('safeClickUrl(event.notification.data?.clickUrl)')
    expect(serviceWorker).toContain("value.startsWith('/hermes/')")
    expect(serviceWorker).toContain('client.navigate')
    expect(desktopMain).toContain('safeNotificationClickUrl')
    expect(desktopMain).toContain('webUiHashUrl(clickUrl)')
    expect(desktopPreload).toContain('clickUrl?: string')
    expect(desktopBridge).toContain('clickUrl?: string')
  })

  it('consumes exact Workflow target identity after workflow and run data load', () => {
    const workflowView = read('packages/client/src/views/hermes/WorkflowView.vue')
    expect(workflowView).toContain("import { useRoute } from 'vue-router'")
    expect(workflowView).toContain('route.query.workflowId')
    expect(workflowView).toContain('route.query.runId')
    expect(workflowView).toContain('route.query.nodeId')
    expect(workflowView).toContain('route.query.executionId')
    expect(workflowView).toContain('loadWorkflowRuns(workflowId, runId')
    expect(workflowView).toContain('openWorkflowNodeSession(nodeId)')
  })
})
