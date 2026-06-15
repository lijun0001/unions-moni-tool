import { describe, expect, it } from 'vitest'
import { isGunOrderLiveSession } from './protocol-executor'

describe('isGunOrderLiveSession', () => {
  it('matches when pending order equals and timer active', () => {
    expect(isGunOrderLiveSession('ORD-1', 'ORD-1', true, 'idle')).toBe(true)
  })

  it('matches when pending order equals and gun charging', () => {
    expect(isGunOrderLiveSession('ORD-1', 'ORD-1', false, 'charging')).toBe(true)
  })

  it('rejects when pending order differs', () => {
    expect(isGunOrderLiveSession('ORD-2', 'ORD-1', true, 'charging')).toBe(false)
  })

  it('rejects stale charging status without pending/timer', () => {
    expect(isGunOrderLiveSession('ORD-1', undefined, false, 'charging')).toBe(false)
  })
})
