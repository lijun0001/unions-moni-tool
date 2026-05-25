import { describe, expect, it, vi } from 'vitest'
import { makeLoginPayloadStrict } from './protocol-executor'

describe('makeLoginPayloadStrict', () => {
  it('uses sample fields and injects configured periods', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-29T03:04:15.000Z'))

    const payload = makeLoginPayloadStrict(5, 20, 9, 10, 37, 1)

    expect(payload.startsWith('1a041d0b040f')).toBe(true)
    expect(payload.includes('41494f44433250314256393030000000')).toBe(true)
    expect(payload.includes('014202440000000006280a01000000001a040902230b0f')).toBe(true)
    expect(payload.includes('05001409000a0025000e000f000000')).toBe(true)
    expect(payload.endsWith('0000000000000000000000000000000000000000000000000000000000')).toBe(true)
    vi.useRealTimers()
  })

  it('writes tariff model version into 0x03 payload', () => {
    const payload = makeLoginPayloadStrict(5, 20, 9, 10, 37, 0x12345678)
    expect(payload.includes('78563412')).toBe(true)
  })
})
