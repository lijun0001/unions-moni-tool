import { describe, expect, it } from 'vitest'
import {
  buildTariffPeriodWindows,
  mergeChargingPeriodEnergySegments,
  normalizeTariffPeriods,
  splitOrderEnergyByTariffPeriods,
  type OrderPeriodEnergySegment,
} from './jx-order-period-split'

function ms(y: number, m: number, d: number, H: number, M: number, S = 0): number {
  return new Date(y, m - 1, d, H, M, S, 0).getTime()
}

describe('splitOrderEnergyByTariffPeriods', () => {
  const periods = [
    { index: 1, startHour: 0, startMinute: 0, electricRate: 0.5, serviceRate: 0.1 },
    { index: 2, startHour: 8, startMinute: 0, electricRate: 1.0, serviceRate: 0.2 },
    { index: 3, startHour: 18, startMinute: 0, electricRate: 0.8, serviceRate: 0.15 },
  ]

  it('splits at tariff boundary when charging crosses 08:00', () => {
    const start = ms(2026, 6, 10, 7, 30)
    const end = ms(2026, 6, 10, 9, 0)
    const segs = splitOrderEnergyByTariffPeriods({
      periods,
      chargeStartMs: start,
      chargeEndMs: end,
      totalEnergyKwh: 9,
    })
    expect(segs).toHaveLength(2)
    expect(segs[0]?.startTime).toContain('07:30')
    expect(segs[0]?.endTime).toContain('08:00')
    expect(segs[0]?.modelIndex).toBe(0)
    expect(segs[1]?.startTime).toContain('08:00')
    expect(segs[1]?.endTime).toContain('09:00')
    expect(segs[1]?.modelIndex).toBe(1)
    const sum = segs.reduce((s, x) => s + x.energyKwh, 0)
    expect(sum).toBeCloseTo(9, 3)
    expect(segs[0]!.energyKwh).toBeCloseTo(3, 1)
    expect(segs[1]!.energyKwh).toBeCloseTo(6, 1)
  })

  it('first segment starts at order start when inside single period', () => {
    const start = ms(2026, 6, 10, 10, 0)
    const end = ms(2026, 6, 10, 11, 0)
    const segs = splitOrderEnergyByTariffPeriods({
      periods,
      chargeStartMs: start,
      chargeEndMs: end,
      totalEnergyKwh: 5,
    })
    expect(segs).toHaveLength(1)
    expect(segs[0]?.startTime).toContain('10:00')
    expect(segs[0]?.endTime).toContain('11:00')
    expect(segs[0]?.energyKwh).toBe(5)
  })

  it('buildTariffPeriodWindows crosses midnight into next period', () => {
    const sorted = normalizeTariffPeriods(periods)
    const start = ms(2026, 6, 10, 17, 0)
    const end = ms(2026, 6, 11, 9, 0)
    const wins = buildTariffPeriodWindows(sorted, start, end)
    expect(wins.length).toBeGreaterThanOrEqual(3)
    expect(wins[0]?.startMs).toBe(start)
    expect(wins[wins.length - 1]?.endMs).toBe(end)
  })
})

describe('mergeChargingPeriodEnergySegments', () => {
  const periods = [
    { index: 1, startHour: 0, startMinute: 0, electricRate: 0.5, serviceRate: 0.1 },
    { index: 2, startHour: 8, startMinute: 0, electricRate: 1.0, serviceRate: 0.2 },
  ]

  function splitAt(start: number, end: number, kwh: number): OrderPeriodEnergySegment[] {
    return splitOrderEnergyByTariffPeriods({
      periods,
      chargeStartMs: start,
      chargeEndMs: end,
      totalEnergyKwh: kwh,
    })
  }

  it('keeps finalized segments and only extends last segment end time within same period', () => {
    const start = ms(2026, 6, 10, 10, 0)
    const tick1 = splitAt(start, ms(2026, 6, 10, 10, 30), 3)
    const tick2 = splitAt(start, ms(2026, 6, 10, 10, 45), 5)
    const merged = mergeChargingPeriodEnergySegments(tick1, tick2)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.startTime).toContain('10:00')
    expect(merged[0]?.endTime).toContain('10:45')
    expect(merged[0]?.energyKwh).toBe(5)
  })

  it('appends new segment when crossing tariff boundary without dropping earlier segments', () => {
    const start = ms(2026, 6, 10, 7, 30)
    const beforeCross = splitAt(start, ms(2026, 6, 10, 7, 50), 2)
    const afterCross = splitAt(start, ms(2026, 6, 10, 8, 20), 5)
    const merged = mergeChargingPeriodEnergySegments(beforeCross, afterCross)
    expect(merged).toHaveLength(2)
    expect(merged[0]?.startTime).toContain('07:30')
    expect(merged[0]?.endTime).toContain('08:00')
    expect(merged[1]?.startTime).toContain('08:00')
    expect(merged[1]?.endTime).toContain('08:20')
    expect(merged.reduce((s, x) => s + x.energyKwh, 0)).toBeCloseTo(5, 3)
  })

  it('never drops segments when fresh split temporarily has fewer windows', () => {
    const start = ms(2026, 6, 10, 7, 30)
    const twoSeg = splitAt(start, ms(2026, 6, 10, 8, 30), 6)
    const oneSeg = splitAt(start, ms(2026, 6, 10, 7, 45), 2)
    const merged = mergeChargingPeriodEnergySegments(twoSeg, oneSeg)
    expect(merged).toHaveLength(2)
    expect(merged[0]?.endTime).toContain('08:00')
  })
})
