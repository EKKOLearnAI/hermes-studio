import { describe, expect, it } from 'vitest'
import {
  normalizeHexColor,
  normalizeThemeCustomization,
  normalizeThemeFontSize,
  resolveThemeCustomization,
} from '@/styles/theme-customization'
import { getThemeOverrides } from '@/styles/theme'

describe('theme customization', () => {
  it('normalizes persisted values into safe theme settings', () => {
    expect(normalizeThemeFontSize(2)).toBe(12)
    expect(normalizeThemeFontSize(30)).toBe(20)
    expect(normalizeHexColor('#AbC')).toBe('#aabbcc')
    expect(normalizeHexColor('red')).toBeNull()
    expect(normalizeThemeCustomization({
      fontSize: '18',
      textColor: '#123456',
      accentColor: 'invalid',
    })).toEqual({
      fontSize: 18,
      textColor: '#123456',
      accentColor: null,
    })
  })

  it('derives readable semantic colors from user choices', () => {
    const light = resolveThemeCustomization({
      fontSize: 16,
      textColor: '#204060',
      accentColor: '#ffd400',
    }, false)
    const dark = resolveThemeCustomization({
      fontSize: 16,
      textColor: '#d8e8ff',
      accentColor: '#2457ff',
    }, true)

    expect(light).toMatchObject({
      fontSize: 16,
      textPrimary: '#204060',
      textPrimaryRgb: '32, 64, 96',
      textSecondaryRgb: '102, 124, 145',
      textMutedRgb: '141, 157, 173',
      accentPrimary: '#ffd400',
      accentPrimaryRgb: '255, 212, 0',
      textOnAccent: '#1a1a1a',
    })
    expect(dark.textOnAccent).toBe('#ffffff')
    expect(dark.textSecondary).not.toBe(dark.textPrimary)
    expect(dark.accentHover).not.toBe(dark.accentPrimary)
  })

  it('applies custom text and accent colors to input hints and borders', () => {
    const customization = {
      fontSize: 16,
      textColor: '#204060',
      accentColor: '#ffd400',
    }
    const resolved = resolveThemeCustomization(customization, false)
    const input = getThemeOverrides(false, false, customization).Input

    expect(input).toMatchObject({
      textColor: '#204060',
      placeholderColor: resolved.textMuted,
      caretColor: '#204060',
      border: '1px solid rgba(255, 212, 0, 0.18)',
      borderHover: '1px solid rgba(255, 212, 0, 0.32)',
      borderFocus: '1px solid #ffd400',
    })
    expect(getThemeOverrides(false, false, customization).Switch).toMatchObject({
      railColorActive: '#ffd400',
      loadingColor: '#ffd400',
      boxShadowFocus: '0 0 0 2px rgba(255, 212, 0, 0.3)',
    })
    expect(getThemeOverrides(false, false, customization).InternalSelection).toMatchObject({
      textColor: '#204060',
      placeholderColor: resolved.textMuted,
      border: '1px solid rgba(255, 212, 0, 0.18)',
      borderHover: '1px solid rgba(255, 212, 0, 0.32)',
      borderActive: '1px solid #ffd400',
      borderFocus: '1px solid #ffd400',
    })
  })
})
