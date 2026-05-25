import { describe, expect, it } from 'vitest'
import { formatActivationKey, parseActivationKey } from './license'

describe('license key', () => {
  it('round-trips activation key', () => {
    const expiresAt = new Date(2026, 11, 31, 12, 0, 0).getTime()
    const key = formatActivationKey(expiresAt)
    expect(key).toMatch(/^UNIONS-\d{8}-[A-F0-9]{4}$/)
    const parsed = parseActivationKey(key)
    expect(parsed).not.toBeNull()
    expect(parsed!.expiresAt).toBeGreaterThan(expiresAt - 86400000)
  })

  it('rejects invalid checksum', () => {
    expect(parseActivationKey('UNIONS-20261231-0000')).toBeNull()
  })
})
