// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { VibeBuildResponse } from '@/api/aurora/vibe-coding'

const { buildVibeWidgetMock, applyVibeWidgetMock } = vi.hoisted(() => ({
  buildVibeWidgetMock: vi.fn(),
  applyVibeWidgetMock: vi.fn(),
}))

vi.mock('@/api/aurora/vibe-coding', () => ({
  buildVibeWidget: buildVibeWidgetMock,
  applyVibeWidget: applyVibeWidgetMock,
}))

import { useVibeCodingStore } from '@/stores/hermes/vibe-coding'
import { useChatStore } from '@/stores/hermes/chat'

const safeBuild: VibeBuildResponse = {
  buildId: 'build-pomodoro',
  widgetName: 'PomodoroSafeWidget',
  componentPath: 'packages/client/src/components/generated/PomodoroSafeWidget.vue',
  spec: 'Build a compact Pomodoro widget.',
  uiMock: 'Glass timer with start and reset controls.',
  code: '<template><section>Pomodoro</section></template>',
  patchDiff: 'diff --git a/packages/client/src/components/generated/PomodoroSafeWidget.vue b/packages/client/src/components/generated/PomodoroSafeWidget.vue',
  securityReport: [],
  blocked: false,
  runtime: {
    mode: 'fixture',
    provider: 'test',
    model: 'gpt-test',
  },
}

async function flushPromises() {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('Aurora Vibe Coding store safety', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    buildVibeWidgetMock.mockReset()
    applyVibeWidgetMock.mockReset()
  })

  it('halts at Step 8 with a safe generated component path and exposes an L4 approval', async () => {
    buildVibeWidgetMock.mockResolvedValueOnce(safeBuild)
    const store = useVibeCodingStore()

    store.start('   Build a Pomodoro widget   ')
    await flushPromises()

    expect(buildVibeWidgetMock).toHaveBeenCalledWith('Build a Pomodoro widget', expect.any(AbortSignal))
    expect(store.status).toBe('awaiting_approval')
    expect(store.activeStep).toBe(8)
    expect(store.approvalPending).toBe(true)
    expect(store.componentPath).toBe('packages/client/src/components/generated/PomodoroSafeWidget.vue')
    expect(store.activeApproval).toMatchObject({
      tool: 'vibe-apply',
      securityLevel: 'L4_Locked',
      command: 'write packages/client/src/components/generated/PomodoroSafeWidget.vue',
      allowPermanent: false,
    })
    expect(applyVibeWidgetMock).not.toHaveBeenCalled()
  })

  it('blocks unsafe generated component paths before approval or apply', async () => {
    buildVibeWidgetMock.mockResolvedValueOnce({
      ...safeBuild,
      widgetName: 'PomodoroSafeWidget',
      componentPath: '../generated/PomodoroSafeWidget.vue',
    })
    const store = useVibeCodingStore()

    store.start('Build a Pomodoro widget')
    await flushPromises()

    expect(store.status).toBe('failed')
    expect(store.activeStep).toBe(7)
    expect(store.approvalPending).toBe(false)
    expect(store.terminalLines.map(line => line.text)).toEqual(expect.arrayContaining([
      'Unsafe generated component path blocked: ../generated/PomodoroSafeWidget.vue',
      'Pipeline blocked before approval. No disk write was performed.',
    ]))
    expect(applyVibeWidgetMock).not.toHaveBeenCalled()
  })

  it('blocks security scan findings before Step 8 approval and never applies', async () => {
    buildVibeWidgetMock.mockResolvedValueOnce({
      ...safeBuild,
      securityReport: [
        {
          id: 'blocked-eval',
          pattern: 'eval(',
          message: 'Dangerous runtime code execution is not allowed.',
          severity: 'danger',
        },
      ],
      blocked: true,
    })
    const store = useVibeCodingStore()

    store.start('Build a risky widget')
    await flushPromises()

    expect(store.status).toBe('failed')
    expect(store.activeStep).toBe(7)
    expect(store.approvalPending).toBe(false)
    expect(store.securityReport).toHaveLength(1)
    expect(store.terminalLines.some(line =>
      line.source === 'security' &&
      line.tone === 'danger' &&
      line.text.includes('Dangerous runtime code execution'),
    )).toBe(true)
    expect(applyVibeWidgetMock).not.toHaveBeenCalled()
  })

  it('approves only through the safe vibe apply endpoint payload', async () => {
    buildVibeWidgetMock.mockResolvedValueOnce(safeBuild)
    applyVibeWidgetMock.mockResolvedValueOnce({
      ok: true,
      path: 'packages/client/src/components/generated/PomodoroSafeWidget.vue',
      manifestPath: 'packages/client/src/components/generated/PomodoroSafeWidget.manifest.json',
      audit: {
        buildId: 'build-pomodoro',
        widgetName: 'PomodoroSafeWidget',
        path: 'packages/client/src/components/generated/PomodoroSafeWidget.vue',
        manifestPath: 'packages/client/src/components/generated/PomodoroSafeWidget.manifest.json',
        appliedAt: '2026-05-28T12:00:00.000Z',
        securityReport: [],
      },
    })
    const store = useVibeCodingStore()

    store.start('Build a Pomodoro widget')
    await flushPromises()
    store.approve()
    await flushPromises()

    expect(applyVibeWidgetMock).toHaveBeenCalledTimes(1)
    expect(applyVibeWidgetMock).toHaveBeenCalledWith({
      buildId: 'build-pomodoro',
      widgetName: 'PomodoroSafeWidget',
      code: '<template><section>Pomodoro</section></template>',
      spec: 'Build a compact Pomodoro widget.',
    }, expect.any(AbortSignal))
    expect(store.lastStableWidget).toMatchObject({
      widgetName: 'PomodoroSafeWidget',
      componentPath: 'packages/client/src/components/generated/PomodoroSafeWidget.vue',
    })
    expect(store.isVisible).toBe(false)
    expect(store.status).toBe('idle')
    expect(store.deploymentMessage).toBe('Widget deployed successfully to /generated.')
  })

  it('rejects Step 8 approval with a system context message and no apply call', async () => {
    buildVibeWidgetMock.mockResolvedValueOnce(safeBuild)
    const store = useVibeCodingStore()
    const chatStore = useChatStore()

    store.start('Build a Pomodoro widget')
    await flushPromises()
    store.reject()
    await flushPromises()

    expect(applyVibeWidgetMock).not.toHaveBeenCalled()
    expect(store.isVisible).toBe(false)
    expect(chatStore.activeSession?.messages.some(message =>
      message.role === 'system' &&
      message.content === 'System: Tool execution rejected by user.' &&
      message.commandAction === 'vibe.build.rejected',
    )).toBe(true)
  })

  it('cancels in-flight build requests and ignores stale responses', async () => {
    let resolveBuild: (value: VibeBuildResponse) => void = () => {}
    buildVibeWidgetMock.mockImplementationOnce((_intent: string, signal?: AbortSignal) =>
      new Promise<VibeBuildResponse>((resolve, reject) => {
        resolveBuild = resolve
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }),
    )
    const store = useVibeCodingStore()

    store.start('Build a slow widget')
    expect(store.isVisible).toBe(true)
    store.cancel()
    resolveBuild(safeBuild)
    await flushPromises()

    expect(store.isVisible).toBe(false)
    expect(store.status).toBe('idle')
    expect(store.generatedCode).toBe('')
    expect(applyVibeWidgetMock).not.toHaveBeenCalled()
  })
})
