/**
 * 按订单副本费率时段切分充电区间与电量（0x25 / 0x23 共用）。
 *
 * 规则：
 * - 首段开始时间 = 充电开始时间；
 * - 首段结束 = 当前费率区间结束（下一时段起点）或订单结束；
 * - 后续各段开始 = 费率时段起点，结束 = 下一时段起点或订单结束；
 * - 末段结束 = 订单结束时间；
 * - 电量按各段时长占比分配总电量。
 */
import type { JxOrderTariffSnapshot, JxPileOrder } from './types'
import { WIRE_SCALE } from './jx-wire-scale'

export type OrderTariffPeriodInput = {
  index?: number
  startHour: number
  startMinute: number
  electricRate: number
  serviceRate: number
}

export type OrderPeriodEnergySegment = {
  modelIndex: number
  startMs: number
  endMs: number
  startTime: string
  endTime: string
  electricRate: number
  serviceRate: number
  energyKwh: number
  electricFeeYuan: number
  serviceFeeYuan: number
}

type NormalizedPeriod = {
  modelIndex: number
  startHour: number
  startMinute: number
  electricRate: number
  serviceRate: number
  startMinutes: number
}

const MS_DAY = 86_400_000

function timeByteHex(n: number): string {
  const v = Math.max(0, Math.min(255, Math.trunc(n)))
  return v.toString(16).padStart(2, '0')
}

/** 北京时间 6 字节时间标识（与 0x25/0x23 线格式一致） */
export function makeTimeTag6HexFromMs(ms: number): string {
  const beijing = new Date(ms + 8 * 60 * 60 * 1000)
  const yy = beijing.getUTCFullYear() % 100
  const mm = beijing.getUTCMonth() + 1
  const dd = beijing.getUTCDate()
  const HH = beijing.getUTCHours()
  const MM = beijing.getUTCMinutes()
  const SS = beijing.getUTCSeconds()
  return [yy, mm, dd, HH, MM, SS].map((x) => timeByteHex(x)).join('')
}

export function decodeTimeTag6FromHex(timeHex: string): string {
  const h = timeHex.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (h.length !== 12) return ''
  const parts: string[] = []
  for (let i = 0; i < 6; i += 1) {
    const b = h.slice(i * 2, i * 2 + 2)
    parts.push(Number.parseInt(b, 16).toString().padStart(2, '0'))
  }
  return `20${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`
}

function formatDisplayTime(ms: number): string {
  return decodeTimeTag6FromHex(makeTimeTag6HexFromMs(ms))
}

function roundMoney(y: number): number {
  return Math.round(y * WIRE_SCALE.TWO_POINT) / WIRE_SCALE.TWO_POINT
}

function roundEnergy(kwh: number): number {
  return Math.round(kwh * WIRE_SCALE.FOUR_POINT) / WIRE_SCALE.FOUR_POINT
}

export function normalizeTariffPeriods(periods: OrderTariffPeriodInput[]): NormalizedPeriod[] {
  return [...periods]
    .map((p, idx) => ({
      modelIndex: typeof p.index === 'number' ? Math.max(0, p.index - 1) : idx,
      startHour: p.startHour,
      startMinute: p.startMinute,
      electricRate: p.electricRate,
      serviceRate: p.serviceRate,
      startMinutes: p.startHour * 60 + p.startMinute,
    }))
    .sort((a, b) => a.startMinutes - b.startMinutes)
}

function findSortedPeriodIndex(sorted: NormalizedPeriod[], t: Date): number {
  const mins = t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60 + t.getMilliseconds() / 60_000
  let idx = sorted.length - 1
  for (let i = 0; i < sorted.length; i += 1) {
    if (mins >= sorted[i].startMinutes) idx = i
    else break
  }
  return idx
}

function nextPeriodBoundaryAfter(t: Date, sorted: NormalizedPeriod[]): Date {
  const candidates: number[] = []
  const day0 = new Date(t)
  day0.setHours(0, 0, 0, 0)
  for (let d = 0; d <= 2; d += 1) {
    const midnight = new Date(day0.getTime() + d * MS_DAY)
    for (const p of sorted) {
      const ps = new Date(midnight)
      ps.setHours(p.startHour, p.startMinute, 0, 0)
      if (ps.getTime() > t.getTime()) candidates.push(ps.getTime())
    }
  }
  if (candidates.length === 0) return new Date(t.getTime() + MS_DAY)
  return new Date(Math.min(...candidates))
}

/** 按费率区间切分充电时间窗（不含电量） */
export function buildTariffPeriodWindows(
  sorted: NormalizedPeriod[],
  chargeStartMs: number,
  chargeEndMs: number,
): Array<{
  modelIndex: number
  startMs: number
  endMs: number
  electricRate: number
  serviceRate: number
}> {
  if (sorted.length === 0 || chargeEndMs <= chargeStartMs) return []

  const windows: Array<{
    modelIndex: number
    startMs: number
    endMs: number
    electricRate: number
    serviceRate: number
  }> = []

  let cursor = chargeStartMs
  const end = chargeEndMs
  let guard = 0

  while (cursor < end && guard < 500) {
    guard += 1
    const period = sorted[findSortedPeriodIndex(sorted, new Date(cursor))]!
    const segStartMs = cursor
    const nextBound = nextPeriodBoundaryAfter(new Date(segStartMs), sorted)
    const segEndMs = Math.min(end, nextBound.getTime())
    if (segEndMs <= segStartMs) break

    windows.push({
      modelIndex: period.modelIndex,
      startMs: segStartMs,
      endMs: segEndMs,
      electricRate: period.electricRate,
      serviceRate: period.serviceRate,
    })
    cursor = segEndMs
  }

  return windows
}

export function splitOrderEnergyByTariffPeriods(params: {
  periods: OrderTariffPeriodInput[]
  chargeStartMs: number
  chargeEndMs: number
  totalEnergyKwh: number
}): OrderPeriodEnergySegment[] {
  const { chargeStartMs, chargeEndMs, totalEnergyKwh } = params
  if (totalEnergyKwh <= 0 || chargeEndMs <= chargeStartMs) return []

  const sorted = normalizeTariffPeriods(params.periods)
  if (sorted.length === 0) return []

  const windows = buildTariffPeriodWindows(sorted, chargeStartMs, chargeEndMs)
  if (windows.length === 0) return []

  const totalDur = windows.reduce((s, w) => s + (w.endMs - w.startMs), 0)
  if (totalDur <= 0) return []

  let allocated = 0
  const segments: OrderPeriodEnergySegment[] = []

  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i]!
    const dur = w.endMs - w.startMs
    let energy =
      i === windows.length - 1 ? totalEnergyKwh - allocated : (totalEnergyKwh * dur) / totalDur
    energy = roundEnergy(Math.max(0, energy))
    allocated += energy

    segments.push({
      modelIndex: w.modelIndex,
      startMs: w.startMs,
      endMs: w.endMs,
      startTime: formatDisplayTime(w.startMs),
      endTime: formatDisplayTime(w.endMs),
      electricRate: w.electricRate,
      serviceRate: w.serviceRate,
      energyKwh: energy,
      electricFeeYuan: roundMoney(energy * w.electricRate),
      serviceFeeYuan: roundMoney(energy * w.serviceRate),
    })
  }

  return segments.filter((s) => s.endMs > s.startMs)
}

function clonePeriodSegment(seg: OrderPeriodEnergySegment): OrderPeriodEnergySegment {
  return { ...seg }
}

/** 更新末段结束时间与电量；跨时段时固化上一段并追加新段，已保存段不删除 */
export function mergeChargingPeriodEnergySegments(
  existing: OrderPeriodEnergySegment[],
  fresh: OrderPeriodEnergySegment[],
): OrderPeriodEnergySegment[] {
  if (fresh.length === 0) return existing.map(clonePeriodSegment)
  if (existing.length === 0) return fresh.map(clonePeriodSegment)

  if (fresh.length < existing.length) return existing.map(clonePeriodSegment)

  const patchTail = (prev: OrderPeriodEnergySegment, next: OrderPeriodEnergySegment): OrderPeriodEnergySegment => ({
    ...prev,
    endMs: next.endMs,
    endTime: next.endTime,
    energyKwh: next.energyKwh,
    electricFeeYuan: next.electricFeeYuan,
    serviceFeeYuan: next.serviceFeeYuan,
  })

  if (fresh.length === existing.length) {
    const head = existing.slice(0, -1).map(clonePeriodSegment)
    const last = patchTail(existing[existing.length - 1]!, fresh[fresh.length - 1]!)
    return [...head, last]
  }

  const head = existing.length > 1 ? existing.slice(0, -1).map(clonePeriodSegment) : []
  const finalized = patchTail(existing[existing.length - 1]!, fresh[existing.length - 1]!)
  const appended = fresh.slice(existing.length).map(clonePeriodSegment)
  return [...head, finalized, ...appended]
}

export function periodSegmentToLatest25View(
  seg: OrderPeriodEnergySegment,
): NonNullable<JxPileOrder['latest25']>['segments'][number] {
  return {
    modelIndex: seg.modelIndex,
    startTime: seg.startTime,
    endTime: seg.endTime,
    electricPrice: seg.electricRate,
    servicePrice: seg.serviceRate,
    energyKwh: seg.energyKwh,
    electricFeeYuan: seg.electricFeeYuan,
    serviceFeeYuan: seg.serviceFeeYuan,
  }
}

export function periodsFromOrderTariff(order: JxPileOrder): OrderTariffPeriodInput[] {
  const snap = order.tariffSnapshot
  if (snap?.periods?.length) {
    return snap.periods.map((p) => ({
      index: p.index,
      startHour: p.startHour,
      startMinute: p.startMinute,
      electricRate: p.electricRate,
      serviceRate: p.serviceRate,
    }))
  }
  return [{ startHour: 0, startMinute: 0, electricRate: 0.8, serviceRate: 0.2 }]
}

export function periodsFromTariffSnapshot(snap: JxOrderTariffSnapshot | undefined | null): OrderTariffPeriodInput[] {
  if (!snap?.periods?.length) {
    return [{ startHour: 0, startMinute: 0, electricRate: 0.8, serviceRate: 0.2 }]
  }
  return snap.periods.map((p) => ({
    index: p.index,
    startHour: p.startHour,
    startMinute: p.startMinute,
    electricRate: p.electricRate,
    serviceRate: p.serviceRate,
  }))
}
