import { describe, expect, it } from 'vitest'

describe('health guided capture protocols', () => {
  const thrownCode = (operation: () => unknown) => {
    try { operation(); return null } catch (error) { return (error as { code?: string }).code }
  }
  it('publishes deterministic versioned protocols for every guided purpose', async () => {
    const { getHealthCaptureProtocol } = await import('../../packages/server/src/services/hermes/health-loop/capture-protocols')
    const purposes = ['measurement', 'posture', 'skin', 'diet', 'internal_health'] as const
    const protocols = purposes.map(getHealthCaptureProtocol)

    expect(protocols.map(protocol => protocol.purpose)).toEqual(purposes)
    expect(protocols.every(protocol => protocol.schemaVersion === 'health-capture-protocol/v1')).toBe(true)
    expect(protocols.every(protocol => protocol.minimumImageSet >= 1)).toBe(true)
    expect(getHealthCaptureProtocol('posture')).toEqual(getHealthCaptureProtocol('posture'))
    expect(thrownCode(() => getHealthCaptureProtocol('unknown' as 'posture'))).toBe('HEALTH_CAPTURE_INVALID')
  })

  it('accepts the exact posture set and returns stable non-diagnostic quality guidance', async () => {
    const { validateHealthCapture } = await import('../../packages/server/src/services/hermes/health-loop/capture-protocols')
    const capture = {
      schemaVersion: 'health-capture-submission/v1' as const,
      purpose: 'posture' as const,
      lighting: 'neutral_diffuse' as const,
      captures: ['front', 'left_side', 'back'].map((view, index) => ({
        artifactId: `artifact-${String(index + 1).repeat(64)}`,
        view,
        bodyRegion: 'full_body',
        distance: { value: 250, unit: 'cm' as const },
      })),
    }
    expect(validateHealthCapture(capture)).toEqual({
      status: 'accepted', score: 1, reasons: [], recaptureGuidance: [],
    })

    const incomplete = { ...capture, captures: capture.captures.slice(0, 2) }
    expect(validateHealthCapture(incomplete)).toEqual({
      status: 'recapture_required', score: 0, reasons: ['missing_view:back'],
      recaptureGuidance: ['Capture the required back view.'],
    })
    expect(JSON.stringify(validateHealthCapture(incomplete))).not.toMatch(/diagnos|disease|condition/i)
  })

  it('fails closed on unknown keys, wrong units, duplicates, wrong regions, and invalid scale references', async () => {
    const { validateHealthCapture } = await import('../../packages/server/src/services/hermes/health-loop/capture-protocols')
    const base = {
      schemaVersion: 'health-capture-submission/v1' as const,
      purpose: 'measurement' as const,
      lighting: 'neutral_diffuse' as const,
      captures: ['front', 'side'].map((view, index) => ({
        artifactId: `artifact-${String(index + 3).repeat(64)}`,
        view,
        bodyRegion: 'full_body',
        distance: { value: 220, unit: 'cm' as const },
        scaleReference: 'a4_sheet',
      })),
    }
    expect(validateHealthCapture(base).status).toBe('accepted')
    const candidates: unknown[] = [
      { ...base, uploadUrl: 'https://attacker.test' },
      { ...base, captures: base.captures.map(item => ({ ...item, distance: { value: 2.2, unit: 'm' } })) },
      { ...base, captures: [base.captures[0], base.captures[0]] },
      { ...base, captures: base.captures.map(item => ({ ...item, bodyRegion: 'face' })) },
      { ...base, captures: base.captures.map(item => ({ ...item, scaleReference: 'credit_card' })) },
      { ...base, captures: base.captures.map(item => ({ ...item, secret: 'x' })) },
    ]
    for (const candidate of candidates) {
      expect(thrownCode(() => validateHealthCapture(candidate as typeof base))).toBe('HEALTH_CAPTURE_INVALID')
    }
  })

  it('requires exact purpose-specific image sets for skin, diet, and reports', async () => {
    const { validateHealthCapture } = await import('../../packages/server/src/services/hermes/health-loop/capture-protocols')
    const make = (purpose: 'skin' | 'diet' | 'internal_health', view: string, bodyRegion: string, distance: number) => ({
      schemaVersion: 'health-capture-submission/v1' as const,
      purpose,
      lighting: purpose === 'skin' ? 'standardized_neutral' : purpose === 'diet' ? 'natural_even' : 'even_no_glare',
      captures: [{ artifactId: `artifact-${({ skin: 'a', diet: 'b', internal_health: 'c' } as const)[purpose].repeat(64)}`, view, bodyRegion, distance: { value: distance, unit: 'cm' as const } }],
    })
    expect(validateHealthCapture(make('skin', 'close_up', 'face', 40)).status).toBe('accepted')
    expect(validateHealthCapture(make('diet', 'top', 'meal', 50)).status).toBe('accepted')
    expect(validateHealthCapture(make('internal_health', 'page', 'document', 35)).status).toBe('accepted')
    expect(thrownCode(() => validateHealthCapture(make('skin', 'top', 'meal', 40)))).toBe('HEALTH_CAPTURE_INVALID')
  })
})
