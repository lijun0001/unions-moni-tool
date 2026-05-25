import { describe, expect, it } from 'vitest'
import { getDisconnectBlockReason } from './disconnect-guard'

describe('getDisconnectBlockReason', () => {
  it('returns offline reason when pile already offline', () => {
    expect(getDisconnectBlockReason('offline', false)).toBe('设备已断开，无需重复断开')
  })

  it('returns in-progress reason when disconnect is running', () => {
    expect(getDisconnectBlockReason('online', true)).toBe('设备正在断开中，请稍后')
  })

  it('returns null when disconnect should proceed', () => {
    expect(getDisconnectBlockReason('online', false)).toBeNull()
  })
})
