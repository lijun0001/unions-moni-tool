import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPERIENCE_VALID,
  experienceExpiresAtMs,
  formatExperienceValidityLabel,
  normalizeExperienceValid,
  parseExperienceValidFromTokens,
  parseExperienceValidity,
} from './experience-validity'

describe('experience-validity', () => {
  it('parses h/d/m/y', () => {
    expect(parseExperienceValidity('1h')?.spec).toBe('1h')
    expect(parseExperienceValidity('2D')?.spec).toBe('2d')
    expect(parseExperienceValidity('1m')?.unit).toBe('m')
    expect(parseExperienceValidity('1y')?.unit).toBe('y')
    expect(parseExperienceValidity('2y')?.spec).toBe('2y')
    expect(parseExperienceValidity('3\u6708')?.spec).toBe('3m')
    expect(parseExperienceValidity('7\u65e5')?.spec).toBe('7d')
    expect(parseExperienceValidity('2 years')?.spec).toBe('2y')
  })

  it('rejects invalid', () => {
    expect(parseExperienceValidity('1w')).toBeNull()
    expect(parseExperienceValidity('')).toBeNull()
  })

  it('normalizes default', () => {
    expect(normalizeExperienceValid(undefined)).toBe(DEFAULT_EXPERIENCE_VALID)
    expect(normalizeExperienceValid('bad')).toBe(DEFAULT_EXPERIENCE_VALID)
  })

  it('adds duration from base', () => {
    const base = new Date(2025, 0, 1, 12, 0, 0).getTime()
    expect(experienceExpiresAtMs(base, '1h')).toBe(base + 3600000)
    expect(experienceExpiresAtMs(base, '1d')).toBe(base + 86400000)
    const y = new Date(experienceExpiresAtMs(base, '1y'))
    expect(y.getFullYear()).toBe(2026)
  })

  it('formats label', () => {
    expect(formatExperienceValidityLabel('1y')).toContain('1')
  })

  it('parses from argv tokens', () => {
    expect(parseExperienceValidFromTokens(['2', 'y'])).toBe('2y')
    expect(parseExperienceValidFromTokens(['3', '\u6708'])).toBe('3m')
    expect(parseExperienceValidFromTokens(['7', 'day'])).toBe('7d')
    expect(parseExperienceValidFromTokens(['2y'])).toBe('2y')
  })
})
