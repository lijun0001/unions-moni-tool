import { describe, expect, it } from 'vitest'
import {
  gunHudShowsLiveCharging,
  pileStatusAfterGunLeaveCharging,
} from './jx-gun-display'

describe('gunHudShowsLiveCharging / pileStatusAfterGunLeaveCharging', () => {
  it('shows live HUD by gun charging even if pile status already idle', () => {
    expect(gunHudShowsLiveCharging({ status: 'idle' }, { status: 'charging' })).toBe(true)
    expect(gunHudShowsLiveCharging({ status: 'charging' }, { status: 'charging' })).toBe(true)
    expect(gunHudShowsLiveCharging({ status: 'charging' }, { status: 'linked' })).toBe(false)
  })

  it('keeps pile charging when another gun is still charging', () => {
    const guns = [
      { gunId: 'A', status: 'charging' },
      { gunId: 'B', status: 'charging' },
    ]
    expect(pileStatusAfterGunLeaveCharging(guns, 'A')).toBe('charging')
    expect(pileStatusAfterGunLeaveCharging(guns, 'B')).toBe('charging')
  })

  it('sets pile idle when the last charging gun stops', () => {
    const guns = [
      { gunId: 'A', status: 'charging' },
      { gunId: 'B', status: 'linked' },
    ]
    expect(pileStatusAfterGunLeaveCharging(guns, 'A')).toBe('idle')
  })
})
