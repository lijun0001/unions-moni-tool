import type { JxFlowTemplate, JxOrderTariffSnapshot, JxPileOrder, JxTopologyPile } from './types'
import { decodeOrder23IntoOut, encodeOrder23Or33Payload } from './jx-order23-wire-map'
import { cm21StartElectKwhFromRaw } from './jx-protocol-profile'
import {
  advanceJxChargeElectricalRuntime,
  createInitialChargeRuntime,
  peekJxChargeElectricalSample,
  type JxChargeElectricalRuntime,
  type JxChargeElectricalSample,
} from './jx-charge-electrical-model'
import { make21Payload } from './jx-wire-021'
import { build025PayloadWire } from './jx-wire-025'
import { build030PayloadWire } from './jx-wire-030'
import { WIRE_SCALE } from './jx-wire-scale'
import { useJxRuntimeLogStore } from './useJxRuntimeLogStore'

export { make21Payload }
import { useJxTopologyStore } from './useJxTopologyStore'
import { useJxOrderStore } from './useJxOrderStore'

export interface ExecuteFlowPayload {
  pileId: string
  flow: JxFlowTemplate
  protocolId: string
  params: Record<string, unknown>
}

type TcpInvokeResult = Record<string, unknown>
type TcpStatusResult = { ok?: boolean; connected?: boolean; error?: unknown }

const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
const teleSignalTimers = new Map<string, ReturnType<typeof setInterval>>()
const telemetryTimers = new Map<string, ReturnType<typeof setInterval>>()
const teleSignalSendQueue = new Map<string, Promise<void>>()
const chargingInfoTimers = new Map<string, ReturnType<typeof setInterval>>()
/** 充电电气状态：与 0x25/0x30/0x0a 共用，键 `${pileId}:${gunId}` */
const chargingRuntimeByKey = new Map<string, JxChargeElectricalRuntime>()
const loginAwaitHeartbeatTimers = new Map<string, ReturnType<typeof setTimeout>>()
const runtimeHeartbeatContext = new Map<
  string,
  {
    hbSec: number
    hbTimeoutCount: number
    teleSignalSec: number
    telemetrySec: number
    workInfoSec: number
    firstHeartbeatReceived: boolean
    lastHeartbeatAt: number
  }
>()
let tcpEventBound = false
let unbindTcpEvent: (() => void) | null = null
const loginPending03State = new Map<string, { waiting04: boolean; restartByTariff: boolean }>()
const DEFAULT_TARIFF_MODEL_VERSION = 1
const pendingStartAck = new Map<string, { orderNo: string; gunId: string; startResult: number }>()

type RemoteStartRuntimeConfig = {
  startResult: 1 | 2
  failReason: number
  chargeModelId: string
  stopAmountThreshold: number
}

export type ScanQrVinStartRuntimeConfig = {
  /** 勾选后强制回复 0x5B 失败，订单标记启动失败并结束流程 */
  simulate5bFail: boolean
  reply5bFailReason: number
}

const remoteStartConfigByPile = new Map<string, RemoteStartRuntimeConfig>()
const scanQrVinStartConfigByPile = new Map<string, ScanQrVinStartRuntimeConfig>()

function fakeHex(cmd: string, direction: 'send' | 'receive'): string {
  const dir = direction === 'send' ? 'AA55' : '55AA'
  return `${dir} ${cmd.replace('0x', '').toUpperCase()} 00 01 02 03`
}

function toHexPairs(hex: string): string {
  return (hex || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase()
    .replace(/(.{2})/g, '$1 ')
    .trim()
}

function buildRawLogText(result: TcpInvokeResult): string {
  const req = toHexPairs(String(result.requestFrameHex ?? ''))
  const resp = toHexPairs(String(result.frameHex ?? ''))
  if (req && resp) return `TX: ${req}\nRX: ${resp}`
  if (req) return `TX: ${req}`
  if (resp) return `RX: ${resp}`
  return ''
}

type HexSegment = { name: string; hex: string; bytes: number }

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

function decodeU16Le(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 4) return 0
  return Number.parseInt(h.slice(0, 2), 16) | (Number.parseInt(h.slice(2, 4), 16) << 8)
}

function decodeU32Be(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 8) return 0
  return Number.parseInt(h.slice(0, 8), 16) >>> 0
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

function decodeU40Le(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 10) return 0
  let out = 0
  for (let i = 0; i < 5; i += 1) {
    out += Number.parseInt(h.slice(i * 2, i * 2 + 2), 16) * (256 ** i)
  }
  return out
}

/** 5 字节小端无符号，与 `decodeU40Le` 对偶，用于 `0x23` 起止电量等 */
function encodeU40Le(n: number): string {
  let v = Math.max(0, Math.min(0xffffffffff, Math.round(n)))
  const bytes: number[] = []
  for (let i = 0; i < 5; i += 1) {
    bytes.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function decodeRate4(hex: string): number {
  return decodeU32Le(hex) / 10000
}

function decodeAsciiFromHex(hexRaw: string): string {
  const hex = (hexRaw ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  let out = ''
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16)
    if (byte === 0x00) break
    out += String.fromCharCode(byte)
  }
  return out
}

type ParsedTariffModel = NonNullable<JxTopologyPile['tariffModel']>

export function parseTariffModelFrom037(dataHexRaw: string): ParsedTariffModel | null {
  const dataHex = (dataHexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (dataHex.length < 22) return null
  let cursor = 0
  const take = (bytes: number): string => {
    const n = Math.max(0, bytes * 2)
    const hex = dataHex.slice(cursor, cursor + n)
    cursor += n
    return hex
  }
  take(6) // timeTag
  const versionHex = take(4)
  const parkingRateHex = take(4)
  const periodCountHex = take(1)
  if (versionHex.length !== 8 || parkingRateHex.length !== 8 || periodCountHex.length !== 2) return null
  const periodCount = Number.parseInt(periodCountHex, 16)
  if (!Number.isFinite(periodCount) || periodCount < 1 || periodCount > 12) return null
  const periods: ParsedTariffModel['periods'] = []
  for (let i = 0; i < periodCount; i += 1) {
    const startHourHex = take(1)
    const startMinuteHex = take(1)
    const typeHex = take(1)
    const electricRateHex = take(4)
    const serviceRateHex = take(4)
    if (
      startHourHex.length !== 2 ||
      startMinuteHex.length !== 2 ||
      typeHex.length !== 2 ||
      electricRateHex.length !== 8 ||
      serviceRateHex.length !== 8
    ) {
      return null
    }
    periods.push({
      index: i + 1,
      startHour: Number.parseInt(startHourHex, 16),
      startMinute: Number.parseInt(startMinuteHex, 16),
      type: Number.parseInt(typeHex, 16),
      electricRate: decodeRate4(electricRateHex),
      serviceRate: decodeRate4(serviceRateHex),
    })
  }
  return {
    version: decodeU32Le(versionHex),
    parkingRate: decodeRate4(parkingRateHex),
    periods,
    updatedAt: Date.now(),
  }
}

/**
 * 解析 `0x1F` 在「计费模型选择=2」后的尾段：版本(4)+停车费率(4)+时段数(1)+N×(时1+分1+类型1+电价4+服务费4)。
 * 与 `0x37` 数据域中版本起的结构一致（无时间标识前缀）。
 */
function parseTariffModelFrom1fTail(tailHexRaw: string): { model: ParsedTariffModel | null; consumedBytes: number } {
  const tailHex = (tailHexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (tailHex.length < 18) return { model: null, consumedBytes: 0 }
  let c = 0
  const take = (bytes: number): string => {
    const s = tailHex.slice(c, c + bytes * 2)
    c += bytes * 2
    return s
  }
  const versionHex = take(4)
  const parkingRateHex = take(4)
  const periodCountHex = take(1)
  if (versionHex.length !== 8 || parkingRateHex.length !== 8 || periodCountHex.length !== 2) {
    return { model: null, consumedBytes: 0 }
  }
  const periodCount = Number.parseInt(periodCountHex, 16)
  if (!Number.isFinite(periodCount) || periodCount < 1 || periodCount > 12) return { model: null, consumedBytes: 0 }
  if (tailHex.length < c + periodCount * 11 * 2) return { model: null, consumedBytes: 0 }
  const periods: ParsedTariffModel['periods'] = []
  for (let i = 0; i < periodCount; i += 1) {
    const startHourHex = take(1)
    const startMinuteHex = take(1)
    const typeHex = take(1)
    const electricRateHex = take(4)
    const serviceRateHex = take(4)
    periods.push({
      index: i + 1,
      startHour: Number.parseInt(startHourHex, 16),
      startMinute: Number.parseInt(startMinuteHex, 16),
      type: Number.parseInt(typeHex, 16),
      electricRate: decodeRate4(electricRateHex),
      serviceRate: decodeRate4(serviceRateHex),
    })
  }
  return {
    model: {
      version: decodeU32Le(versionHex),
      parkingRate: decodeRate4(parkingRateHex),
      periods,
      updatedAt: Date.now(),
    },
    consumedBytes: c / 2,
  }
}

/**
 * 组装上行 `0x20` 数据域（与 `CM20Data218` / `StartRespHandler218` 一致）。
 * 在下行 `0x1F` 数据域基础上 **删除「账户余额」4 字节**；字段顺序为：…控制参数→充电模式→启动方式→定时启动时间→用户操作码→计费模型选择→〔条件费率扩展〕→执行结果→失败原因。
 * **不含** `0x1F` 序号 9「账户余额」；服务端数据类亦无嵌入式计费字节以外的附加字段。
 */
function buildCm20PayloadFrom1f(requestBodyHex: string, result: 1 | 2, failReason: number): string {
  const body = (requestBodyHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const retHex = Math.max(1, Math.min(2, result)).toString(16).padStart(2, '0')
  const failHex = Math.max(0, Math.min(255, failReason)).toString(16).padStart(2, '0')
  const prefixThroughControlParamHex = 174
  if (body.length < prefixThroughControlParamHex + 8) {
    return `${body}${retHex}${failHex}`
  }
  const head = body.slice(0, prefixThroughControlParamHex)
  const tailFromChargeMode = body.slice(prefixThroughControlParamHex + 8)
  if (tailFromChargeMode.length < 30) {
    return `${head}${tailFromChargeMode}${retHex}${failHex}`
  }
  const billingHex = tailFromChargeMode.slice(28, 30)
  const billing = Number.parseInt(billingHex, 16)
  let middle = tailFromChargeMode.slice(0, 30)
  if (billing === 2 && tailFromChargeMode.length > 30) {
    const emb = parseTariffModelFrom1fTail(tailFromChargeMode.slice(30))
    if (emb.consumedBytes > 0) {
      middle = tailFromChargeMode.slice(0, 30 + emb.consumedBytes * 2)
    }
  }
  return `${head}${middle}${retHex}${failHex}`
}

function tariffSnapshotFromPileModel(tm: NonNullable<JxTopologyPile['tariffModel']>): JxOrderTariffSnapshot {
  return {
    version: tm.version,
    parkingRate: tm.parkingRate,
    periods: tm.periods.map((p) => ({ ...p })),
    source: 'pile-0x37',
    updatedAt: tm.updatedAt,
  }
}

function defaultOrderTariffSnapshot(): JxOrderTariffSnapshot {
  return {
    version: DEFAULT_TARIFF_MODEL_VERSION,
    parkingRate: 0,
    periods: [{ index: 1, startHour: 0, startMinute: 0, type: 3, electricRate: 0.8, serviceRate: 0.2 }],
    source: 'pile-0x37',
    updatedAt: Date.now(),
  }
}

function tariffSnapshotForNewOrder(pile: JxTopologyPile, embedded: ParsedTariffModel | null, useEmbedded: boolean): JxOrderTariffSnapshot {
  if (useEmbedded && embedded) {
    return {
      version: embedded.version,
      parkingRate: embedded.parkingRate,
      periods: embedded.periods.map((p) => ({ ...p })),
      source: '0x1f-embedded',
      updatedAt: embedded.updatedAt,
    }
  }
  if (pile.tariffModel && pile.tariffModel.periods.length > 0) return tariffSnapshotFromPileModel(pile.tariffModel)
  return defaultOrderTariffSnapshot()
}

function tariffSnapshotForVin41Order(
  pile: JxTopologyPile,
  embedded: ParsedTariffModel | null,
  billingSel: 1 | 2,
): JxOrderTariffSnapshot {
  if (billingSel === 2 && embedded) {
    return {
      version: embedded.version,
      parkingRate: embedded.parkingRate,
      periods: embedded.periods.map((p) => ({ ...p })),
      source: '0x41-vin-embedded',
      updatedAt: embedded.updatedAt,
    }
  }
  if (pile.tariffModel && pile.tariffModel.periods.length > 0) {
    const t = tariffSnapshotFromPileModel(pile.tariffModel)
    return { ...t, source: '0x41-vin-local' }
  }
  const d = defaultOrderTariffSnapshot()
  return { ...d, source: '0x41-vin-local' }
}

/** 本地 VIN 流程订单号：`VIN` + 20 位十进制数字（密码学随机或时间戳回退，实践中唯一） */
function generateVinLedOrderNo(): string {
  let digits = ''
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint8Array(20)
    crypto.getRandomValues(buf)
    digits = Array.from(buf)
      .map((b) => (b % 10).toString())
      .join('')
  } else {
    digits = `${Date.now()}${Math.floor(Math.random() * 1e10)}`.replace(/\D/g, '').slice(-20).padStart(20, '0')
  }
  return `VIN${digits}`
}

function vinAuthProhibitReasonText(code: number): string {
  const m: Record<number, string> = {
    1: '余额不足（≤0）',
    2: '充电枪使用中',
    3: '黑名单',
    4: '未登记 VIN',
    5: '其它',
    6: '余额低于最低启动金额',
    7: 'VIN 启动金额冻结失败',
    8: '车辆或站点信息获取失败',
    9: '无本站充电权限',
    10: '支付/扣款账户获取失败',
    11: '支付/扣款账户未配置',
    12: '支付/扣款账户状态异常',
    13: '上报 VIN 非法（空或乱码）',
  }
  return m[code] ?? `其它(码${code})`
}

/**
 * 上行 `0x40`：与 `CM40Data224` 一致 — 时间标识(6)+VIN(17)+枪号(1)+充电订单号(32)，共 56 字节。
 * `orderNo` 传空字符串时订单号域为 **32 字节全 `0x00`**（VIN 启动流程默认）。
 */
export function buildVinAuth40Payload(pile: JxTopologyPile, gunId: string, vin: string, orderNo: string): string {
  const gunHex = gunIdToGunNoHex(pile, gunId)
  const v = vin.trim().toUpperCase().slice(0, 17)
  const ord = orderNo.trim().slice(0, 32)
  return `${makeTimeTag6Hex()}${asciiFixedHex(v, 17)}${gunHex}${asciiFixedHex(ord, 32)}`
}

/** 下行 `0x59`（表 3.9.30）：时间标识(6)+枪号(1)+充电订单号(32)，共 39 字节。 */
export function parseVinStart59Payload(dataHexRaw: string): {
  timeTag: string
  gunNo: number
  orderNo: string
} | null {
  const dataHex = (dataHexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (dataHex.length < 78) return null
  const orderNo = parseAsciiFixed(dataHex.slice(14, 78)).trim()
  if (!orderNo) return null
  return {
    timeTag: decodeTimeTag6(dataHex.slice(0, 12)),
    gunNo: Number.parseInt(dataHex.slice(12, 14), 16),
    orderNo,
  }
}

/** 上行 `0x5B`（表 3.9.31）：时间标识(6)+枪号(1)+充电订单号(32)+结果(1)+失败原因(1)，共 41 字节。 */
export function buildVinStart5bPayload(
  gunNoHex: string,
  orderNo: string,
  result: 1 | 2,
  failReason: number,
): string {
  const gun = (gunNoHex || '00').replace(/[^0-9a-f]/gi, '').toLowerCase().padStart(2, '0').slice(0, 2)
  const resHex = Math.max(1, Math.min(2, result)).toString(16).padStart(2, '0')
  const failHex = Math.max(0, Math.min(255, Math.trunc(failReason))).toString(16).padStart(2, '0')
  return `${makeTimeTag6Hex()}${gun}${asciiFixedHex(orderNo.trim().slice(0, 32), 32)}${resHex}${failHex}`
}

/**
 * 从 **CM40 / `0x40` 数据域形状**（56 字节 = 112 hex）解析「充电订单号」（字节 24～55）。
 * 32 字节全 `0x00` 视为无订单号，返回 `null`。
 * 用于：下行 `0x41` 未带末尾订单号时，回退读取本次上行 `0x40` 中已填订单号；少数对接若误把 CM40 形状负载装入应答也可尝试解析。
 */
export function parseCm40DataDomainOrderNo(dataHexRaw: string): string | null {
  const dataHex = (dataHexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (dataHex.length < 112) return null
  const orderHex = dataHex.slice(48, 112)
  const p = orderHex.padEnd(64, '0').slice(0, 64)
  if (p.length === 64 && /^0+$/.test(p)) return null
  const s = decodeAsciiFromHex(orderHex).trim()
  return s.length > 0 ? s : null
}

/**
 * 下行 `0x41`（表 3.8.4）数据域解析。
 * 计费模型选择 = `2` 时：字节 30 起为费率头(9) + N×11 时段数据；**充电订单号**紧随其后共 32 字节，
 * 起始字节（从 0 计）为 **`39 + 11×N`**，与 `parseTariffModelFrom1fTail` 消费字节数对齐。
 */
export function parseVinAuth41Payload(dataHexRaw: string): {
  timeTag: string
  vin: string
  accountBalanceFen: number
  allowChargeFlag: number
  prohibitReason: number
  billingModelSelect: 1 | 2
  embeddedTariffModel: ParsedTariffModel | null
  orderNo: string | null
} | null {
  const dataHex = (dataHexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  if (dataHex.length < 60) return null
  const timeTagHex = dataHex.slice(0, 12)
  const vinHex = dataHex.slice(12, 46)
  const balanceHex = dataHex.slice(46, 54)
  const allowHex = dataHex.slice(54, 56)
  const prohibitHex = dataHex.slice(56, 58)
  const billingHex = dataHex.slice(58, 60)
  const billingModelSelect: 1 | 2 = Number.parseInt(billingHex, 16) === 2 ? 2 : 1
  let embeddedTariffModel: ParsedTariffModel | null = null
  let orderNo: string | null = null
  if (billingModelSelect === 2) {
    const tailFrom30 = dataHex.slice(60)
    const emb = parseTariffModelFrom1fTail(tailFrom30)
    if (!emb.model || emb.consumedBytes <= 0) return null
    embeddedTariffModel = emb.model
    const orderHex = dataHex.slice(60 + emb.consumedBytes * 2, 60 + emb.consumedBytes * 2 + 64)
    if (orderHex.length < 64) return null
    const parsedOrder = parseAsciiFixed(orderHex).trim()
    orderNo = parsedOrder.length > 0 ? parsedOrder : null
  }
  return {
    timeTag: decodeTimeTag6(timeTagHex),
    vin: parseAsciiFixed(vinHex).trim(),
    accountBalanceFen: decodeU32Le(balanceHex),
    allowChargeFlag: Number.parseInt(allowHex, 16),
    prohibitReason: Number.parseInt(prohibitHex, 16),
    billingModelSelect,
    embeddedTariffModel,
    orderNo,
  }
}

export function parseQrCodesFrom04(dataHexRaw: string): {
  allowFlag: number
  rejectReason: number | null
  qrGunCodes: string[]
} | null {
  const dataHex = (dataHexRaw ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  // timeTag(6) + allowFlag(1) + rejectReason(1)
  if (dataHex.length < 16) return null

  const allowFlagHex = dataHex.slice(12, 14)
  const rejectReasonHex = dataHex.slice(14, 16)
  const allowFlag = Number.parseInt(allowFlagHex, 16)
  const rejectReason = Number.isNaN(Number.parseInt(rejectReasonHex, 16))
    ? null
    : Number.parseInt(rejectReasonHex, 16)
  // 协议文档主值为0x01；现场偶发0x03也视为允许并继续按二维码字段解析
  const allowConnect = allowFlag === 0x01 || allowFlag === 0x03
  if (!allowConnect) return null

  // allow success layout: timeTag + allow + reject + qrGunCount + qr1..qrN(100 each)
  const qrGunCountHex = dataHex.slice(16, 18)
  const qrGunCount = Number.parseInt(qrGunCountHex, 16)
  if (!Number.isFinite(qrGunCount) || qrGunCount < 1 || qrGunCount > 30) return null

  const minHexLen = 18 + 200 * qrGunCount
  if (dataHex.length < minHexLen) return null

  const qrGunCodes: string[] = []
  for (let i = 0; i < qrGunCount; i += 1) {
    const start = 18 + i * 100 * 2
    const qrHex = dataHex.slice(start, start + 100 * 2)
    qrGunCodes.push(decodeAsciiFromHex(qrHex))
  }

  return { allowFlag, rejectReason, qrGunCodes }
}

export function decodeCmdPayload(cmd: string, dataHexRaw: string, protocolId?: string): Record<string, unknown> {
  const dataHex = (dataHexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  let cursor = 0
  const segments: HexSegment[] = []
  const take = (name: string, bytes: number): string => {
    const n = Math.max(0, bytes * 2)
    const hex = dataHex.slice(cursor, cursor + n)
    cursor += n
    segments.push({ name, hex, bytes: Math.floor(hex.length / 2) })
    return hex
  }
  const remain = () => dataHex.slice(cursor)
  const out: Record<string, unknown> = { cmd: cmd.toLowerCase(), dataHex, segments }
  const c = cmd.toLowerCase()

  if (c === '0x01') {
    const timeTag = take('timeTag', 6)
    const keyVersion = take('keyVersion', 2)
    const checkCipher = take('checkCipher', 8)
    out.timeTag = decodeTimeTag6(timeTag)
    out.keyVersion = decodeU16Le(keyVersion)
    out.checkCipher = checkCipher
    if (remain().length >= 4) {
      const protocolVersion = take('protocolVersion', 2)
      out.protocolVersionHex = protocolVersion
    }
  } else if (c === '0x02') {
    const timeTag = take('timeTag', 6)
    const allowFlag = take('allowFlag', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.allowFlag = allowFlag ? Number.parseInt(allowFlag, 16) : null
    if (remain().length >= 2) {
      const rejectReason = take('rejectReason', 1)
      out.rejectReason = rejectReason ? Number.parseInt(rejectReason, 16) : null
    }
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  } else if (c === '0x05') {
    const timeTag = take('timeTag', 6)
    out.timeTag = decodeTimeTag6(timeTag)
  } else if (c === '0x06') {
    const timeTag = take('timeTag', 6)
    const syncTime = take('syncTime', 6)
    out.timeTag = decodeTimeTag6(timeTag)
    out.syncTime = decodeTimeTag6(syncTime)
  } else if (c === '0x07') {
    const timeTag = take('timeTag', 6)
    const resultHex = take('result', 1)
    const failReasonHex = take('failReason', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.result = resultHex ? Number.parseInt(resultHex, 16) : null
    out.failReason = failReasonHex ? Number.parseInt(failReasonHex, 16) : null
  } else if (c === '0x04') {
    const timeTag = take('timeTag', 6)
    const allowFlagHex = take('allowFlag', 1)
    const rejectReasonHex = take('rejectReason', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.allowFlag = allowFlagHex ? Number.parseInt(allowFlagHex, 16) : null
    out.rejectReason = rejectReasonHex ? Number.parseInt(rejectReasonHex, 16) : null
    const allowFlag = allowFlagHex ? Number.parseInt(allowFlagHex, 16) : 0
    if (allowFlag === 0x01 || allowFlag === 0x03) {
      const qrGunCountHex = take('qrGunCount', 1)
      const qrGunCount = qrGunCountHex ? Number.parseInt(qrGunCountHex, 16) : 0
      out.qrGunCount = qrGunCount
      for (let i = 0; i < qrGunCount; i += 1) {
        const segHex = take(`qrGun${i + 1}Ascii`, 100)
        const segText = decodeAsciiFromHex(segHex)
        out[`qrGunCode${i + 1}`] = segText
      }
    }
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  } else if (c === '0x03') {
    const timeTag = take('timeTag', 6)
    take('pileModel', 16)
    take('hwVersion', 2)
    take('swVersion', 2)
    take('subHwVersion', 2)
    take('subSwVersion', 2)
    take('moduleType', 1)
    take('moduleTotal', 1)
    take('modulePower', 1)
    take('billingModelVersion', 4)
    take('bootCount', 2)
    take('bootTime', 6)
    const hbPeriod = take('heartbeatPeriodSec', 2)
    take('heartbeatTimeoutCount', 1)
    take('yaoXinCount', 2)
    take('yaoCeCount', 2)
    take('workInfoPeriodSec', 2)
    take('bmsInfoPeriodSec', 2)
    take('bmvPeriodSec', 2)
    take('bmtPeriodSec', 2)
    take('latitudeDegree', 1)
    take('latitudeMinute', 3)
    take('longitudeDegree', 1)
    take('longitudeMinute', 3)
    take('simNo', 20)
    out.timeTag = decodeTimeTag6(timeTag)
    out.heartbeatPeriodSec = decodeU16Le(hbPeriod)
  } else if (c === '0x0c') {
    const timeTag = take('timeTag', 6)
    const platformHeartbeatTimeoutCount = take('platformHeartbeatTimeoutCount', 1)
    const gunCountHex = take('gunCount', 1)
    const gunCount = gunCountHex ? Number.parseInt(gunCountHex, 16) : 0
    for (let i = 0; i < gunCount; i += 1) {
      take(`gun${i + 1}Status`, 1)
      take(`gun${i + 1}WorkMode`, 1)
    }
    out.timeTag = decodeTimeTag6(timeTag)
    out.platformHeartbeatTimeoutCount = platformHeartbeatTimeoutCount
      ? Number.parseInt(platformHeartbeatTimeoutCount, 16)
      : null
    out.gunCount = gunCount
  } else if (c === '0x0b') {
    const timeTag = take('timeTag', 6)
    out.timeTag = decodeTimeTag6(timeTag)
    if (remain().length >= 2) {
      const pileHeartbeatTimeoutCount = take('pileHeartbeatTimeoutCount', 1)
      out.pileHeartbeatTimeoutCount = pileHeartbeatTimeoutCount ? Number.parseInt(pileHeartbeatTimeoutCount, 16) : null
    }
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  } else if (c === '0x37') {
    const timeTag = take('timeTag', 6)
    const modelVersion = take('modelVersion', 4)
    const parkingRate = take('parkingRate', 4)
    const periodCountHex = take('periodCount', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.modelVersion = decodeU32Le(modelVersion)
    out.parkingRate = decodeRate4(parkingRate)
    const periodCount = periodCountHex ? Number.parseInt(periodCountHex, 16) : 0
    out.periodCount = periodCount
    for (let i = 0; i < periodCount; i += 1) {
      take(`period${i + 1}StartHour`, 1)
      take(`period${i + 1}StartMinute`, 1)
      take(`period${i + 1}Type`, 1)
      take(`period${i + 1}ElectricRate`, 4)
      take(`period${i + 1}ServiceRate`, 4)
    }
    const model = parseTariffModelFrom037(dataHex)
    if (model) out.tariffModel = model
    else out.parseError = 'invalid 0x37 payload'
    if (remain().length > 0) {
      out.extra = take('extra', Math.floor(remain().length / 2))
    }
  } else if (c === '0x38') {
    const timeTag = take('timeTag', 6)
    const modelVersion = take('modelVersion', 4)
    const result = take('result', 1)
    const failReason = take('failReason', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.modelVersion = decodeU32Le(modelVersion)
    out.result = result ? Number.parseInt(result, 16) : null
    out.failReason = failReason ? Number.parseInt(failReason, 16) : null
  } else if (c === '0x1f') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    const userId = take('userId', 32)
    const userType = take('userType', 2)
    const orgCode = take('orgCode', 9)
    const controlMode = take('controlMode', 1)
    const controlParam = take('controlParam', 4)
    const accountBalance = take('accountBalance', 4)
    const chargeMode = take('chargeMode', 1)
    const startMode = take('startMode', 1)
    const scheduleStartTime = take('scheduleStartTime', 6)
    const userOpCode = take('userOpCode', 6)
    const billingModelSelect = take('billingModelSelect', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    out.userId = parseAsciiFixed(userId)
    out.userType = decodeU16Le(userType)
    out.orgCode = parseAsciiFixed(orgCode)
    out.controlMode = controlMode ? Number.parseInt(controlMode, 16) : null
    out.controlParam = parseU32Le(controlParam)
    out.accountBalanceFen = decodeU32Le(accountBalance)
    out.chargeMode = chargeMode ? Number.parseInt(chargeMode, 16) : null
    out.startMode = startMode ? Number.parseInt(startMode, 16) : null
    out.scheduleStartTime = decodeTimeTag6(scheduleStartTime)
    out.userOpCode = parseAsciiFixed(userOpCode)
    const bmsel = billingModelSelect ? Number.parseInt(billingModelSelect, 16) : null
    out.billingModelSelect = bmsel
    out.billingModelSelect1f = bmsel === 1 || bmsel === 2 ? bmsel : null
    if (bmsel === 2) {
      const rest = remain()
      const { model, consumedBytes } = parseTariffModelFrom1fTail(rest)
      if (model && consumedBytes > 0) {
        take('embeddedTariffBlock', consumedBytes)
        out.embeddedTariffModel = model
      }
    }
  } else if (c === '0x20') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    const userId = take('userId', 32)
    const userType = take('userType', 2)
    const orgCode = take('orgCode', 9)
    const controlMode = take('controlMode', 1)
    const controlParam = take('controlParam', 4)
    const chargeMode = take('chargeMode', 1)
    const startMode = take('startMode', 1)
    const scheduleStartTime = take('scheduleStartTime', 6)
    const userOpCode = take('userOpCode', 6)
    const billingModelSelect = take('billingModelSelect', 1)
    const bmsel20 = billingModelSelect ? Number.parseInt(billingModelSelect, 16) : null
    if (bmsel20 === 2) {
      const rest20 = remain()
      const emb20 = parseTariffModelFrom1fTail(rest20)
      if (emb20.model && emb20.consumedBytes > 0) {
        take('embeddedTariffBlock', emb20.consumedBytes)
        out.embeddedTariffModel = emb20.model
      }
    }
    const executeResult = take('executeResult', 1)
    const failReason = take('failReason', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    out.userId = parseAsciiFixed(userId)
    out.userType = decodeU16Le(userType)
    out.orgCode = parseAsciiFixed(orgCode)
    out.controlMode = controlMode ? Number.parseInt(controlMode, 16) : null
    out.controlParam = parseU32Le(controlParam)
    out.chargeMode = chargeMode ? Number.parseInt(chargeMode, 16) : null
    out.startMode = startMode ? Number.parseInt(startMode, 16) : null
    out.scheduleStartTime = decodeTimeTag6(scheduleStartTime)
    out.userOpCode = parseAsciiFixed(userOpCode)
    out.billingModelSelect = bmsel20
    out.billingModelSelect1f = bmsel20 === 1 || bmsel20 === 2 ? bmsel20 : null
    out.executeResult = executeResult ? Number.parseInt(executeResult, 16) : null
    out.failReason = failReason ? Number.parseInt(failReason, 16) : null
  } else if (c === '0x40') {
    const timeTag = take('timeTag', 6)
    const vin = take('vin', 17)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    out.timeTag = decodeTimeTag6(timeTag)
    out.vin = parseAsciiFixed(vin)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
  } else if (c === '0x59') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
  } else if (c === '0x5b') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    const result = take('result', 1)
    const failReason = take('failReason', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    out.result = result ? Number.parseInt(result, 16) : null
    out.failReason = failReason ? Number.parseInt(failReason, 16) : null
  } else if (c === '0x41') {
    const timeTag = take('timeTag', 6)
    const vin = take('vin', 17)
    const accountBalance = take('accountBalance', 4)
    const allowChargeFlag = take('allowChargeFlag', 1)
    const prohibitReason = take('prohibitReason', 1)
    const billingModelSelect = take('billingModelSelect', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.vin = parseAsciiFixed(vin)
    out.accountBalanceFen = decodeU32Le(accountBalance)
    out.allowChargeFlag = allowChargeFlag ? Number.parseInt(allowChargeFlag, 16) : null
    out.prohibitReason = prohibitReason ? Number.parseInt(prohibitReason, 16) : null
    const bms41 = billingModelSelect ? Number.parseInt(billingModelSelect, 16) : null
    out.billingModelSelect = bms41
    if (bms41 === 2) {
      const rest41 = remain()
      const emb41 = parseTariffModelFrom1fTail(rest41)
      if (emb41.model && emb41.consumedBytes > 0) {
        const tHex = rest41.slice(0, emb41.consumedBytes * 2)
        let off = 0
        const take41Seg = (name: string, bytes: number): string => {
          const hex = tHex.slice(off, off + bytes * 2)
          off += bytes * 2
          segments.push({ name, hex, bytes })
          return hex
        }
        take41Seg('tariffModelVersion', 4)
        take41Seg('parkingRate', 4)
        take41Seg('periodCount', 1)
        const periodCount = emb41.model.periods.length
        for (let i = 0; i < periodCount; i += 1) {
          take41Seg(`period${i + 1}StartHour`, 1)
          take41Seg(`period${i + 1}StartMinute`, 1)
          take41Seg(`period${i + 1}Type`, 1)
          take41Seg(`period${i + 1}ElectricRate`, 4)
          take41Seg(`period${i + 1}ServiceRate`, 4)
        }
        cursor += emb41.consumedBytes * 2
        out.tariffModelVersion = emb41.model.version
        out.parkingRate = emb41.model.parkingRate
        out.periodCount = periodCount
        out.embeddedTariffModel = emb41.model
      }
      if (remain().length >= 64) {
        const orderNo41 = take('orderNo', 32)
        out.orderNo = parseAsciiFixed(orderNo41)
      }
    }
  } else if (c === '0x21') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    const userId = take('userId', 32)
    const userType = take('userType', 2)
    const orgCode = take('orgCode', 9)
    const licensePlate = take('licensePlate', 9)
    const controlMode = take('controlMode', 1)
    const controlParam = take('controlParam', 4)
    const chargeMode = take('chargeMode', 1)
    const pileType = take('pileType', 1)
    const startResult = take('startResult', 1)
    const failReason = take('failReason', 2)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    out.userId = parseAsciiFixed(userId)
    out.userType = decodeU16Le(userType)
    out.orgCode = parseAsciiFixed(orgCode)
    out.licensePlate = parseAsciiFixed(licensePlate)
    out.controlMode = controlMode ? Number.parseInt(controlMode, 16) : null
    out.controlParam = parseU32Le(controlParam)
    out.chargeMode = chargeMode ? Number.parseInt(chargeMode, 16) : null
    out.pileType = pileType ? Number.parseInt(pileType, 16) : null
    out.startResult = startResult ? Number.parseInt(startResult, 16) : null
    out.failReason = decodeU16Le(failReason)
    const sr = out.startResult as number | null
    if (sr === 1 && remain().length >= 20) {
      const chargeStartTime = take('chargeStartTime', 6)
      const chargeStartEnergy = take('chargeStartEnergy', 4)
      out.chargeStartTime = decodeTimeTag6(chargeStartTime)
      out.chargeStartEnergyKwh = cm21StartElectKwhFromRaw(decodeU32Le(chargeStartEnergy))
      const pt = out.pileType as number | null
      if (pt === 2 && remain().length >= 136) {
        const insDeVoltage = take('insDeVoltage', 2)
        const dcAddIns = take('dcAddIns', 2)
        const dcSubtractIns = take('dcSubtractIns', 2)
        const brmVer = take('brmVer', 3)
        take('brmBatteryType', 1)
        take('brmBatteryCapacity', 2)
        take('brmRatedVoltage', 2)
        take('brmBatteryManufacturer', 4)
        take('brmBatteryGroupId', 4)
        take('brmBatteryProdY', 1)
        take('brmBatteryProdM', 1)
        take('brmBatteryProdD', 1)
        take('brmChargingCount', 3)
        take('brmBattery', 1)
        take('brmYL', 1)
        const brmVinHex = take('brmVin', 17)
        take('brmSoftVer', 8)
        const bcpCell = take('bcpCellAllowVoltage', 2)
        const bcpCur = take('bcpAllowCurrent', 2)
        const bcpCap = take('bcpBatteryCapacity', 2)
        const bcpV = take('bcpAllowVoltage', 2)
        take('bcpAllowTemp', 1)
        const bcpSoc = take('bcpSoc', 2)
        const bcpBatV = take('bcpBatteryVoltage', 2)
        out.insulationVoltage01V = decodeU16Le(insDeVoltage) / 10
        out.dcPlusInsulation = decodeU16Le(dcAddIns)
        out.dcMinusInsulation = decodeU16Le(dcSubtractIns)
        out.brmVerHex = brmVer
        out.brmVin = parseAsciiFixed(brmVinHex)
        out.bcpSoc = decodeU16Le(bcpSoc) / 10
        out.bcpSocRaw = decodeU16Le(bcpSoc)
        out.bcpBatteryVoltage01V = decodeU16Le(bcpBatV) / 10
        out.bcpCellAllowVoltage01V = decodeU16Le(bcpCell) / 10
        out.bcpAllowCurrent01A = decodeU16Le(bcpCur) / 10
        out.bcpBatteryCapacityAh = decodeU16Le(bcpCap) / 10
        out.bcpAllowVoltage01V = decodeU16Le(bcpV) / 10
      }
    }
  } else if (c === '0x22') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
  } else if (c === '0x26') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    out.orderNoFieldAllZero = isOrder32FieldAllZeroHex(orderNo)
  } else if (c === '0x27') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const orderNo = take('orderNo', 32)
    const stopResult = take('stopResult', 1)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    out.stopResult = stopResult ? Number.parseInt(stopResult, 16) : null
  } else if (c === '0x23' || c === '0x33') {
    decodeOrder23IntoOut(out, take, protocolId)
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  } else if (c === '0x24' || c === '0x34') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const recordIndex = take('recordIndex', 4)
    const orderNo = take('orderNo', 32)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.recordIndex = decodeU32Le(recordIndex)
    out.orderNo = parseAsciiFixed(orderNo)
    if (remain().length >= 2) {
      const ackResult = take('ackResult', 1)
      out.ackResult = ackResult ? Number.parseInt(ackResult, 16) : null
    }
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  } else if (c === '0x25') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const chargeVoltage = take('chargeVoltage', 2)
    const chargeCurrent = take('chargeCurrent', 2)
    const chargeEnergy = take('chargeEnergy', 4)
    const chargeDuration = take('chargeDuration', 4)
    const chargeAmount = take('chargeAmount', 4)
    const moduleCount = take('moduleCount', 1)
    const electricAmount = take('electricAmount', 4)
    const serviceAmount = take('serviceAmount', 4)
    const orderNo = take('orderNo', 32)
    const accountBalance = take('accountBalance', 4)
    const segCountHex = take('segmentCount', 1)
    const segCount = segCountHex ? Number.parseInt(segCountHex, 16) : 0
    for (let i = 0; i < segCount; i += 1) {
      take(`segment${i}StartTime`, 6)
      take(`segment${i}EndTime`, 6)
      take(`segment${i}ElePrice`, 4)
      take(`segment${i}SvcPrice`, 4)
      take(`segment${i}Energy`, 4)
      take(`segment${i}EleFee`, 4)
      take(`segment${i}SvcFee`, 4)
    }
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.orderNo = parseAsciiFixed(orderNo)
    const cv = decodeU16Le(chargeVoltage)
    const cc = decodeU16Le(chargeCurrent)
    out.chargeVoltage = cv
    out.chargeCurrent = cc
    out.chargeVoltage01V = cv / WIRE_SCALE.ONE_POINT
    out.chargeCurrent01A = cc / WIRE_SCALE.ONE_POINT
    out.chargeEnergy = decodeU32Le(chargeEnergy)
    out.chargeEnergyKwh = decodeU32Le(chargeEnergy) / WIRE_SCALE.FOUR_POINT
    out.chargeDuration = decodeU32Le(chargeDuration)
    out.chargeDurationSec = decodeU32Le(chargeDuration)
    out.chargeAmount = decodeU32Le(chargeAmount)
    out.chargeAmountYuan = decodeU32Le(chargeAmount) / WIRE_SCALE.TWO_POINT
    out.moduleCount = moduleCount ? Number.parseInt(moduleCount, 16) : null
    out.electricAmount = decodeU32Le(electricAmount)
    out.electricAmountYuan = decodeU32Le(electricAmount) / WIRE_SCALE.TWO_POINT
    out.serviceAmount = decodeU32Le(serviceAmount)
    out.serviceAmountYuan = decodeU32Le(serviceAmount) / WIRE_SCALE.TWO_POINT
    out.accountBalance = decodeU32Le(accountBalance)
    out.accountBalanceYuan = decodeU32Le(accountBalance) / WIRE_SCALE.TWO_POINT
    out.segmentCount = segCount
  } else if (c === '0x30') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const bclVoltageReq = take('bclVoltageReq', 2)
    const bclCurrentReq = take('bclCurrentReq', 2)
    take('bcsMode', 1)
    const bcsVoltage = take('bcsVoltage', 2)
    const bcsCurrent = take('bcsCurrent', 2)
    take('bcsMaxCellVoltage', 1)
    take('bcsMaxCellNo', 1)
    const socHex = take('soc', 1)
    take('remainChargeTime', 2)
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.bclVoltageReq = decodeU16Le(bclVoltageReq)
    out.bclCurrentReq = decodeU16Le(bclCurrentReq)
    out.bcsVoltage = decodeU16Le(bcsVoltage)
    out.bcsCurrent = decodeU16Le(bcsCurrent)
    out.soc = socHex ? Number.parseInt(socHex, 16) : null
  } else if (c === '0x09') {
    const timeTag = take('timeTag', 6)
    take('fanAndHeaterCtrl', 1)
    take('reserved', 1)
    const gunCountHex = take('gunCount', 1)
    const gunCount = gunCountHex ? Number.parseInt(gunCountHex, 16) : 0
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunCount = gunCount
    for (let i = 0; i < gunCount; i += 1) {
      const statusHex = take(`gun${i + 1}Status`, 1)
      const workModeHex = take(`gun${i + 1}WorkMode`, 1)
      const stateBitsHex = take(`gun${i + 1}StateBits`, 1)
      const feedbackBitsHex = take(`gun${i + 1}FeedbackBits`, 1)
      const cpCcBitsHex = take(`gun${i + 1}CpCcBits`, 1)
      out[`gun${i + 1}Status`] = statusHex ? Number.parseInt(statusHex, 16) : null
      out[`gun${i + 1}WorkMode`] = workModeHex ? Number.parseInt(workModeHex, 16) : null
      out[`gun${i + 1}StateBits`] = decode09Bit11Meaning(stateBitsHex)
      out[`gun${i + 1}FeedbackBits`] = decode09Bit12Meaning(feedbackBitsHex)
      out[`gun${i + 1}CpCcBits`] = decode09Bit13Meaning(cpCcBitsHex)
    }
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  } else if (c === '0x0a') {
    const timeTag = take('timeTag', 6)
    take('aPhaseVoltage', 2)
    take('bPhaseVoltage', 2)
    take('cPhaseVoltage', 2)
    take('aPhaseCurrent', 2)
    take('bPhaseCurrent', 2)
    take('cPhaseCurrent', 2)
    take('totalMeterEnergy', 4)
    take('cabinetTemp', 1)
    take('inletTemp', 1)
    take('outletTemp', 1)
    take('boardTemp', 1)
    take('gunInnerTemp', 1)
    take('reserved8', 8)
    const gunCountHex = take('gunCount', 1)
    const gunCount = gunCountHex ? Number.parseInt(gunCountHex, 16) : 0
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunCount = gunCount
    for (let i = 0; i < gunCount; i += 1) {
      take(`gun${i + 1}MeterVoltage`, 2)
      take(`gun${i + 1}MeterCurrent`, 2)
      take(`gun${i + 1}MeterEnergy`, 4)
      take(`gun${i + 1}ModuleVoltage`, 2)
      take(`gun${i + 1}ModuleCurrent`, 2)
      take(`gun${i + 1}ModuleTemp`, 1)
      take(`gun${i + 1}GunTemp`, 1)
      take(`gun${i + 1}Reserved4`, 4)
    }
    if (remain().length > 0) out.extra = take('extra', Math.floor(remain().length / 2))
  }
  if (remain().length > 0) out.remainHex = remain()
  return out
}

function byteAt(hex: string, index: number): number | null {
  const h = (hex || '').replace(/[^0-9a-f]/gi, '')
  const p = index * 2
  if (h.length < p + 2) return null
  return Number.parseInt(h.slice(p, p + 2), 16)
}

function u16LeHex(n: number): string {
  const v = n & 0xffff
  return [v & 0xff, (v >> 8) & 0xff].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** 协议分辨率 0.1V / LSB */
function u16LeHexVoltage01V(volts: number): string {
  const raw = Math.max(0, Math.min(65535, Math.round(volts * 10)))
  return u16LeHex(raw)
}

/** 协议分辨率 0.1A / LSB */
function u16LeHexCurrent01A(amps: number): string {
  const raw = Math.max(0, Math.min(65535, Math.round(amps * 10)))
  return u16LeHex(raw)
}

function u16BeHex(n: number): string {
  const v = n & 0xffff
  return [(v >> 8) & 0xff, v & 0xff].map((x) => x.toString(16).padStart(2, '0')).join('')
}

function bcd2(n: number): string {
  const s = Math.max(0, n).toString().padStart(2, '0')
  return s
}

/** 单字节时间值：按十进制数值直接写入1字节（例如 26 -> 0x1A） */
function timeByteHex(n: number): string {
  const v = Math.max(0, Math.min(255, Math.trunc(n)))
  return v.toString(16).padStart(2, '0')
}

function asciiFixedHex(text: string, len: number): string {
  const bytes = new Array<number>(len).fill(0x00)
  for (let i = 0; i < len; i += 1) {
    const ch = text.charCodeAt(i)
    if (!Number.isNaN(ch) && ch > 0) bytes[i] = ch & 0xff
  }
  return bytes.map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** 时间格式6字节：yy mm dd HH MM SS（每字段按数值写入1字节，例如 26 -> 0x1A） */
function makeTimeTag6Hex(t = new Date()): string {
  // 协议要求按北京时间校验时间标识；这里基于时间戳换算到 UTC+8 再编码，
  // 避免直接用 UTC 字段导致 0x01 与平台侧时间格式不一致。
  const beijing = new Date(t.getTime() + 8 * 60 * 60 * 1000)
  const yy = beijing.getUTCFullYear() % 100
  const mm = beijing.getUTCMonth() + 1
  const dd = beijing.getUTCDate()
  const HH = beijing.getUTCHours()
  const MM = beijing.getUTCMinutes()
  const SS = beijing.getUTCSeconds()
  return [yy, mm, dd, HH, MM, SS].map((x) => timeByteHex(x)).join('')
}

/** 登录异常模拟：0x01/0x03 时间标识 */
const LOGIN_ABNORMAL_TIME_SKEW_LARGE = 'time_skew_large' as const

/** 「时差过大」模拟：固定为北京时间 2017-01-01 00:00:00，与平台当前时间差距远大于 ±10min */
const LOGIN_ABNORMAL_TIME_SKEW_LARGE_REF = new Date('2017-01-01T00:00:00+08:00')

/**
 * 协议要求 0x01 时间标识与平台北京时间误差在 ±10min 内；超出则 0x02 拒绝原因可为 6「时差过大」。
 * 模拟时使用固定 2017 年时间标识，避免仅用「提前几分钟」的场景。
 */
function resolveLoginAbnormalTimeRef(params: Record<string, unknown>): Date | undefined {
  if (params.loginAbnormalSim === LOGIN_ABNORMAL_TIME_SKEW_LARGE) {
    return LOGIN_ABNORMAL_TIME_SKEW_LARGE_REF
  }
  return undefined
}

function toCompressedBcdVersionHex(versionLike: string): string {
  const m = versionLike.match(/(\d+)\.(\d+)/)
  if (!m) return '0225'
  const major = Number.parseInt(m[1], 10)
  const minor = Number.parseInt(m[2], 10)
  const majorBcd = ((Math.floor(Math.max(0, major) / 10) << 4) | (Math.max(0, major) % 10))
    .toString(16)
    .padStart(2, '0')
  const minor2 = Math.max(0, minor % 100)
  const minorBcd = ((Math.floor(minor2 / 10) << 4) | (minor2 % 10)).toString(16).padStart(2, '0')
  return `${majorBcd}${minorBcd}`
}

function protocolVersionFromProtocolId(protocolId: string): string {
  const m = protocolId.match(/(\d+\.\d+)/)
  if (m) return m[1]
  return '2.25'
}

function makeConnectPayload(protocolId: string, params: Record<string, unknown>): string {
  // 0x01 请求连接：时间标识(6) + 密钥版本(2) + 校验密文(8) [+ 协议版本(2)]
  // 按协议文档 2.25 的 0x01 字段定义，默认携带协议版本（总长度18字节）。
  // 仅显式 includeProtocolVersionIn01=false 时不携带（兼容少数字段裁剪场景）。
  const abnormalRef = resolveLoginAbnormalTimeRef(params)
  const timeTag = abnormalRef ? makeTimeTag6Hex(abnormalRef) : makeTimeTag6Hex()
  const keyVersionNum = Number(params.keyVersion ?? 1)
  const keyVersion = u16LeHex(Number.isFinite(keyVersionNum) ? keyVersionNum : 1)

  // 按实桩 2.23 样例，默认校验密文 8 字节全 0；若传入 checkCipherHex 则优先使用
  const configuredCheckCipher = String(params.checkCipherHex ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const checkCipher = configuredCheckCipher.length >= 16 ? configuredCheckCipher.slice(0, 16) : '0000000000000000'

  const protocolVersionText = String(params.protocolVersion ?? protocolVersionFromProtocolId(protocolId))
  const includeProtocolVersion = params.includeProtocolVersionIn01 !== false
  if (!includeProtocolVersion) {
    return `${timeTag}${keyVersion}${checkCipher}`
  }

  const protocolVersion = toCompressedBcdVersionHex(protocolVersionText)
  return `${timeTag}${keyVersion}${checkCipher}${protocolVersion}`
}

export function makeLoginPayloadStrict(
  hbSec: number,
  hbTimeout: number,
  teleSignalSec: number,
  telemetrySec: number,
  workInfoSec: number,
  tariffModelVersion: number,
  timeRef?: Date,
): string {
  // 0x03 登录信息：除页面可配字段与时间标识外，其余字段按样例报文固定
  const timeTag = timeRef ? makeTimeTag6Hex(timeRef) : makeTimeTag6Hex()
  const pileModel = '41494f44433250314256393030000000'
  const hwVer = '0142'
  const swVer = '0244'
  const subHw = '0000'
  const subSw = '0000'
  const moduleType = '06'
  const moduleTotal = '28'
  const modulePower = '0a'
  const billingModelVer = u32LeHex(Math.max(0, Math.min(0xffffffff, tariffModelVersion >>> 0)))
  const bootCount = '001a'
  const bootTime = '040902230b0f'
  const hb = u16LeHex(Math.max(1, Math.min(1000, hbSec)))
  const hbTimeoutHex = Math.max(1, Math.min(255, hbTimeout)).toString(16).padStart(2, '0')
  const yaoXin = u16LeHex(Math.max(1, Math.min(1000, teleSignalSec)))
  const yaoCe = u16LeHex(Math.max(1, Math.min(1000, telemetrySec)))
  const workInfo = u16LeHex(Math.max(1, Math.min(1000, workInfoSec)))
  const bmsInfo = '0e00'
  const bmv = '0f00'
  const bmt = '0000'
  const latitudeDegree = '00'
  const latitudeMinute = '000000'
  const longitudeDegree = '00'
  const longitudeMinute = '000000'
  const simNo = ''.padEnd(40, '0')
  return [
    timeTag,
    pileModel,
    hwVer,
    swVer,
    subHw,
    subSw,
    moduleType,
    moduleTotal,
    modulePower,
    billingModelVer,
    bootCount,
    bootTime,
    hb,
    hbTimeoutHex,
    yaoXin,
    yaoCe,
    workInfo,
    bmsInfo,
    bmv,
    bmt,
    latitudeDegree,
    latitudeMinute,
    longitudeDegree,
    longitudeMinute,
    simNo,
  ].join('')
}

function makePileHeartbeatPayload(): string {
  return `${makeTimeTag6Hex()}01${'00000000'}`
}

function parseAllowFlag(dataHex: string): number | null {
  // 文档中 0x02/0x04 均含“时间标识(6)”后跟“请求结果(1)”
  return byteAt(dataHex, 6)
}

function parseRejectReason(dataHex: string): number | null {
  return byteAt(dataHex, 7)
}

function encodeGunStatusHex(status: JxTopologyPile['guns'][number]['status']): string {
  if (status === 'idle') return '01'
  if (status === 'linked') return '02'
  if (status === 'occupied') return '03'
  if (status === 'charging') return '04'
  if (status === 'fault') return '05'
  return '00'
}

function encodeGunWorkModeHex(status: JxTopologyPile['guns'][number]['status']): string {
  // 当前拓扑仅维护枪状态，不区分细粒度工作模式；这里按“充电中/非充电”映射。
  return status === 'charging' ? '01' : '00'
}

function makePileHeartbeatPayloadStrict(pile: JxTopologyPile): string {
  // 时间标识6 + 平台心跳超时次数1 + 充电枪数量N + 每枪状态/工作模式(各1字节)
  const timeoutCountHex = Math.max(0, Math.min(255, pile.allowTimeoutCount ?? 0))
    .toString(16)
    .padStart(2, '0')
  const gunCount = Math.max(0, Math.min(30, pile.guns.length))
  const gunCountHex = gunCount.toString(16).padStart(2, '0')
  const gunBlocks = pile.guns
    .slice(0, gunCount)
    .map((gun) => `${encodeGunStatusHex(gun.status)}${encodeGunWorkModeHex(gun.status)}`)
    .join('')
  return `${makeTimeTag6Hex()}${timeoutCountHex}${gunCountHex}${gunBlocks}`
}

function makeTeleSignalPayloadStrict(pile: JxTopologyPile): string {
  const fanAndHeatCtrl = '00'
  const reserved = '00'
  const gunCount = Math.max(1, Math.min(30, pile.guns.length))
  const gunCountHex = gunCount.toString(16).padStart(2, '0')
  const gunBlocks = pile.guns
    .slice(0, gunCount)
    .map((gun) => {
      const statusHex = gun.status === 'linked' ? '01' : encodeGunStatusHex(gun.status)
      const workModeHex = gun.status === 'charging' ? '03' : '01'
      const connected = gun.status === 'linked' || gun.status === 'occupied' || gun.status === 'charging'
      const bitVehicle = connected ? 1 : 0
      const bitOutputConn = connected ? 1 : 0
      const bitInPos = connected ? 1 : 0
      const bitLock = connected ? 1 : 0
      const bitAux = 0
      const bitBms = connected ? 1 : 0
      const bitCpDischarge = 0
      const bitByte11 =
        bitVehicle |
        (bitOutputConn << 1) |
        (bitInPos << 2) |
        (bitLock << 3) |
        (bitAux << 4) |
        (bitBms << 5) |
        (bitCpDischarge << 6)
      const byte11Hex = bitByte11.toString(16).padStart(2, '0')
      const bitFeedback = 0
      const bitCanCc2 = connected ? 1 : 0
      const byte12Hex = (bitFeedback | (bitCanCc2 << 1)).toString(16).padStart(2, '0')
      const ccStatus = connected ? 0x03 : 0x00
      const cpStatus = connected ? 0x03 : 0x00
      const byte13Hex = ((cpStatus << 4) | ccStatus).toString(16).padStart(2, '0')
      return `${statusHex}${workModeHex}${byte11Hex}${byte12Hex}${byte13Hex}`
    })
    .join('')
  return `${makeTimeTag6Hex()}${fanAndHeatCtrl}${reserved}${gunCountHex}${gunBlocks}`
}

function decode09Bit11Meaning(byteHex: string): string {
  const v = Number.parseInt(byteHex || '0', 16)
  const pick = (idx: number, on: string, off: string) => (((v >> idx) & 0x1) === 1 ? on : off)
  return [
    `车辆连接:${pick(0, '连接', '断开')}`,
    `输出接触器:${pick(1, '闭合', '断开')}`,
    `枪进入:${pick(2, '进入', '未进入')}`,
    `电子锁:${pick(3, '上锁', '解锁')}`,
    `辅助电源:${pick(4, '开启', '关闭')}`,
    `BMS通信:${pick(5, '正常', '异常')}`,
    `CP反放电:${pick(6, '开启', '关闭')}`,
  ].join(' | ')
}

function decode09Bit12Meaning(byteHex: string): string {
  const v = Number.parseInt(byteHex || '0', 16)
  const feedback = (v & 0x1) === 1 ? '粘连' : '正常'
  const canCc2 = ((v >> 1) & 0x1) === 1 ? '连接' : '断开'
  return `反馈回路:${feedback} | CAN/CC2:${canCc2}`
}

function decode09Bit13Meaning(byteHex: string): string {
  const v = Number.parseInt(byteHex || '0', 16)
  const cc = v & 0x0f
  const cp = (v >> 4) & 0x0f
  const ccText = cc === 0 ? '断开' : cc === 3 ? '闭合' : `状态${cc}`
  const cpText = cp === 0 ? '断开' : cp === 3 ? '闭合' : `状态${cp}`
  return `CC:${ccText} | CP:${cpText}`
}

function makeTelemetryPayloadStrict(pile: JxTopologyPile): string {
  const pileId = pile.pileId
  const orderStore = useJxOrderStore()
  const workInfoSec = runtimeHeartbeatContext.get(pileId)?.workInfoSec ?? 15
  const etaAcDc = 0.93
  let totalDcW = 0
  let totalEnergyKwh = 0
  for (const gun of pile.guns) {
    if (gun.status !== 'charging') continue
    const rt = chargingRuntimeByKey.get(`${pileId}:${gun.gunId}`)
    let s: JxChargeElectricalSample | null = rt?.lastSample ?? null
    if (!s) {
      const order = orderStore.listByPile(pileId).find((o) => o.status === 'charging' && o.gunId === gun.gunId)
      if (order) s = peekJxChargeElectricalSample(order, pile, 1)
    }
    if (s) {
      totalDcW += s.pileVoltageV * s.pileCurrentA
      totalEnergyKwh += rt?.energyKwh ?? s.energyKwh
    }
  }
  const pAcW = totalDcW / etaAcDc
  const vLn = 220
  const pf = 0.98
  const iPhaseA = pAcW > 1 ? pAcW / (3 * vLn * pf) : 0
  const phaseVoltage = u16LeHex(2200)
  const phaseCurrent = u16LeHex(Math.min(65535, Math.max(0, Math.round(iPhaseA * 100))))
  const totalMeter = u32LeHex(Math.max(0, Math.round(totalEnergyKwh * 10000)))
  const cabinetTemp = '32'
  const inletTemp = '32'
  const outletTemp = '32'
  const boardTemp = '32'
  const gunInnerTemp = '19'
  const reserved8 = ''.padEnd(16, '0')
  const gunCount = Math.max(1, Math.min(30, pile.guns.length))
  const gunCountHex = gunCount.toString(16).padStart(2, '0')
  const gunBlocks = pile.guns
    .slice(0, gunCount)
    .map((gun) => {
      if (gun.status !== 'charging') {
        const meterVoltage = u16LeHex(2200)
        const meterCurrent = u16LeHex(0)
        const meterEnergy = u32LeHex(0)
        const moduleVoltage = u16LeHex(7500)
        const moduleCurrent = u16LeHex(0)
        const moduleTemp = '32'
        const gunTemp = '32'
        const reserved4 = ''.padEnd(8, '0')
        return `${meterVoltage}${meterCurrent}${meterEnergy}${moduleVoltage}${moduleCurrent}${moduleTemp}${gunTemp}${reserved4}`
      }
      const rt = chargingRuntimeByKey.get(`${pileId}:${gun.gunId}`)
      let s: JxChargeElectricalSample | null = rt?.lastSample ?? null
      if (!s) {
        const order = orderStore.listByPile(pileId).find((o) => o.status === 'charging' && o.gunId === gun.gunId)
        if (order) s = peekJxChargeElectricalSample(order, pile, 1)
      }
      const v = s?.pileVoltageV ?? 0
      const i = s?.pileCurrentA ?? 0
      const ek = rt?.energyKwh ?? s?.energyKwh ?? 0
      const meterVoltage = u16LeHexVoltage01V(v)
      const meterCurrent = u16LeHex(Math.min(65535, Math.max(0, Math.round(i * 100))))
      const meterEnergy = u32LeHex(Math.max(0, Math.round(ek * 10000)))
      const moduleVoltage = u16LeHexVoltage01V(v)
      const moduleCurrent = u16LeHexCurrent01A(i)
      const moduleTemp = '3a'
      const gunTemp = '37'
      const reserved4 = ''.padEnd(8, '0')
      return `${meterVoltage}${meterCurrent}${meterEnergy}${moduleVoltage}${moduleCurrent}${moduleTemp}${gunTemp}${reserved4}`
    })
    .join('')
  return `${makeTimeTag6Hex()}${phaseVoltage}${phaseVoltage}${phaseVoltage}${phaseCurrent}${phaseCurrent}${phaseCurrent}${totalMeter}${cabinetTemp}${inletTemp}${outletTemp}${boardTemp}${gunInnerTemp}${reserved8}${gunCountHex}${gunBlocks}`
}

function u32LeHex(n: number): string {
  const v = n >>> 0
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function u32BeHex(n: number): string {
  const v = n >>> 0
  return [(v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function makeTimePayload(): string {
  return makeTimeTag6Hex()
}

function makeSyncReplyPayload(result: 1 | 2 = 1, failReason = 0): string {
  const reason = Math.max(0, Math.min(255, failReason)).toString(16).padStart(2, '0')
  return `${makeTimeTag6Hex()}${result.toString(16).padStart(2, '0')}${reason}`
}

function makeTariffReplyPayload(modelVersion: number, result: 1 | 2 = 1, failReason = 0): string {
  const reason = Math.max(0, Math.min(255, failReason)).toString(16).padStart(2, '0')
  return `${makeTimeTag6Hex()}${u32LeHex(modelVersion)}${result.toString(16).padStart(2, '0')}${reason}`
}

function makeLoginPayload(
  hbSec: number,
  hbTimeout: number,
  teleSignalSec: number,
  telemetrySec: number,
  workInfoSec: number,
  tariffModelVersion: number,
  timeRef?: Date,
): string {
  return makeLoginPayloadStrict(
    hbSec,
    hbTimeout,
    teleSignalSec,
    telemetrySec,
    workInfoSec,
    tariffModelVersion,
    timeRef,
  )
}

export function ensureTcpEventListener() {
  if (tcpEventBound) return
  // 处理 HMR/重复装载场景：先移除旧监听，避免同一帧被多次处理
  if (unbindTcpEvent) {
    unbindTcpEvent()
    unbindTcpEvent = null
  }
  tcpEventBound = true
  unbindTcpEvent = window.unions.onJxTcpEvent((evt) => {
    const pileId = String(evt.pileId ?? '')
    if (!pileId) return
    const topo = useJxTopologyStore()
    const logs = useJxRuntimeLogStore()
    const orderStore = useJxOrderStore()
    if (evt.type === 'disconnected' || evt.type === 'error') {
      const pile = topo.piles.find((x) => x.pileId === pileId)
      const remote = pile ? `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}` : 'socket'
      resetJxPileSessionOnDisconnect(pileId)
      logs.appendLog(pileId, {
        t: Date.now(),
        pileId,
        command: 'TCP',
        direction: 'receive',
        remoteIp: remote,
        rawHex: '',
        structured: {
          type: evt.type,
          error: evt.error,
          detail: 'TCP断开，已释放运行时、桩枪车状态归零，充电中订单已停止',
        },
      })
    }
    if (evt.type === 'frame') {
      const pile = topo.piles.find((x) => x.pileId === pileId)
      const remote = pile ? `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}` : 'socket'
      const cmd = String(evt.cmd ?? 'TCP-FRAME')
      const dataHex = String(evt.dataHex ?? '')
      logs.appendLog(pileId, {
        t: Date.now(),
        pileId,
        command: cmd,
        direction: 'receive',
        remoteIp: remote,
        rawHex: toHexPairs(String(evt.frameHex ?? '')),
        structured: {
          type: 'frame',
          cmd,
          dataHex,
          decoded: decodeCmdPayload(cmd, dataHex, pile?.protocolId),
          frameHex: evt.frameHex,
        },
      })

      if (normalizeCmd(cmd) === '0x06' && pile) {
        const syncReplyPayload = makeSyncReplyPayload(1, 0)
        void tcpInvoke('send', {
          pileId,
          cmd: '0x07',
          pileNo: pile.pileId,
          dataHex: syncReplyPayload,
          timeoutMs: 5000,
        })
          .then((ret) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x07',
              direction: 'send',
              remoteIp: remote,
              rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
              structured: {
                type: 'auto-sync-reply',
                triggerCmd: '0x06',
                requestDataHex: syncReplyPayload,
                decoded: decodeCmdPayload('0x07', syncReplyPayload),
                ok: ret.ok === true,
                error: ret.ok === true ? undefined : String(ret.error ?? '自动回复0x07失败'),
              },
            })
          })
          .catch((error: unknown) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x07',
              direction: 'send',
              remoteIp: remote,
              rawHex: '',
              structured: {
                type: 'auto-sync-reply',
                triggerCmd: '0x06',
                error: String(error ?? '自动回复0x07失败'),
              },
            })
          })
      }

      if (normalizeCmd(cmd) === '0x0b' && pile) {
        const ctx = runtimeHeartbeatContext.get(pileId)
        if (ctx) {
          ctx.lastHeartbeatAt = Date.now()
          if (!ctx.firstHeartbeatReceived) {
            ctx.firstHeartbeatReceived = true
            const awaitTimer = loginAwaitHeartbeatTimers.get(pileId)
            if (awaitTimer) {
              clearTimeout(awaitTimer)
              loginAwaitHeartbeatTimers.delete(pileId)
            }
            topo.applyStatePatch(pileId, { status: 'idle', onlineState: 'online' })
            const undelivered = orderStore
              .listByPile(pileId)
              .filter(
                (x) =>
                  x.status === 'stopped' &&
                  x.delivery?.status !== 'delivered' &&
                  x.excludeFromOrderPush !== true,
              )
            for (const od of undelivered) {
              void sendOrderReportOnce(pileId, od, '0x33')
            }
            void enqueueTeleSignalSend(pileId)
            void sendTelemetryOnce(pileId)
            const oldTele = teleSignalTimers.get(pileId)
            if (oldTele) clearInterval(oldTele)
            const teleTimer = setInterval(() => {
              void enqueueTeleSignalSend(pileId)
            }, Math.max(1000, ctx.teleSignalSec * 1000))
            teleSignalTimers.set(pileId, teleTimer)
            const oldTelemetry = telemetryTimers.get(pileId)
            if (oldTelemetry) clearInterval(oldTelemetry)
            const telemetryTimer = setInterval(() => {
              void sendTelemetryOnce(pileId)
            }, Math.max(1000, ctx.telemetrySec * 1000))
            telemetryTimers.set(pileId, telemetryTimer)
          }
        }
        const heartbeatReplyPayload = makePileHeartbeatPayloadStrict(pile)
        void tcpInvoke('send', {
          pileId,
          cmd: '0x0c',
          pileNo: pile.pileId,
          dataHex: heartbeatReplyPayload,
          timeoutMs: 5000,
        })
          .then((ret) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x0c',
              direction: 'send',
              remoteIp: remote,
              rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
              structured: {
                type: 'auto-heartbeat-reply',
                triggerCmd: '0x0b',
                requestDataHex: heartbeatReplyPayload,
                decoded: decodeCmdPayload('0x0c', heartbeatReplyPayload),
                ok: ret.ok === true,
                error: ret.ok === true ? undefined : String(ret.error ?? '自动回复0x0c失败'),
              },
            })
          })
          .catch((error: unknown) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x0c',
              direction: 'send',
              remoteIp: remote,
              rawHex: '',
              structured: {
                type: 'auto-heartbeat-reply',
                triggerCmd: '0x0b',
                error: String(error ?? '自动回复0x0c失败'),
              },
            })
          })
      }

      if (normalizeCmd(cmd) === '0x59' && pile) {
        const body = (dataHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
        const parsed59 = parseVinStart59Payload(body)
        const gunNoHex =
          parsed59 && Number.isFinite(parsed59.gunNo)
            ? Math.max(0, Math.min(255, parsed59.gunNo)).toString(16).padStart(2, '0')
            : body.slice(12, 14).padStart(2, '0').slice(0, 2) || '00'
        const orderNo = parsed59?.orderNo?.trim() ?? ''
        const gunId = gunHexToGunId(pile, gunNoHex)
        const gun = gunId ? pile.guns.find((g) => g.gunId === gunId) : null
        const vin = String(gun?.vin ?? '').trim().toUpperCase()
        const cfg59 = scanQrVinConfigForPile(pileId)
        const business5b = evaluateScanQrVinBusinessChecks(pile, gun, vin)
        const reply5b = resolveScanQrVin5bReply(cfg59, business5b)

        if (parsed59 && orderNo) {
          const tariffSnapshot = tariffSnapshotForNewOrder(pile, null, false)
          const order: JxPileOrder = {
            orderNo,
            pileId,
            gunId: gunId ?? pile.guns[0]?.gunId ?? 'A',
            startAuthSource: '0x59-scan-vin',
            startType: 'immediate',
            startParam: '扫码VIN启动',
            startAt: Date.now(),
            status: 'created',
            tariffSnapshot,
            request23: {
              vin: vin || undefined,
              userType: 6,
              userId: vin,
              controlMode: 4,
              controlParam: 0,
              chargeMode: 1,
              startMode: 1,
              billingModelSelect: 1,
              billingModelSelect1f: 1,
              tariffModelVersionAtStart: tariffSnapshot.version,
            },
            process25: [],
            process30: [],
          }
          orderStore.upsertOrder(order)
        }

        const payload5b = buildVinStart5bPayload(gunNoHex, orderNo || 'UNKNOWN', reply5b.result, reply5b.reason)
        void tcpInvoke('send', { pileId, cmd: '0x5b', pileNo: pile.pileId, dataHex: payload5b, timeoutMs: 5000 })
          .then((ret5b) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x5b',
              direction: 'send',
              remoteIp: remote,
              rawHex: toHexPairs(String(ret5b.requestFrameHex ?? '')),
              structured: {
                type: 'scan-qr-vin-start-reply',
                triggerCmd: '0x59',
                requestDataHex: payload5b,
                decoded: decodeCmdPayload('0x5b', payload5b),
                ok: ret5b.ok === true,
              },
            })
          })
          .catch(() => {})

        if (!parsed59 || !orderNo) {
          logs.appendLog(pileId, {
            t: Date.now(),
            pileId,
            command: '0x59',
            direction: 'receive',
            remoteIp: remote,
            rawHex: toHexPairs(String(evt.frameHex ?? '')),
            structured: {
              type: 'scan-qr-vin-start-request',
              responseDataHex: body,
              ok: false,
              error: '0x59 报文解析失败或订单号为空',
            },
          })
          return
        }

        logs.appendLog(pileId, {
          t: Date.now(),
          pileId,
          command: '0x59',
          direction: 'receive',
          remoteIp: remote,
          rawHex: toHexPairs(String(evt.frameHex ?? '')),
          structured: {
            type: 'scan-qr-vin-start-request',
            responseDataHex: body,
            decoded: decodeCmdPayload('0x59', body),
            ok: true,
          },
        })

        if (reply5b.result === 2) {
          orderStore.updateOrderStatus(pileId, orderNo, {
            status: 'failed',
            failReasonCode: reply5b.reason,
            failReasonText: failReasonText(reply5b.reason),
          })
          return
        }

        orderStore.updateOrderStatus(pileId, orderNo, { status: 'start-accepted' })
        if (gun && gunId) {
          void runScanQrVinAuthContinuation(pileId, gunId, orderNo, vin)
        }
      }

      if (normalizeCmd(cmd) === '0x1f' && pile) {
        const body = (dataHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
        const d = decodeCmdPayload('0x1f', body, pile.protocolId) as Record<string, unknown>
        const gunNoHex =
          typeof d.gunNo === 'number' && Number.isFinite(d.gunNo)
            ? Math.max(0, Math.min(255, d.gunNo)).toString(16).padStart(2, '0')
            : body.slice(12, 14).padStart(2, '0').slice(0, 2) || '00'
        const orderNoRaw = String(d.orderNo ?? '').trim()
        const orderNo = orderNoRaw || `ORD-${Date.now()}`
        const controlMode = typeof d.controlMode === 'number' ? d.controlMode : 4
        const controlParam = typeof d.controlParam === 'number' ? d.controlParam : 0
        const userId = String(d.userId ?? '')
        const userType = typeof d.userType === 'number' ? d.userType : 0
        const orgCode = String(d.orgCode ?? '')
        const chargeMode = typeof d.chargeMode === 'number' ? d.chargeMode : 1
        const startMode = typeof d.startMode === 'number' ? d.startMode : 1
        const accountBalanceFen = typeof d.accountBalanceFen === 'number' ? d.accountBalanceFen : 0
        const scheduleStartTimeHex =
          body.length >= 198 ? body.slice(186, 198).padEnd(12, '0').slice(0, 12) : '000000000000'
        const rawSel = d.billingModelSelect1f ?? d.billingModelSelect
        const billingModelSelect1f: 1 | 2 = rawSel === 2 ? 2 : 1
        const embedded = (d.embeddedTariffModel ?? null) as ParsedTariffModel | null
        const tariffSnapshot = tariffSnapshotForNewOrder(pile, embedded, billingModelSelect1f === 2 && !!embedded)
        const gunId = gunHexToGunId(pile, gunNoHex)
        const gun = gunId ? pile.guns.find((g) => g.gunId === gunId) : null

        const order: JxPileOrder = {
          orderNo,
          pileId,
          gunId: gunId ?? pile.guns[0]?.gunId ?? 'A',
          startAuthSource: '0x1f-remote',
          startType: startMode === 2 ? 'scheduled' : 'immediate',
          startParam: `控制:${controlMode} 参数:${controlParam} 计费:${billingModelSelect1f}`,
          startAt: Date.now(),
          status: 'created',
          tariffSnapshot,
          request23: {
            userId,
            userType,
            orgCode,
            controlMode,
            controlParam,
            chargeMode,
            startMode,
            scheduleStartTime: typeof d.scheduleStartTime === 'string' ? d.scheduleStartTime : decodeTimeTag6(scheduleStartTimeHex),
            scheduleStartTimeWireHex: scheduleStartTimeHex.replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(12, '0').slice(0, 12),
            billingModelSelect1f,
            billingModelSelect: billingModelSelect1f,
            accountBalanceFen,
            tariffModelVersionAtStart: tariffSnapshot.version,
          },
          process25: [],
          process30: [],
        }
        orderStore.upsertOrder(order)

        let executeResult: 1 | 2 = 1
        let failReason = 0
        if (pile.onlineState !== 'online') {
          executeResult = 2
          failReason = 1
        } else if (!gun) {
          executeResult = 2
          failReason = 5
        } else if (gun.status === 'charging' || gun.status === 'occupied') {
          executeResult = 2
          failReason = 2
        } else if (gun.status !== 'linked') {
          executeResult = 2
          failReason = 6
        }

        if (executeResult === 2) {
          orderStore.updateOrderStatus(pileId, orderNo, {
            status: 'failed',
            failReasonCode: failReason,
            failReasonText: failReasonText(failReason),
          })
        } else {
          orderStore.updateOrderStatus(pileId, orderNo, { status: 'start-accepted' })
        }

        const payload20 = buildCm20PayloadFrom1f(body, executeResult, failReason)
        void tcpInvoke('send', { pileId, cmd: '0x20', pileNo: pile.pileId, dataHex: payload20, timeoutMs: 5000 })
          .then((ret) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x20',
              direction: 'send',
              remoteIp: remote,
              rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
              structured: {
                type: 'auto-remote-start-reply',
                requestDataHex: payload20,
                decoded: decodeCmdPayload('0x20', payload20),
                ok: ret.ok === true,
              },
            })
          })
          .catch(() => {})

        if (executeResult === 1 && gun) {
          const cfg = remoteConfigForPile(pileId)
          setTimeout(() => {
            const od = orderStore.listByPile(pileId).find((x) => x.orderNo === orderNo)
            const payload21 = make21Payload(pile, od, gunNoHex || '00', cfg.startResult, cfg.failReason)
            void tcpInvoke('send', { pileId, cmd: '0x21', pileNo: pile.pileId, dataHex: payload21, timeoutMs: 5000 })
              .then((ret) => {
                logs.appendLog(pileId, {
                  t: Date.now(),
                  pileId,
                  command: '0x21',
                  direction: 'send',
                  remoteIp: remote,
                  rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
                  structured: {
                    type: 'auto-start-result',
                    requestDataHex: payload21,
                    decoded: decodeCmdPayload('0x21', payload21, pile.protocolId),
                    ok: ret.ok === true,
                  },
                })
                pendingStartAck.set(`${pileId}:${gun.gunId}`, { orderNo, gunId: gun.gunId, startResult: cfg.startResult })
                if (cfg.startResult === 2) {
                  orderStore.updateOrderStatus(pileId, orderNo, {
                    status: 'failed',
                    failReasonCode: cfg.failReason,
                    failReasonText: failReasonText(cfg.failReason),
                  })
                } else {
                  orderStore.updateOrderStatus(pileId, orderNo, { status: 'starting' })
                }
              })
              .catch(() => {})
          }, 2000)
        }
      }

      if (normalizeCmd(cmd) === '0x22' && pile) {
        const body = (dataHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
        const gunNoHex = body.slice(12, 14)
        const gunId = gunHexToGunId(pile, gunNoHex)
        const pending = gunId ? pendingStartAck.get(`${pileId}:${gunId}`) : undefined
        if (pending && pending.startResult === 1) {
          topo.applyStatePatch(pileId, {
            status: 'charging',
            gunPatch: { gunId: pending.gunId, status: 'charging' },
          })
          orderStore.updateOrderStatus(pileId, pending.orderNo, { status: 'charging' })
          const key = `${pileId}:${pending.gunId}`
          stop25Push(pileId, pending.gunId)
          chargingRuntimeByKey.set(key, createInitialChargeRuntime())
          const workInfoSec = runtimeHeartbeatContext.get(pileId)?.workInfoSec ?? 15
          const timer = setInterval(() => {
            const order = orderStore.listByPile(pileId).find((x) => x.orderNo === pending.orderNo)
            if (!order || order.status !== 'charging') {
              stop25Push(pileId, pending.gunId)
              return
            }
            const rt = chargingRuntimeByKey.get(key) ?? createInitialChargeRuntime()
            chargingRuntimeByKey.set(key, rt)
            const sample = advanceJxChargeElectricalRuntime(rt, order, pile, workInfoSec)
            const p25 = build025PayloadWire(order, sample, workInfoSec, pile)
            const p30 = build030PayloadWire(order, sample, pile, workInfoSec)
            orderStore.updateLatest25Snapshot(pileId, pending.orderNo, p25.snapshot)
            orderStore.updateLatestBmsSnapshot(pileId, pending.orderNo, {
              at: Date.now(),
              soc: sample.soc,
              energyKwh: sample.energyKwh,
              bclVoltageReq: sample.bclVoltageV,
              bclCurrentReq: sample.bclCurrentA,
              bcsVoltage: sample.bcsVoltageV,
              bcsCurrent: sample.bcsCurrentA,
            })
            topo.applyStatePatch(pileId, {
              gunPatch: { gunId: pending.gunId, soc: sample.soc },
            })
            void tcpInvoke('send', { pileId, cmd: '0x25', pileNo: pile.pileId, dataHex: p25.payload, timeoutMs: 5000 })
              .then((ret) => {
                orderStore.appendProcessPoint(pileId, pending.orderNo, {
                  p25: {
                    t: Date.now(),
                    voltage: sample.pileVoltageV,
                    current: sample.pileCurrentA,
                    energy: sample.energyKwh,
                    amount: p25.snapshot.chargeAmountYuan,
                  },
                  p30: {
                    t: Date.now(),
                    bclVoltageReq: sample.bclVoltageV,
                    bclCurrentReq: sample.bclCurrentA,
                    bcsVoltage: sample.bcsVoltageV,
                    bcsCurrent: sample.bcsCurrentA,
                    soc: sample.soc,
                  },
                })
                logs.appendLog(pileId, {
                  t: Date.now(),
                  pileId,
                  command: '0x25',
                  direction: 'send',
                  remoteIp: remote,
                  rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
                  structured: {
                    type: 'auto-charging-info',
                    requestDataHex: p25.payload,
                    decoded: decodeCmdPayload('0x25', p25.payload),
                    ok: ret.ok === true,
                  },
                })
              })
              .catch(() => {})
            void tcpInvoke('send', { pileId, cmd: '0x30', pileNo: pile.pileId, dataHex: p30.payload, timeoutMs: 5000 })
              .then((ret) => {
                logs.appendLog(pileId, {
                  t: Date.now(),
                  pileId,
                  command: '0x30',
                  direction: 'send',
                  remoteIp: remote,
                  rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
                  structured: { type: 'auto-bms-info', requestDataHex: p30.payload, decoded: decodeCmdPayload('0x30', p30.payload), ok: ret.ok === true },
                })
              })
              .catch(() => {})
            const cfg = remoteConfigForPile(pileId)
            if (
              cfg.stopAmountThreshold > 0 &&
              order.request23?.controlMode === 3 &&
              p25.snapshot.accountBalanceYuan <= cfg.stopAmountThreshold
            ) {
              forceStopOrderCharging(pileId, pending.orderNo, '余额用尽', 1004)
            }
          }, Math.max(1000, workInfoSec * 1000))
          chargingInfoTimers.set(key, timer)
        }
      }

      if (normalizeCmd(cmd) === '0x26' && pile) {
        const body = (dataHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
        const gunNoHex = body.length >= 14 ? body.slice(12, 14) : '00'
        const orderFieldHex = body.length >= 78 ? body.slice(14, 78) : ''.padEnd(64, '0')
        const orderEchoHex = orderFieldHex.padEnd(64, '0').slice(0, 64)
        const gunId = gunHexToGunId(pile, gunNoHex)
        const orderEmpty = isOrder32FieldAllZeroHex(orderEchoHex)
        const reqOrderText = parseAsciiFixed(orderEchoHex)

        const chargingOnGun = orderStore
          .listByPile(pileId)
          .filter((o) => o.status === 'charging' && gunId !== null && o.gunId === gunId)

        let stopOk: 0 | 1 = 1
        let orderNoToStop: string | null = null

        if (!gunId) {
          stopOk = 1
        } else if (orderEmpty) {
          if (chargingOnGun.length >= 1) {
            stopOk = 0
            orderNoToStop = chargingOnGun[0].orderNo
          } else {
            stopOk = 1
          }
        } else {
          const hit = chargingOnGun.find((o) => o.orderNo.trim() === reqOrderText.trim())
          if (hit) {
            stopOk = 0
            orderNoToStop = hit.orderNo
          } else {
            stopOk = 1
          }
        }

        const replyPayload = make27StopReplyPayload(gunNoHex, orderEchoHex, stopOk)
        void tcpInvoke('send', { pileId, cmd: '0x27', pileNo: pile.pileId, dataHex: replyPayload, timeoutMs: 5000 })
          .then((ret) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x27',
              direction: 'send',
              remoteIp: remote,
              rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
              structured: {
                type: 'auto-stop-charge-reply',
                triggerCmd: '0x26',
                requestDataHex: replyPayload,
                decoded: decodeCmdPayload('0x27', replyPayload),
                stopMatched: stopOk === 0,
                ok: ret.ok === true,
                error: ret.ok === true ? undefined : String(ret.error ?? '自动回复0x27失败'),
              },
            })
          })
          .catch((error: unknown) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x27',
              direction: 'send',
              remoteIp: remote,
              rawHex: '',
              structured: {
                type: 'auto-stop-charge-reply',
                triggerCmd: '0x26',
                error: String(error ?? '自动回复0x27失败'),
              },
            })
          })

        if (stopOk === 0 && orderNoToStop) {
          forceStopOrderCharging(pileId, orderNoToStop, '平台停止充电(0x26)', 1002)
        }
      }

      if ((normalizeCmd(cmd) === '0x24' || normalizeCmd(cmd) === '0x34') && pile) {
        const body = (dataHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
        const orderNo = parseAsciiFixed(body.slice(22, 22 + 64))
        const ackResultHex = body.length >= 88 ? body.slice(86, 88) : ''
        const ackResult = ackResultHex ? Number.parseInt(ackResultHex, 16) : 1
        const delivered = !Number.isNaN(ackResult) ? ackResult === 1 : true
        const ackCmd = normalizeCmd(cmd) === '0x24' ? '0x24' : '0x34'
        if (orderNo) {
          orderStore.markOrderDelivered(pileId, orderNo, ackCmd, delivered)
        }
      }

      if (normalizeCmd(cmd) === '0x37' && pile) {
        const tariffModel = parseTariffModelFrom037(dataHex)
        const ok = !!tariffModel
        const modelVersion = tariffModel?.version ?? decodeU32Le(dataHex.slice(12, 20))
        if (tariffModel) {
          topo.applyStatePatch(pileId, { tariffModel })
        }
        const loginState = loginPending03State.get(pileId)
        if (ok && pile.onlineState !== 'online' && loginState?.waiting04) {
          loginState.restartByTariff = true
          void tcpInvoke('cancelPending', { pileId })
        }
        const tariffReplyPayload = makeTariffReplyPayload(modelVersion, ok ? 1 : 2, ok ? 0 : 3)
        void tcpInvoke('send', {
          pileId,
          cmd: '0x38',
          pileNo: pile.pileId,
          dataHex: tariffReplyPayload,
          timeoutMs: 5000,
        })
          .then((ret) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x38',
              direction: 'send',
              remoteIp: remote,
              rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
              structured: {
                type: 'auto-tariff-reply',
                triggerCmd: '0x37',
                requestDataHex: tariffReplyPayload,
                tariffModel,
                decoded: decodeCmdPayload('0x38', tariffReplyPayload),
                ok: ret.ok === true,
                error: ret.ok === true ? undefined : String(ret.error ?? '自动回复0x38失败'),
              },
            })
          })
          .catch((error: unknown) => {
            logs.appendLog(pileId, {
              t: Date.now(),
              pileId,
              command: '0x38',
              direction: 'send',
              remoteIp: remote,
              rawHex: '',
              structured: {
                type: 'auto-tariff-reply',
                triggerCmd: '0x37',
                error: String(error ?? '自动回复0x38失败'),
              },
            })
          })
      }
    }
  })
}

function stopHeartbeat(pileId: string) {
  const timer = heartbeatTimers.get(pileId)
  if (timer) {
    clearInterval(timer)
    heartbeatTimers.delete(pileId)
  }
  const tele = teleSignalTimers.get(pileId)
  if (tele) {
    clearInterval(tele)
    teleSignalTimers.delete(pileId)
  }
  const telem = telemetryTimers.get(pileId)
  if (telem) {
    clearInterval(telem)
    telemetryTimers.delete(pileId)
  }
  const loginAwait = loginAwaitHeartbeatTimers.get(pileId)
  if (loginAwait) {
    clearTimeout(loginAwait)
    loginAwaitHeartbeatTimers.delete(pileId)
  }
  runtimeHeartbeatContext.delete(pileId)
  teleSignalSendQueue.delete(pileId)
  stop25Push(pileId)
}

/** 释放桩侧定时器、推送队列与充电电气缓存；切换协议或从拓扑移除桩前可配合 TCP disconnect 使用 */
export function disposeJxPileRuntime(pileId: string): void {
  stopHeartbeat(pileId)
  loginPending03State.delete(pileId)
  pendingStartAck.delete(pileId)
  remoteStartConfigByPile.delete(pileId)
  scanQrVinStartConfigByPile.delete(pileId)
}

/**
 * TCP 断开（对端断链、套接字错误、或用户主动 disconnect）后统一处理：
 * 释放运行时定时器/缓存；将桩置离线、枪置空闲并清除 VIN/SOC；将进行中的充电相关订单标为已停止。
 */
export function resetJxPileSessionOnDisconnect(pileId: string): void {
  disposeJxPileRuntime(pileId)
  const orderStore = useJxOrderStore()
  const topo = useJxTopologyStore()
  orderStore.markActiveOrdersStoppedByDisconnect(pileId)
  topo.resetRuntimeAfterDisconnect(pileId)
}

async function sendTeleSignalOnce(pileId: string): Promise<void> {
  const topo = useJxTopologyStore()
  const logs = useJxRuntimeLogStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile) return
  if (pile.onlineState !== 'online') return
  const remote = `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}`
  const payload = makeTeleSignalPayloadStrict(pile)
  const ret = await tcpInvoke('send', {
    pileId,
    cmd: '0x09',
    pileNo: pile.pileId,
    dataHex: payload,
    timeoutMs: 5000,
  })
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: '0x09',
    direction: 'send',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
    structured: {
      type: 'tele-signal',
      requestDataHex: payload,
      decoded: decodeCmdPayload('0x09', payload),
      ok: ret.ok === true,
      error: ret.ok === true ? undefined : String(ret.error ?? '0x09发送失败'),
    },
  })
}

function enqueueTeleSignalSend(pileId: string): Promise<void> {
  const prev = teleSignalSendQueue.get(pileId) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(async () => {
      await sendTeleSignalOnce(pileId)
    })
    .finally(() => {
      if (teleSignalSendQueue.get(pileId) === next) {
        teleSignalSendQueue.delete(pileId)
      }
    })
  teleSignalSendQueue.set(pileId, next)
  return next
}

export function pushTeleSignalOnStateChange(pileId: string): void {
  // 状态变化推送不抢占周期发送；统一排队串行发送，避免并发交叉。
  void Promise.resolve().then(() => enqueueTeleSignalSend(pileId))
}

async function sendOrderReportOnce(pileId: string, order: JxPileOrder, cmd: '0x23' | '0x33'): Promise<void> {
  if (order.excludeFromOrderPush === true) return
  const topo = useJxTopologyStore()
  const logs = useJxRuntimeLogStore()
  const orderStore = useJxOrderStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile || pile.onlineState !== 'online') return
  const remote = `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}`
  const payload = make23Or33Payload(order, cmd)
  const decoded23 = decodeCmdPayload(cmd, payload, pile.protocolId)
  const ret = await tcpInvoke('send', {
    pileId,
    cmd,
    pileNo: pile.pileId,
    dataHex: payload,
    timeoutMs: 5000,
  })
  orderStore.markOrderPushed(pileId, order.orderNo, cmd)
  orderStore.updateLatest23Snapshot(pileId, order.orderNo, {
    timeTag: String(decoded23.timeTag ?? ''),
    gunNo: typeof decoded23.gunNo === 'number' ? decoded23.gunNo : null,
    recordIndex: Number(decoded23.recordIndex ?? 0),
    orderNo: String(decoded23.orderNo ?? order.orderNo),
    userId: String(decoded23.userId ?? ''),
    userType: Number(decoded23.userType ?? 0),
    orgCode: String(decoded23.orgCode ?? ''),
    chargingCardBalance:
      typeof decoded23.chargingCardBalance === 'number' ? decoded23.chargingCardBalance : undefined,
    vin: String(decoded23.vin ?? ''),
    startTime: String(decoded23.startTime ?? ''),
    endTime: String(decoded23.endTime ?? ''),
    startEnergy: Number(decoded23.startEnergy ?? 0),
    endEnergy: Number(decoded23.endEnergy ?? 0),
    startSoc: Number(decoded23.startSoc ?? 0),
    endSoc: Number(decoded23.endSoc ?? 0),
    controlMode: Number(decoded23.controlMode ?? 0),
    controlParam: Number(decoded23.controlParam ?? 0),
    startMode: Number(decoded23.startMode ?? 0),
    scheduleStartTime: String(decoded23.scheduleStartTime ?? ''),
    chargeMode: Number(decoded23.chargeMode ?? 0),
    stopReason: Number(decoded23.stopReason ?? 0),
    billingModelSelect: Number(decoded23.billingModelSelect ?? 0),
    modelVersion: Number(decoded23.modelVersion ?? 0),
    electricFee: Number(decoded23.electricFee ?? 0),
    serviceFee: Number(decoded23.serviceFee ?? 0),
    parkFee: Number(decoded23.parkFee ?? 0),
    segmentCount: Number(decoded23.segmentCount ?? 0),
    segments: Array.from({ length: Number(decoded23.segmentCount ?? 0) }, (_, i) => ({
      modelIndex: Number(decoded23[`segment${i}ModelIndex`] ?? 0),
      energyKwh: Number(decoded23[`segment${i}Energy`] ?? 0) / 10000,
    })).filter((x) => x.energyKwh > 0),
    batterySn: String(decoded23.batterySn ?? ''),
  })
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: cmd,
    direction: 'send',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
    structured: {
      type: cmd === '0x23' ? 'order-latest-push' : 'order-history-push',
      requestDataHex: payload,
      decoded: decoded23,
      ok: ret.ok === true,
      error: ret.ok === true ? undefined : String(ret.error ?? `${cmd}发送失败`),
    },
  })
}

export function reportStoppedOrderIfOnline(pileId: string, orderNo: string): void {
  const topo = useJxTopologyStore()
  const orderStore = useJxOrderStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile || pile.onlineState !== 'online') return
  const order = orderStore.listByPile(pileId).find((x) => x.orderNo === orderNo)
  if (!order) return
  if (order.excludeFromOrderPush === true) return
  const alreadyPushed = order.delivery?.pushed === true
  if (alreadyPushed) return
  void sendOrderReportOnce(pileId, order, '0x23')
}

async function sendTelemetryOnce(pileId: string): Promise<void> {
  const topo = useJxTopologyStore()
  const logs = useJxRuntimeLogStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile) return
  const remote = `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}`
  const payload = makeTelemetryPayloadStrict(pile)
  const ret = await tcpInvoke('send', {
    pileId,
    cmd: '0x0a',
    pileNo: pile.pileId,
    dataHex: payload,
    timeoutMs: 5000,
  })
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: '0x0a',
    direction: 'send',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
    structured: {
      type: 'telemetry',
      requestDataHex: payload,
      decoded: decodeCmdPayload('0x0a', payload),
      ok: ret.ok === true,
      error: ret.ok === true ? undefined : String(ret.error ?? '0x0a发送失败'),
    },
  })
}

function bindQrCodesToPile(pileId: string, qrGunCodes: string[]) {
  const topo = useJxTopologyStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile) return
  const orderedGuns = [...pile.guns]
  for (let i = 0; i < Math.min(orderedGuns.length, qrGunCodes.length); i += 1) {
    topo.applyStatePatch(pileId, {
      gunPatch: { gunId: orderedGuns[i].gunId, qrCode: qrGunCodes[i] },
    })
  }
}

async function tcpInvoke(
  action: 'connect' | 'disconnect' | 'send' | 'status' | 'cancelPending',
  data?: unknown,
): Promise<TcpInvokeResult> {
  return window.unions.jxTcpInvoke(action, data)
}

function isOk(r: TcpInvokeResult): boolean {
  return r.ok === true
}

function normalizeCmd(cmd: unknown): string {
  const s = String(cmd ?? '').trim().toLowerCase()
  if (!s) return ''
  return s.startsWith('0x') ? s : `0x${s}`
}

function parseAsciiFixed(hexRaw: string): string {
  return decodeAsciiFromHex(hexRaw).trim()
}

/** `0x26` / `0x27` 订单号字段：32 字节是否全为 0x00 */
function isOrder32FieldAllZeroHex(hexRaw: string): boolean {
  const h = (hexRaw || '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const p = h.padEnd(64, '0').slice(0, 64)
  return p.length === 64 && /^0+$/.test(p)
}

/** `0x27` 上行：时间标识(6) + 枪号(1) + 订单号(32) + 停止结果(1) */
function make27StopReplyPayload(gunNoHex2: string, orderNoFieldHex64: string, stopResult: 0 | 1): string {
  const gun = (gunNoHex2 || '00').replace(/[^0-9a-f]/gi, '').toLowerCase().padStart(2, '0').slice(0, 2)
  const ord = (orderNoFieldHex64 || '').replace(/[^0-9a-f]/gi, '').toLowerCase().padEnd(64, '0').slice(0, 64)
  return `${makeTimeTag6Hex()}${gun}${ord}${stopResult.toString(16).padStart(2, '0')}`
}

function parseU32Le(hexRaw: string): number {
  return decodeU32Le((hexRaw ?? '').slice(0, 8))
}

function gunHexToGunId(pile: JxTopologyPile, gunNoHex: string): string | null {
  const gunNo = Number.parseInt(gunNoHex || '0', 16)
  if (!Number.isFinite(gunNo)) return null
  return pile.guns[gunNo]?.gunId ?? null
}

function gunIdToGunNoHex(pile: JxTopologyPile, gunId: string): string {
  const idx = pile.guns.findIndex((g) => g.gunId === gunId)
  const gunNo = idx >= 0 ? idx : 0
  return Math.max(0, Math.min(255, gunNo)).toString(16).padStart(2, '0')
}

function make23Or33Payload(order: JxPileOrder, pushCmd: '0x23' | '0x33'): string {
  const topo = useJxTopologyStore()
  const pile = topo.piles.find((x) => x.pileId === order.pileId)
  return encodeOrder23Or33Payload(order, pushCmd, pile)
}

function failReasonText(code: number): string {
  const map: Record<number, string> = {
    0: '无',
    1: '设备故障',
    2: '充电枪使用中',
    3: '与预约用户不一致',
    4: '定时失败',
    5: '参数不支持',
    6: '其它',
  }
  return map[code] ?? `其它(${code})`
}

function remoteConfigForPile(pileId: string): RemoteStartRuntimeConfig {
  return (
    remoteStartConfigByPile.get(pileId) ?? {
      startResult: 1,
      failReason: 0,
      chargeModelId: 'builtin-default',
      stopAmountThreshold: 0,
    }
  )
}

export function setRemoteStartConfig(pileId: string, config: RemoteStartRuntimeConfig): void {
  remoteStartConfigByPile.set(pileId, config)
}

function scanQrVinConfigForPile(pileId: string): ScanQrVinStartRuntimeConfig {
  return (
    scanQrVinStartConfigByPile.get(pileId) ?? {
      simulate5bFail: false,
      reply5bFailReason: 6,
    }
  )
}

export function setScanQrVinStartConfig(pileId: string, config: ScanQrVinStartRuntimeConfig): void {
  scanQrVinStartConfigByPile.set(pileId, config)
}

function resolveScanQrVin5bReply(
  cfg: ScanQrVinStartRuntimeConfig,
  business: { result: 1 | 2; reason: number },
): { result: 1 | 2; reason: number } {
  if (cfg.simulate5bFail) {
    return { result: 2, reason: Math.max(1, Math.min(255, cfg.reply5bFailReason || 6)) }
  }
  return business
}

function evaluateScanQrVinBusinessChecks(
  pile: JxTopologyPile,
  gun: JxTopologyPile['guns'][number] | null | undefined,
  vin: string,
): { result: 1 | 2; reason: number } {
  if (pile.onlineState !== 'online') return { result: 2, reason: 1 }
  if (!gun) return { result: 2, reason: 5 }
  if (gun.status === 'charging' || gun.status === 'occupied') return { result: 2, reason: 2 }
  if (gun.status !== 'linked') return { result: 2, reason: 6 }
  if (vin.length < 8) return { result: 2, reason: 6 }
  return { result: 1, reason: 0 }
}

function dispatchVinAuth21After41(
  pile: JxTopologyPile,
  pileId: string,
  gunId: string,
  orderNo: string,
  authOk: boolean,
  parsed41: NonNullable<ReturnType<typeof parseVinAuth41Payload>>,
  remote: string,
): void {
  const orderStore = useJxOrderStore()
  const logs = useJxRuntimeLogStore()
  const cfg = remoteConfigForPile(pileId)
  const gunNoHex = gunIdToGunNoHex(pile, gunId)
  const startResult21: 1 | 2 = authOk ? cfg.startResult : 2
  const failReason21 = authOk ? cfg.failReason : Math.min(Math.max(parsed41.prohibitReason, 0), 255)

  setTimeout(() => {
    const od = orderStore.listByPile(pileId).find((x) => x.orderNo === orderNo)
    const payload21 = make21Payload(pile, od, gunNoHex || '00', startResult21, failReason21)
    void tcpInvoke('send', { pileId, cmd: '0x21', pileNo: pile.pileId, dataHex: payload21, timeoutMs: 5000 })
      .then((r21) => {
        logs.appendLog(pileId, {
          t: Date.now(),
          pileId,
          command: '0x21',
          direction: 'send',
          remoteIp: remote,
          rawHex: toHexPairs(String(r21.requestFrameHex ?? '')),
          structured: {
            type: 'vin-auth-start-result',
            requestDataHex: payload21,
            decoded: decodeCmdPayload('0x21', payload21, pile.protocolId),
            ok: r21.ok === true,
          },
        })
        pendingStartAck.set(`${pileId}:${gunId}`, { orderNo, gunId, startResult: startResult21 })
        if (!authOk) {
          orderStore.updateOrderStatus(pileId, orderNo, {
            status: 'failed',
            failReasonCode: parsed41.prohibitReason,
            failReasonText: vinAuthProhibitReasonText(parsed41.prohibitReason),
          })
        } else if (startResult21 === 2) {
          orderStore.updateOrderStatus(pileId, orderNo, {
            status: 'failed',
            failReasonCode: cfg.failReason,
            failReasonText: failReasonText(cfg.failReason),
          })
        } else {
          orderStore.updateOrderStatus(pileId, orderNo, { status: 'starting' })
        }
      })
      .catch(() => {})
  }, 2000)
}

/**
 * 扫码 VIN 启动：在 `0x59`/`0x5B` 成功后继续发送 `0x40`（带订单号）并等待 `0x41`，随后与 VIN 启动一致进入 `0x21`。
 */
async function runScanQrVinAuthContinuation(
  pileId: string,
  gunId: string,
  orderNo: string,
  vin: string,
): Promise<void> {
  const topo = useJxTopologyStore()
  const orderStore = useJxOrderStore()
  const logs = useJxRuntimeLogStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile) return

  const remote = `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}`
  const payload40 = buildVinAuth40Payload(pile, gunId, vin, orderNo)
  const ret = await tcpInvoke('send', {
    pileId,
    cmd: '0x40',
    pileNo: pile.pileId,
    dataHex: payload40,
    expectCmds: ['0x41'],
    timeoutMs: 15000,
  })
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: '0x40',
    direction: 'send',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
    structured: {
      type: 'scan-qr-vin-auth-request',
      requestDataHex: payload40,
      decoded: decodeCmdPayload('0x40', payload40),
      ok: ret.ok === true,
      error: ret.ok === true ? undefined : String(ret.error ?? ''),
    },
  })
  if (!isOk(ret)) {
    orderStore.updateOrderStatus(pileId, orderNo, {
      status: 'failed',
      failReasonText: String(ret.error ?? '等待 0x41 超时或发送失败'),
    })
    return
  }

  const body = String(ret.dataHex ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const parsed = parseVinAuth41Payload(body)
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: '0x41',
    direction: 'receive',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.frameHex ?? '')),
    structured: {
      type: 'scan-qr-vin-auth-reply',
      responseDataHex: body,
      decoded: parsed ? decodeCmdPayload('0x41', body) : { parseError: 'invalid 0x41' },
      ok: parsed !== null,
    },
  })
  if (!parsed) {
    orderStore.updateOrderStatus(pileId, orderNo, {
      status: 'failed',
      failReasonText: '0x41 报文解析失败',
    })
    return
  }

  const authOk = parsed.allowChargeFlag === 1
  const cfg = remoteConfigForPile(pileId)
  const excludeFromOrderPush = !authOk || cfg.startResult === 2
  const tariffSnapshot = tariffSnapshotForVin41Order(pile, parsed.embeddedTariffModel, parsed.billingModelSelect)

  const existing = orderStore.listByPile(pileId).find((x) => x.orderNo === orderNo)
  orderStore.upsertOrder({
    orderNo,
    pileId,
    gunId,
    startAuthSource: '0x59-scan-vin',
    startType: 'immediate',
    startParam: `扫码VIN billing=${parsed.billingModelSelect}`,
    startAt: existing?.startAt ?? Date.now(),
    status: authOk ? 'start-accepted' : 'failed',
    failReasonCode: authOk ? undefined : parsed.prohibitReason,
    failReasonText: authOk ? undefined : vinAuthProhibitReasonText(parsed.prohibitReason),
    excludeFromOrderPush,
    tariffSnapshot,
    request23: {
      vin: parsed.vin || vin,
      userType: 6,
      userId: vin,
      controlMode: 4,
      controlParam: 0,
      chargeMode: 1,
      startMode: 1,
      billingModelSelect: parsed.billingModelSelect,
      billingModelSelect1f: parsed.billingModelSelect,
      accountBalanceFen: parsed.accountBalanceFen,
      tariffModelVersionAtStart: tariffSnapshot.version,
    },
    process25: [],
    process30: [],
  })

  dispatchVinAuth21After41(pile, pileId, gunId, orderNo, authOk, parsed, remote)
}

export function forceStopOrderCharging(
  pileId: string,
  orderNo: string,
  reasonText = '急停按下',
  reasonCode = 1007,
): void {
  const topo = useJxTopologyStore()
  const orderStore = useJxOrderStore()
  const order = orderStore.listByPile(pileId).find((x) => x.orderNo === orderNo)
  if (!order) return
  stop25Push(pileId, order.gunId)
  topo.applyStatePatch(pileId, {
    status: 'idle',
    gunPatch: { gunId: order.gunId, status: 'linked', soc: undefined },
  })
  orderStore.updateOrderStatus(pileId, orderNo, {
    status: 'stopped',
    failReasonCode: reasonCode,
    failReasonText: reasonText,
  })
  reportStoppedOrderIfOnline(pileId, orderNo)
}

/**
 * 拓扑「VIN 鉴权启动」：上行 `0x40` 并等待 `0x41`。
 * 订单号始终本地生成（`VIN`+20 位数字），不采用平台 `0x41` 末尾订单号校验。
 * 鉴权失败仍会建单并上送 `0x21`（启动失败）；鉴权通过但模拟器配置启动失败时不做 `0x23`/`0x33` 订单推送。
 */
export async function runVinAuthRemoteStart(pileId: string, gunId: string): Promise<{ ok: boolean; error?: string }> {
  ensureTcpEventListener()
  const topo = useJxTopologyStore()
  const orderStore = useJxOrderStore()
  const logs = useJxRuntimeLogStore()
  const pile = topo.piles.find((x) => x.pileId === pileId)
  if (!pile) return { ok: false, error: '未找到桩' }
  if (pile.onlineState !== 'online') return { ok: false, error: '请先连接平台（桩需在线）' }
  const gun = pile.guns.find((g) => g.gunId === gunId)
  if (!gun) return { ok: false, error: '未找到充电枪' }
  const vin = String(gun.vin ?? '').trim().toUpperCase()
  if (vin.length < 8) return { ok: false, error: '请先填写有效 VIN（至少 8 位）' }
  if (gun.status === 'charging' || gun.status === 'occupied') return { ok: false, error: '当前枪占用或充电中，无法重复发起' }
  if (gun.status !== 'linked') return { ok: false, error: '枪需为「链接」状态（请先连接车辆）' }

  const remote = `${pile.tcpHost ?? '127.0.0.1'}:${pile.tcpPort ?? 9000}`
  /** VIN 启动：`0x40` 充电订单号域默认全 0；平台在 `0x41` 等后续报文分配或回显订单号 */
  const payload40 = buildVinAuth40Payload(pile, gunId, vin, '')
  const ret = await tcpInvoke('send', {
    pileId,
    cmd: '0x40',
    pileNo: pile.pileId,
    dataHex: payload40,
    expectCmds: ['0x41'],
    timeoutMs: 15000,
  })
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: '0x40',
    direction: 'send',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.requestFrameHex ?? '')),
    structured: {
      type: 'vin-auth-request',
      requestDataHex: payload40,
      decoded: decodeCmdPayload('0x40', payload40),
      ok: ret.ok === true,
      error: ret.ok === true ? undefined : String(ret.error ?? ''),
    },
  })
  if (!isOk(ret)) {
    return { ok: false, error: String(ret.error ?? '等待 0x41 超时或发送失败') }
  }
  const body = String(ret.dataHex ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  const parsed = parseVinAuth41Payload(body)
  logs.appendLog(pileId, {
    t: Date.now(),
    pileId,
    command: '0x41',
    direction: 'receive',
    remoteIp: remote,
    rawHex: toHexPairs(String(ret.frameHex ?? '')),
    structured: {
      type: 'vin-auth-reply',
      responseDataHex: body,
      decoded: parsed ? decodeCmdPayload('0x41', body) : { parseError: 'invalid 0x41' },
      ok: parsed !== null,
    },
  })
  if (!parsed) {
    return { ok: false, error: '0x41 报文解析失败' }
  }

  const authOk = parsed.allowChargeFlag === 1
  const cfg = remoteConfigForPile(pileId)
  /** 鉴权未通过、或模拟器配置启动失败：不上送 0x23/0x33 */
  const excludeFromOrderPush = !authOk || cfg.startResult === 2

  const orderNo = generateVinLedOrderNo()
  const tariffSnapshot = tariffSnapshotForVin41Order(pile, parsed.embeddedTariffModel, parsed.billingModelSelect)

  const baseOrder: JxPileOrder = {
    orderNo,
    pileId,
    gunId,
    startAuthSource: '0x40-vin',
    startType: 'immediate',
    startParam: `VIN鉴权 billing=${parsed.billingModelSelect}`,
    startAt: Date.now(),
    status: authOk ? 'start-accepted' : 'failed',
    failReasonCode: authOk ? undefined : parsed.prohibitReason,
    failReasonText: authOk ? undefined : vinAuthProhibitReasonText(parsed.prohibitReason),
    excludeFromOrderPush,
    tariffSnapshot,
    request23: {
      vin: parsed.vin || vin,
      userType: 6,
      userId: vin,
      controlMode: 4,
      controlParam: 0,
      chargeMode: 1,
      startMode: 1,
      billingModelSelect: parsed.billingModelSelect,
      billingModelSelect1f: parsed.billingModelSelect,
      accountBalanceFen: parsed.accountBalanceFen,
      tariffModelVersionAtStart: tariffSnapshot.version,
    },
    process25: [],
    process30: [],
  }
  orderStore.upsertOrder(baseOrder)

  dispatchVinAuth21After41(pile, pileId, gunId, orderNo, authOk, parsed, remote)

  if (!authOk) {
    return { ok: false, error: `鉴权未通过：${vinAuthProhibitReasonText(parsed.prohibitReason)}` }
  }
  if (cfg.startResult === 2) {
    return { ok: false, error: `启动失败：${failReasonText(cfg.failReason)}` }
  }
  return { ok: true }
}

function stop25Push(pileId: string, gunId?: string) {
  if (!gunId) {
    for (const key of [...chargingInfoTimers.keys()]) {
      if (key.startsWith(`${pileId}:`)) {
        const timer = chargingInfoTimers.get(key)
        if (timer) clearInterval(timer)
        chargingInfoTimers.delete(key)
      }
    }
    for (const k of [...chargingRuntimeByKey.keys()]) {
      if (k.startsWith(`${pileId}:`)) chargingRuntimeByKey.delete(k)
    }
    return
  }
  const key = `${pileId}:${gunId}`
  const timer = chargingInfoTimers.get(key)
  if (timer) clearInterval(timer)
  chargingInfoTimers.delete(key)
  chargingRuntimeByKey.delete(key)
}

export async function executeFlow(payload: ExecuteFlowPayload): Promise<{ ok: boolean; error?: string }> {
  const logs = useJxRuntimeLogStore()
  const topo = useJxTopologyStore()
  ensureTcpEventListener()

  const activePile = topo.piles.find((x) => x.pileId === payload.pileId)
  if (!activePile) return { ok: false, error: '未找到桩' }

  const hbSeconds = Number(payload.params.heartbeatIntervalSec ?? activePile.heartbeatIntervalSec ?? 30)
  const hbTimeoutLimit = Number(payload.params.allowTimeoutCount ?? activePile.allowTimeoutCount ?? 3)
  const teleSignalPeriodSec = Number(payload.params.teleSignalPeriodSec ?? 15)
  const telemetryPeriodSec = Number(payload.params.telemetryPeriodSec ?? 15)
  const workInfoPeriodSec = Number(payload.params.workInfoPeriodSec ?? 15)
  const host = activePile.tcpHost ?? '127.0.0.1'
  const port = activePile.tcpPort ?? 9000

  if (payload.flow.flowId === 'login-auth') {
    stopHeartbeat(payload.pileId)
    topo.applyStatePatch(payload.pileId, {
      status: 'offline',
      onlineState: 'offline',
      heartbeatIntervalSec: hbSeconds,
      allowTimeoutCount: hbTimeoutLimit,
    })

    await tcpInvoke('disconnect', { pileId: payload.pileId })

    const conn = await tcpInvoke('connect', {
      pileId: payload.pileId,
      host,
      port,
      timeoutMs: 5000,
    })
    if (!isOk(conn)) {
      return { ok: false, error: String(conn.error ?? 'TCP连接失败') }
    }
    logs.appendLog(payload.pileId, {
      t: Date.now(),
      pileId: payload.pileId,
      command: 'TCP',
      direction: 'send',
      remoteIp: `${host}:${port}`,
      rawHex: '',
      structured: {
        type: 'connected',
        detail: 'TCP连接成功',
      },
    })

    const connectPayload = makeConnectPayload(payload.protocolId, payload.params)
    const send01 = await tcpInvoke('send', {
      pileId: payload.pileId,
      cmd: '0x01',
      pileNo: activePile.pileId,
      dataHex: connectPayload,
      expectCmds: ['0x02', '0x04'],
      timeoutMs: 5000,
    })
    logs.appendLog(payload.pileId, {
      t: Date.now(),
      pileId: payload.pileId,
      command: '0x01',
      direction: 'send',
      remoteIp: `${host}:${port}`,
      rawHex: toHexPairs(String(send01.requestFrameHex ?? '')),
      structured: {
        type: 'login-step-01-request',
        requestDataHex: connectPayload,
        decoded: decodeCmdPayload('0x01', connectPayload),
      },
    })
    const cmdAfter01 = normalizeCmd(send01.cmd)
    logs.appendLog(payload.pileId, {
      t: Date.now(),
      pileId: payload.pileId,
      command: cmdAfter01 || '0x02/0x04',
      direction: 'receive',
      remoteIp: `${host}:${port}`,
      rawHex: toHexPairs(String(send01.frameHex ?? '')),
      structured: {
        type: 'login-step-02-or-04',
        responseCmd: cmdAfter01,
        frameHex: String(send01.frameHex ?? ''),
        dataHex: String(send01.dataHex ?? ''),
        decoded: decodeCmdPayload(cmdAfter01 || '0x02', String(send01.dataHex ?? '')),
        allowFlag: parseAllowFlag(String(send01.dataHex ?? '')),
        rejectReason: parseRejectReason(String(send01.dataHex ?? '')),
        ...send01,
      },
    })
    const frameAfter01 = String(send01.frameHex ?? '')
    const allowAfter01 = parseAllowFlag(String(send01.dataHex ?? ''))
    const allowAfter01Accepted =
      allowAfter01 === 0x01 || (cmdAfter01 === '0x04' && allowAfter01 === 0x03)
    const receivedAllowedResponseAfter01 =
      isOk(send01) &&
      (cmdAfter01 === '0x02' || cmdAfter01 === '0x04') &&
      frameAfter01.length > 0
    if (!receivedAllowedResponseAfter01 || !allowAfter01Accepted) {
      logs.appendLog(payload.pileId, {
        t: Date.now(),
        pileId: payload.pileId,
        command: 'TCP',
        direction: 'receive',
        remoteIp: `${host}:${port}`,
        rawHex: '',
        structured: {
          skipped: true,
          detail: '未收到有效0x02或0x02未通过，禁止发送0x03登录请求',
        },
      })
      stopHeartbeat(payload.pileId)
      await tcpInvoke('disconnect', { pileId: payload.pileId })
      topo.applyStatePatch(payload.pileId, { status: 'offline', onlineState: 'offline' })
      return {
        ok: false,
        error: String(
          send01.error ??
            (!receivedAllowedResponseAfter01
              ? '未收到0x02/0x04应答'
              : cmdAfter01 !== '0x02' && cmdAfter01 !== '0x04'
              ? `请求连接应答命令异常(${cmdAfter01 || 'empty'})`
              : `请求连接被拒绝(${parseRejectReason(String(send01.dataHex ?? '')) ?? -1})`),
        ),
      }
    }

    const qrFrom01 = cmdAfter01 === '0x04' ? parseQrCodesFrom04(String(send01.dataHex ?? '')) : null
    if (qrFrom01) {
      bindQrCodesToPile(payload.pileId, qrFrom01.qrGunCodes)
      logs.appendLog(payload.pileId, {
        t: Date.now(),
        pileId: payload.pileId,
        command: '0x04',
        direction: 'receive',
        remoteIp: `${host}:${port}`,
        rawHex: '',
        structured: {
          type: 'qr-associated',
          allowFlag: qrFrom01.allowFlag,
          qrCount: qrFrom01.qrGunCodes.length,
          detail: '已按001..N顺序写入枪二维码',
        },
      })
    }

    const loginAbnormalRef = resolveLoginAbnormalTimeRef(payload.params)
    const loginPayload = makeLoginPayload(
      hbSeconds,
      hbTimeoutLimit,
      teleSignalPeriodSec,
      telemetryPeriodSec,
      workInfoPeriodSec,
      Number(topo.piles.find((x) => x.pileId === payload.pileId)?.tariffModel?.version ?? DEFAULT_TARIFF_MODEL_VERSION),
      loginAbnormalRef,
    )
    const send03 = await tcpInvoke('send', {
      pileId: payload.pileId,
      cmd: '0x03',
      pileNo: activePile.pileId,
      dataHex: loginPayload,
      timeoutMs: 5000,
    })
    logs.appendLog(payload.pileId, {
      t: Date.now(),
      pileId: payload.pileId,
      command: '0x03',
      direction: 'send',
      remoteIp: `${host}:${port}`,
      rawHex: toHexPairs(String(send03.requestFrameHex ?? '')),
      structured: {
        type: 'login-step-03-request',
        requestDataHex: loginPayload,
        decoded: decodeCmdPayload('0x03', loginPayload),
        ok: send03.ok === true,
        error: send03.ok === true ? undefined : send03.error,
      },
    })
    if (!isOk(send03)) {
      stopHeartbeat(payload.pileId)
      await tcpInvoke('disconnect', { pileId: payload.pileId })
      topo.applyStatePatch(payload.pileId, { status: 'offline', onlineState: 'offline' })
      return { ok: false, error: String(send03.error ?? '发送0x03失败') }
    }

    runtimeHeartbeatContext.set(payload.pileId, {
      hbSec: hbSeconds,
      hbTimeoutCount: hbTimeoutLimit,
      teleSignalSec: teleSignalPeriodSec,
      telemetrySec: telemetryPeriodSec,
      workInfoSec: workInfoPeriodSec,
      firstHeartbeatReceived: false,
      lastHeartbeatAt: Date.now(),
    })

    const awaitTimer = setTimeout(async () => {
      const ctx = runtimeHeartbeatContext.get(payload.pileId)
      if (!ctx || ctx.firstHeartbeatReceived) return
      stopHeartbeat(payload.pileId)
      await tcpInvoke('disconnect', { pileId: payload.pileId })
      topo.applyStatePatch(payload.pileId, { status: 'offline', onlineState: 'offline' })
      logs.appendLog(payload.pileId, {
        t: Date.now(),
        pileId: payload.pileId,
        command: 'TCP',
        direction: 'receive',
        remoteIp: `${host}:${port}`,
        rawHex: '',
        structured: {
          type: 'login-heartbeat-timeout',
          detail: `发送0x03后一个心跳周期(${hbSeconds}s)内未收到0x0b，已断开`,
        },
      })
    }, Math.max(1000, hbSeconds * 1000))
    loginAwaitHeartbeatTimers.set(payload.pileId, awaitTimer)

    const watchdogTimer = setInterval(async () => {
      const ctx = runtimeHeartbeatContext.get(payload.pileId)
      if (!ctx || !ctx.firstHeartbeatReceived) return
      const timeoutMs = Math.max(1000, ctx.hbSec * ctx.hbTimeoutCount * 1000)
      if (Date.now() - ctx.lastHeartbeatAt <= timeoutMs) return
      stopHeartbeat(payload.pileId)
      await tcpInvoke('disconnect', { pileId: payload.pileId })
      topo.applyStatePatch(payload.pileId, { status: 'offline', onlineState: 'offline' })
      logs.appendLog(payload.pileId, {
        t: Date.now(),
        pileId: payload.pileId,
        command: 'TCP',
        direction: 'receive',
        remoteIp: `${host}:${port}`,
        rawHex: '',
        structured: {
          type: 'heartbeat-timeout',
          detail: `超时次数*周期(${ctx.hbTimeoutCount}*${ctx.hbSec}s)内未收到0x0b，已断开`,
        },
      })
    }, 1000)
    heartbeatTimers.set(payload.pileId, watchdogTimer)

    return { ok: true }
  }

  for (const step of payload.flow.steps) {
    if (step.type === 'delay' && typeof step.ms === 'number') {
      await new Promise((r) => setTimeout(r, step.ms))
      continue
    }

    if (step.type === 'send' && step.cmd) {
      logs.appendLog(payload.pileId, {
        t: Date.now(),
        pileId: payload.pileId,
        command: step.cmd,
        direction: 'send',
        remoteIp: `${host}:${port}`,
        rawHex: fakeHex(step.cmd, 'send'),
        structured: {
          cmd: step.cmd,
          direction: 'down',
          protocolId: payload.protocolId,
          params: payload.params,
        },
      })
      continue
    }

    if (step.type === 'expect' && step.cmd) {
      await new Promise((r) => setTimeout(r, Math.min(step.timeoutMs ?? 1000, 1000)))
      logs.appendLog(payload.pileId, {
        t: Date.now(),
        pileId: payload.pileId,
        command: step.cmd,
        direction: 'receive',
        remoteIp: `${host}:${port}`,
        rawHex: fakeHex(step.cmd, 'receive'),
        structured: {
          cmd: step.cmd,
          direction: 'up',
          resultCode: 1,
        },
      })
      continue
    }

    if (step.type === 'emitState' && step.statePatch) {
      topo.applyStatePatch(payload.pileId, {
        status: step.statePatch.pileStatus as 'idle' | 'charging' | 'offline' | 'fault' | undefined,
      })
      continue
    }
  }

  topo.applyStatePatch(payload.pileId, { status: 'charging', onlineState: 'online' })
  return { ok: true }
}
