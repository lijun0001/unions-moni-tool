/**
 * `0x30` BMS/电气过程上报：线格式编码。
 * 当前 V2.24/V2.25 共用同一布局；若某版本字段顺序变化，通过 {@link register030WireEncoder} 登记替代组装器。
 */
import type { JxChargeElectricalSample } from './jx-charge-electrical-model'
import type { JxPileOrder, JxTopologyPile } from './types'
import { WIRE_SCALE } from './jx-wire-scale'

export type Build030WireResult = {
  payload: string
  sample: JxChargeElectricalSample
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

function u16LeHexVoltage01V(volts: number): string {
  const raw = Math.max(0, Math.min(65535, Math.round(volts * WIRE_SCALE.ONE_POINT)))
  return u16LeHex(raw)
}

function u16LeHexCurrent01A(amps: number): string {
  const raw = Math.max(0, Math.min(65535, Math.round(amps * WIRE_SCALE.ONE_POINT)))
  return u16LeHex(raw)
}

function gunIdToGunNoHex(pile: JxTopologyPile, gunId: string): string {
  const idx = pile.guns.findIndex((g) => g.gunId === gunId)
  const gunNo = idx >= 0 ? idx : 0
  return Math.max(0, Math.min(255, gunNo)).toString(16).padStart(2, '0')
}

/** 默认布局（与现有模拟器行为一致）。 */
export function encodeCm30DefaultLayout(ctx: {
  gunNoHex: string
  sample: JxChargeElectricalSample
  workInfoSec: number
}): Build030WireResult {
  const { sample, workInfoSec } = ctx
  const bcsMode = '01'
  const maxCellV = 'b0'
  const maxCellNo = '01'
  const bmsSoc = Math.max(0, Math.min(100, Math.round(sample.soc))).toString(16).padStart(2, '0')
  const remainMin = Math.max(1, Math.round((100 - sample.soc) * 1.6))
  const bsmGroup = '01'
  const bsmMaxTemp = '32'
  const bsmMaxTempNo = '01'
  const bsmMinTemp = '2e'
  const bsmMinTempNo = '02'
  const warnBits = '00'
  const busV = u16LeHexVoltage01V(sample.pileVoltageV)
  const busI = u16LeHexCurrent01A(sample.pileCurrentA)
  const accMin = u16LeHex(
    Math.min(65535, Math.max(1, Math.round((sample.tick * Math.max(1, workInfoSec)) / 60))),
  )
  const chargeKwh = u32LeHex(Math.max(1, Math.round(sample.energyKwh * WIRE_SCALE.FOUR_POINT)))
  const payload = `${makeTimeTag6Hex()}${ctx.gunNoHex}${u16LeHexVoltage01V(sample.bclVoltageV)}${u16LeHexCurrent01A(sample.bclCurrentA)}${bcsMode}${u16LeHexVoltage01V(sample.bcsVoltageV)}${u16LeHexCurrent01A(sample.bcsCurrentA)}${maxCellV}${maxCellNo}${bmsSoc}${u16LeHex(remainMin)}${bsmGroup}${bsmMaxTemp}${bsmMaxTempNo}${bsmMinTemp}${bsmMinTempNo}${warnBits}${warnBits}${warnBits}${warnBits}${warnBits}${busV}${busI}${accMin}${chargeKwh}`
  return { payload, sample }
}

const registry030 = new Map<string, typeof encodeCm30DefaultLayout>()

export function register030WireEncoder(protocolIdPattern: string, encoder: typeof encodeCm30DefaultLayout): void {
  registry030.set(protocolIdPattern.toLowerCase(), encoder)
}

register030WireEncoder('default', encodeCm30DefaultLayout)

export function resolve030WireAdapter(protocolId: string | undefined): typeof encodeCm30DefaultLayout {
  if (!protocolId) return encodeCm30DefaultLayout
  const id = protocolId.toLowerCase()
  if (registry030.has(id)) return registry030.get(id)!
  for (const [key, enc] of registry030) {
    if (key !== 'default' && id.includes(key)) return enc
  }
  return encodeCm30DefaultLayout
}

export function build030PayloadWire(
  order: JxPileOrder,
  sample: JxChargeElectricalSample,
  pile: JxTopologyPile,
  workInfoSec: number,
): Build030WireResult {
  const encoder = resolve030WireAdapter(pile.protocolId)
  const gunNoHex = gunIdToGunNoHex(pile, order.gunId)
  return encoder({ gunNoHex, sample, workInfoSec })
}
