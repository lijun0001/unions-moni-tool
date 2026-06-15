/**
 * `0x25` 充电工作信息：线格式编码（与平台 `CM25Data222` + `WorkInfoHandler224` 对齐）。
 * 语义层（kWh、元、秒）→ 小端整数的换算使用与 Java `CovertConst` 一致的标尺。
 * 不同 `protocolId` 可通过 {@link resolve025WireAdapter} 选用不同组装器；当前 V2.24/V2.25 共用同一套 `CM25Data222` 布局。
 */
import type { JxChargeElectricalSample } from './jx-charge-electrical-model'
import type { JxPileOrder, JxTopologyPile } from './types'
import {
  makeTimeTag6HexFromMs,
  mergeChargingPeriodEnergySegments,
  periodSegmentToLatest25View,
  periodsFromOrderTariff,
  splitOrderEnergyByTariffPeriods,
  type OrderPeriodEnergySegment,
} from './jx-order-period-split'
import { WIRE_SCALE } from './jx-wire-scale'

export { WIRE_SCALE } from './jx-wire-scale'

export type Build025WireResult = {
  payload: string
  snapshot: NonNullable<JxPileOrder['latest25']>
  periodEnergySegments: OrderPeriodEnergySegment[]
}

function timeByteHex(n: number): string {
  const v = Math.max(0, Math.min(255, Math.trunc(n)))
  return v.toString(16).padStart(2, '0')
}

function makeTimeTag6Hex(t = new Date()): string {
  const beijing = new Date(t.getTime() + 8 * 60 * 60 * 1000)
  const yy = beijing.getUTCFullYear() % 100
  const mm = beijing.getUTCMonth() + 1
  const dd = beijing.getUTCDate()
  const HH = beijing.getUTCHours()
  const MM = beijing.getUTCMinutes()
  const SS = beijing.getUTCSeconds()
  return [yy, mm, dd, HH, MM, SS].map((x) => timeByteHex(x)).join('')
}

function asciiFixedHex(text: string, len: number): string {
  const bytes = new Array<number>(len).fill(0x00)
  for (let i = 0; i < len; i += 1) {
    const ch = text.charCodeAt(i)
    if (!Number.isNaN(ch) && ch > 0) bytes[i] = ch & 0xff
  }
  return bytes.map((x) => x.toString(16).padStart(2, '0')).join('')
}

function u16LeHex(n: number): string {
  const v = n & 0xffff
  return [v & 0xff, (v >> 8) & 0xff].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function u32LeHex(n: number): string {
  const v = n >>> 0
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

/** 协议 0.1V / LSB（`short chargerVoltage` × ONE_POINT） */
function u16LeHexVoltage01V(volts: number): string {
  const raw = Math.max(0, Math.min(65535, Math.round(volts * WIRE_SCALE.ONE_POINT)))
  return u16LeHex(raw)
}

/** 协议 0.1A / LSB */
function u16LeHexCurrent01A(amps: number): string {
  const raw = Math.max(0, Math.min(65535, Math.round(amps * WIRE_SCALE.ONE_POINT)))
  return u16LeHex(raw)
}

function decodeTimeTag6(timeHex: string): string {
  const h = timeHex.replace(/[^0-9a-f]/gi, '').toUpperCase()
  if (h.length !== 12) return ''
  const parts: string[] = []
  for (let i = 0; i < 6; i += 1) {
    const b = h.slice(i * 2, i * 2 + 2)
    parts.push(Number.parseInt(b, 16).toString().padStart(2, '0'))
  }
  return `20${parts[0]}-${parts[1]}-${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`
}

function decodeU32Le(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 8) return 0
  const b0 = Number.parseInt(h.slice(0, 2), 16)
  const b1 = Number.parseInt(h.slice(2, 4), 16)
  const b2 = Number.parseInt(h.slice(4, 6), 16)
  const b3 = Number.parseInt(h.slice(6, 8), 16)
  return ((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0
}

function periodsForOrder25(order: JxPileOrder) {
  return periodsFromOrderTariff(order)
}

function gunIdToGunNoHex(pile: JxTopologyPile, gunId: string): string {
  const idx = pile.guns.findIndex((g) => g.gunId === gunId)
  const gunNo = idx >= 0 ? idx : 0
  return Math.max(0, Math.min(255, gunNo)).toString(16).padStart(2, '0')
}

/**
 * `CM25Data222` 固定前缀 + `count`×32 字节段（与反射字段顺序一致）。
 * 线整数：`elect`/段电量 → FOUR_POINT kWh；金额类 → TWO_POINT 元；电压电流 → ONE_POINT。
 */
export function encodeCm25Data222Layout(ctx: {
  gunNoHex: string
  pileVoltageV: number
  pileCurrentA: number
  energyKwh: number
  durationSec: number
  amountYuan: number
  moduleCount: number
  electricFeeYuan: number
  serviceFeeYuan: number
  orderNo: string
  accountBalanceYuan: number
  segments: Array<{
    modelIndex: number
    segStartHex: string
    segEndHex: string
    electricPrice: number
    servicePrice: number
    segmentEnergyKwh: number
    segmentElectricFeeYuan: number
    segmentServiceFeeYuan: number
    displayStartTime: string
    displayEndTime: string
  }>
}): { payload: string; snapshot: Build025WireResult['snapshot'] } {
  const voltage = u16LeHexVoltage01V(ctx.pileVoltageV)
  const current = u16LeHexCurrent01A(ctx.pileCurrentA)
  const energy = u32LeHex(Math.max(1, Math.round(ctx.energyKwh * WIRE_SCALE.FOUR_POINT)))
  const duration = u32LeHex(Math.max(1, Math.round(ctx.durationSec)))
  const amount = u32LeHex(Math.max(1, Math.round(ctx.amountYuan * WIRE_SCALE.TWO_POINT)))
  const moduleCount = Math.max(1, Math.min(255, ctx.moduleCount)).toString(16).padStart(2, '0')
  const eleAmount = u32LeHex(Math.max(1, Math.round(ctx.electricFeeYuan * WIRE_SCALE.TWO_POINT)))
  const svcAmount = u32LeHex(Math.max(1, Math.round(ctx.serviceFeeYuan * WIRE_SCALE.TWO_POINT)))
  const orderNo = asciiFixedHex(ctx.orderNo, 32)
  const balance = u32LeHex(Math.max(0, Math.min(0xffffffff, Math.round(ctx.accountBalanceYuan * WIRE_SCALE.TWO_POINT))))
  const segList = ctx.segments
  const segCount = Math.max(1, Math.min(255, segList.length)).toString(16).padStart(2, '0')

  let segHex = ''
  const snapshotSegments: NonNullable<JxPileOrder['latest25']>['segments'] = []
  for (const seg of segList) {
    const segElePrice = u32LeHex(Math.max(0, Math.round(seg.electricPrice * WIRE_SCALE.FOUR_POINT)))
    const segSvcPrice = u32LeHex(Math.max(0, Math.round(seg.servicePrice * WIRE_SCALE.FOUR_POINT)))
    const segEnergy = u32LeHex(Math.max(1, Math.round(seg.segmentEnergyKwh * WIRE_SCALE.FOUR_POINT)))
    const segEleFee = u32LeHex(Math.max(1, Math.round(seg.segmentElectricFeeYuan * WIRE_SCALE.TWO_POINT)))
    const segSvcFee = u32LeHex(Math.max(1, Math.round(seg.segmentServiceFeeYuan * WIRE_SCALE.TWO_POINT)))
    segHex += `${seg.segStartHex}${seg.segEndHex}${segElePrice}${segSvcPrice}${segEnergy}${segEleFee}${segSvcFee}`
    snapshotSegments.push({
      modelIndex: seg.modelIndex,
      startTime: seg.displayStartTime,
      endTime: seg.displayEndTime,
      electricPrice: decodeU32Le(segElePrice) / WIRE_SCALE.FOUR_POINT,
      servicePrice: decodeU32Le(segSvcPrice) / WIRE_SCALE.FOUR_POINT,
      energyKwh: decodeU32Le(segEnergy) / WIRE_SCALE.FOUR_POINT,
      electricFeeYuan: decodeU32Le(segEleFee) / WIRE_SCALE.TWO_POINT,
      serviceFeeYuan: decodeU32Le(segSvcFee) / WIRE_SCALE.TWO_POINT,
    })
  }

  const payload = `${makeTimeTag6Hex()}${ctx.gunNoHex}${voltage}${current}${energy}${duration}${amount}${moduleCount}${eleAmount}${svcAmount}${orderNo}${balance}${segCount}${segHex}`

  return {
    payload,
    snapshot: {
      chargeEnergyKwh: ctx.energyKwh,
      chargeAmountYuan: ctx.amountYuan,
      electricFeeYuan: ctx.electricFeeYuan,
      serviceFeeYuan: ctx.serviceFeeYuan,
      accountBalanceYuan: ctx.accountBalanceYuan,
      segments: snapshotSegments,
    },
  }
}

/** 登记不同协议版本的 `0x25` 组装器；默认同 `CM25Data222`。 */
const registry025 = new Map<string, typeof encodeCm25Data222Layout>()

export function register025WireEncoder(protocolIdPattern: string, encoder: typeof encodeCm25Data222Layout): void {
  registry025.set(protocolIdPattern.toLowerCase(), encoder)
}

register025WireEncoder('default', encodeCm25Data222Layout)

export function resolve025WireAdapter(protocolId: string | undefined): typeof encodeCm25Data222Layout {
  if (!protocolId) return encodeCm25Data222Layout
  const id = protocolId.toLowerCase()
  if (registry025.has(id)) return registry025.get(id)!
  for (const [key, enc] of registry025) {
    if (key !== 'default' && id.includes(key)) return enc
  }
  return encodeCm25Data222Layout
}

export function build025PayloadWire(
  order: JxPileOrder,
  sample: JxChargeElectricalSample,
  workInfoSec: number,
  pile: JxTopologyPile,
): Build025WireResult {
  const encoder = resolve025WireAdapter(pile.protocolId)
  const gunNoHex = gunIdToGunNoHex(pile, order.gunId)
  const energyKwh = Math.max(0, sample.energyKwh)
  const durationSec = Math.max(1, Math.round(sample.tick * Math.max(1, workInfoSec)))
  const chargeEndMs = Date.now()
  const chargeStartMs = order.startAt > 0 ? order.startAt : chargeEndMs - durationSec * 1000

  const freshSplit = splitOrderEnergyByTariffPeriods({
    periods: periodsForOrder25(order),
    chargeStartMs,
    chargeEndMs,
    totalEnergyKwh: energyKwh,
  })

  const mergedSegments = mergeChargingPeriodEnergySegments(order.periodEnergySegments ?? [], freshSplit)

  const electricFeeYuan = mergedSegments.reduce((s, x) => s + x.electricFeeYuan, 0)
  const serviceFeeYuan = mergedSegments.reduce((s, x) => s + x.serviceFeeYuan, 0)
  const amountYuan = Math.max(0.01, electricFeeYuan + serviceFeeYuan)

  const targetAmountYuan =
    order.request23?.controlMode === 3 ? Math.max(0, (order.request23?.controlParam ?? 0) * 0.01) : 0
  const initialBalanceYuan = (order.request23?.accountBalanceFen ?? 500000) / 100
  const accountBalanceYuan =
    targetAmountYuan > 0 ? Math.max(0, targetAmountYuan - amountYuan) : Math.max(0, initialBalanceYuan - amountYuan)

  const wireSegments =
    mergedSegments.length > 0
      ? mergedSegments.map((seg) => ({
          modelIndex: seg.modelIndex,
          segStartHex: makeTimeTag6HexFromMs(seg.startMs),
          segEndHex: makeTimeTag6HexFromMs(seg.endMs),
          electricPrice: seg.electricRate,
          servicePrice: seg.serviceRate,
          segmentEnergyKwh: seg.energyKwh,
          segmentElectricFeeYuan: seg.electricFeeYuan,
          segmentServiceFeeYuan: seg.serviceFeeYuan,
          displayStartTime: seg.startTime,
          displayEndTime: seg.endTime,
        }))
      : [
          {
            modelIndex: 0,
            segStartHex: makeTimeTag6HexFromMs(chargeStartMs),
            segEndHex: makeTimeTag6HexFromMs(chargeEndMs),
            electricPrice: 0.8,
            servicePrice: 0.2,
            segmentEnergyKwh: energyKwh,
            segmentElectricFeeYuan: roundMoney(energyKwh * 0.8),
            segmentServiceFeeYuan: roundMoney(energyKwh * 0.2),
            displayStartTime: decodeTimeTag6(makeTimeTag6HexFromMs(chargeStartMs)),
            displayEndTime: decodeTimeTag6(makeTimeTag6HexFromMs(chargeEndMs)),
          },
        ]

  const { payload, snapshot } = encoder({
    gunNoHex,
    pileVoltageV: sample.pileVoltageV,
    pileCurrentA: sample.pileCurrentA,
    energyKwh,
    durationSec,
    amountYuan,
    moduleCount: 1,
    electricFeeYuan,
    serviceFeeYuan,
    orderNo: order.orderNo,
    accountBalanceYuan,
    segments: wireSegments,
  })

  return {
    payload,
    snapshot: {
      ...snapshot,
      segments: mergedSegments.map(periodSegmentToLatest25View),
    },
    periodEnergySegments: mergedSegments,
  }
}

function roundMoney(y: number): number {
  return Math.round(y * WIRE_SCALE.TWO_POINT) / WIRE_SCALE.TWO_POINT
}
