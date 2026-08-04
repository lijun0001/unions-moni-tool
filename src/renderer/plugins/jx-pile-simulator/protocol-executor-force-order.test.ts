import { describe, expect, it } from 'vitest'
import { isGunOrderLiveSession } from './protocol-executor'

describe('isGunOrderLiveSession', () => {
  it('matches when pending order equals and timer active', () => {
    expect(isGunOrderLiveSession('ORD-1', 'ORD-1', true, 'idle', 'starting')).toBe(true)
  })

  it('matches when pending order equals and gun charging', () => {
    expect(isGunOrderLiveSession('ORD-1', 'ORD-1', false, 'charging', 'charging')).toBe(true)
  })

  it('matches pending starting/start-accepted while waiting 0x22', () => {
    expect(isGunOrderLiveSession('ORD-1', 'ORD-1', false, 'linked', 'starting')).toBe(true)
    expect(isGunOrderLiveSession('ORD-1', 'ORD-1', false, 'linked', 'start-accepted')).toBe(true)
  })

  it('rejects when pending order differs', () => {
    expect(isGunOrderLiveSession('ORD-2', 'ORD-1', true, 'charging', 'charging')).toBe(false)
  })

  it('matches charging order+gun even without pending (e.g. after reload)', () => {
    expect(isGunOrderLiveSession('ORD-1', undefined, false, 'charging', 'charging')).toBe(true)
  })

  it('matches charging order with timer even if gun status stale', () => {
    expect(isGunOrderLiveSession('ORD-1', undefined, true, 'linked', 'charging')).toBe(true)
  })

  it('rejects idle order without pending', () => {
    expect(isGunOrderLiveSession('ORD-1', undefined, false, 'linked', 'stopped')).toBe(false)
  })
})
