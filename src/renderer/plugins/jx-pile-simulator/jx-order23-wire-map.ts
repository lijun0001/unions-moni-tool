/**
 * `0x23` / `0x33` 订单报文体：按桩 `protocolId` 解析为 wire profile，再映射编解码。
 * 新增协议版本时：在 `JxOrder23WireProfile` 与 `order23WireProfileFromProtocolId` 中登记，
 * 并在 `encodeOrder23Or33Payload` / `decodeOrder23IntoOut` 中实现对应分支。
 * 其它命令若需同一套 V2.24/V2.25 分支，请从 `jx-protocol-profile.ts` 复用 `order23WireProfileFromProtocolId`。
 */
import type { JxPileOrder, JxTopologyPile } from './types'

const DEFAULT_TARIFF_MODEL_VERSION = 1

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

function decodeAsciiFromHex(hexRaw: string): string {
  const hex = (hexRaw ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  let s = ''
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16)
    if (byte === 0x00) break
    s += String.fromCharCode(byte)
  }
  return s
}

function parseAsciiFixed(hexRaw: string): string {
  return decodeAsciiFromHex(hexRaw).trim()
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

function encodeU40Le(n: number): string {
  let v = Math.max(0, Math.min(0xffffffffff, Math.round(n)))
  const bytes: number[] = []
  for (let i = 0; i < 5; i += 1) {
    bytes.push(v & 0xff)
    v = Math.floor(v / 256)
  }
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function decodeU16Le(hex: string): number {
  const h = hex.replace(/[^0-9a-f]/gi, '')
  if (h.length < 4) return 0
  return Number.parseInt(h.slice(0, 2), 16) | (Number.parseInt(h.slice(2, 4), 16) << 8)
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
  let acc = 0
  for (let i = 0; i < 5; i += 1) {
    acc += Number.parseInt(h.slice(i * 2, i * 2 + 2), 16) * 256 ** i
  }
  return acc
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

export type JxOrder23WireProfile = 'v2.24' | 'v2.25'

/** `protocolId` 含 `2.24` / `v2.24` / `jx-v2.24-core` → V2.24；缺省及其它 → V2.25（与内置 `jx-v2.25-core` 等一致）。 */
export function order23WireProfileFromProtocolId(protocolId: string | undefined): JxOrder23WireProfile {
  if (!protocolId) return 'v2.25'
  const id = protocolId.toLowerCase()
  if (id.includes('2.24') || id.includes('v2.24') || id === 'jx-v2.24-core') return 'v2.24'
  return 'v2.25'
}

/** `0x1F` 选「本报文费率」时，上行 `0x23`/`0x33` 填 `4`；选本地模型填 `1`（与启动一致）。 */
export function order23WireBillingModelSelect(order: JxPileOrder): number {
  const sel1f = order.request23?.billingModelSelect1f
  if (sel1f === 2) return 4
  if (sel1f === 1) return 1
  const leg = order.request23?.billingModelSelect
  if (leg === 2) return 4
  if (typeof leg === 'number' && leg >= 1 && leg <= 4) return leg
  return 1
}

function gunIdToGunNoHex(pile: JxTopologyPile, gunId: string): string {
  const idx = pile.guns.findIndex((g) => g.gunId === gunId)
  const gunNo = idx >= 0 ? idx : 0
  return Math.max(0, Math.min(255, gunNo)).toString(16).padStart(2, '0')
}

/** 上行推送：按桩协议拼接 `0x23`/`0x33` 数据域（不含帧头） */
export function encodeOrder23Or33Payload(
  order: JxPileOrder,
  pushCmd: '0x23' | '0x33',
  pile: JxTopologyPile | undefined,
): string {
  const profile = order23WireProfileFromProtocolId(pile?.protocolId)
  const gunNoHex = pile ? gunIdToGunNoHex(pile, order.gunId) : '00'
  const recordIndex = u32LeHex(Math.max(1, (order.startAt >>> 0) & 0x7fffffff))
  const orderNo = asciiFixedHex(order.orderNo, 32)
  const userId = asciiFixedHex(order.request23?.userId ?? '', 32)
  const userType = u16LeHex(order.request23?.userType ?? 29)
  const orgCode = asciiFixedHex(order.request23?.orgCode ?? '', 9)
  const gun = pile?.guns.find((g) => g.gunId === order.gunId)
  const vin = asciiFixedHex(gun?.vin ?? '', 17)
  const begin = makeTimeTag6Hex(new Date(order.startAt))
  const endTs = order.stoppedAt ?? Date.now()
  const end = makeTimeTag6Hex(new Date(endTs))
  const energyEndKwh = order.latest25?.chargeEnergyKwh ?? order.process25?.at(-1)?.energy ?? 0
  const p30 = order.process30 ?? []
  const startSocVal = p30.length > 0 ? Math.max(0, Math.min(100, Math.round(p30[0].soc))) : 0
  const endSocVal = p30.length > 0 ? Math.max(0, Math.min(100, Math.round(p30[p30.length - 1].soc))) : startSocVal
  const beginSoc = Math.max(0, Math.min(255, startSocVal)).toString(16).padStart(2, '0')
  const endSoc = Math.max(0, Math.min(255, endSocVal)).toString(16).padStart(2, '0')
  const controlMode = (order.request23?.controlMode ?? 4).toString(16).padStart(2, '0')
  const controlParam = u32LeHex(order.request23?.controlParam ?? 0)
  const startMode = (order.request23?.startMode ?? (order.startType === 'scheduled' ? 2 : 1)).toString(16).padStart(2, '0')
  const scheduleWire = (order.request23?.scheduleStartTimeWireHex ?? '000000000000')
    .replace(/[^0-9a-f]/gi, '')
    .toLowerCase()
    .padEnd(12, '0')
    .slice(0, 12)
  const chargeMode = (order.request23?.chargeMode ?? 1).toString(16).padStart(2, '0')
  const stopReasonCode =
    typeof order.failReasonCode === 'number' && Number.isFinite(order.failReasonCode)
      ? Math.max(0, Math.min(0xffff, order.failReasonCode))
      : order.status === 'stopped'
        ? 1
        : 0
  const stopReason = u16LeHex(stopReasonCode)
  const modelSelect = order23WireBillingModelSelect(order).toString(16).padStart(2, '0')
  const modelVersion = u32LeHex(
    order.tariffSnapshot?.version ??
      order.request23?.tariffModelVersionAtStart ??
      pile?.tariffModel?.version ??
      DEFAULT_TARIFF_MODEL_VERSION,
  )
  const eleFee = u32LeHex(Math.round((order.latest25?.electricFeeYuan ?? 0) * 100))
  const svcFee = u32LeHex(Math.round((order.latest25?.serviceFeeYuan ?? 0) * 100))
  const parkFee = u32LeHex(0)
  const segmentsWithEnergy = (order.latest25?.segments ?? []).filter((x) => x.energyKwh > 0)
  const segCountNum = Math.min(20, Math.max(1, segmentsWithEnergy.length))
  const segCount = segCountNum.toString(16).padStart(2, '0')

  if (profile === 'v2.24') {
    /** V2.24：起止/段电量与平台 `CM23Data224`/`OrderHandler224`（FOUR_POINT）一致；`controlParam` 仍为原样 u32（定电量等为 0.01 量级，与电量字段无关） */
    const cardBal = u32LeHex(Math.max(0, Math.round((order.request23?.chargingCardBalanceYuan ?? 0) * 100)))
    const beginEnergy = u32LeHex(0)
    const endEnergy = u32LeHex(Math.max(0, Math.min(0xffffffff, Math.round(energyEndKwh * 10000))))
    const segmentHex =
      segmentsWithEnergy.length > 0
        ? segmentsWithEnergy
            .slice(0, 20)
            .map(
              (x) =>
                `${Math.max(0, Math.min(255, x.modelIndex)).toString(16).padStart(2, '0')}${u32LeHex(
                  Math.max(0, Math.round(x.energyKwh * 10000)),
                )}`,
            )
            .join('')
        : `00${u32LeHex(Math.max(0, Math.round(energyEndKwh * 10000)))}`
    const batterySn = asciiFixedHex(pushCmd === '0x33' ? 'HISTORY-SN' : 'LATEST-SN', 27)
    return `${makeTimeTag6Hex()}${gunNoHex}${recordIndex}${orderNo}${userId}${userType}${orgCode}${cardBal}${vin}${begin}${end}${beginEnergy}${endEnergy}${beginSoc}${endSoc}${controlMode}${controlParam}${startMode}${scheduleWire}${chargeMode}${stopReason}${modelSelect}${modelVersion}${eleFee}${svcFee}${parkFee}${segCount}${segmentHex}${batterySn}`
  }

  const batterySn = asciiFixedHex(pushCmd === '0x33' ? 'HISTORY-SN' : 'LATEST-SN', 17)
  const beginEnergy = encodeU40Le(0)
  const endEnergy = encodeU40Le(Math.max(0, Math.round(energyEndKwh * 10000)))
  const segmentHex =
    segmentsWithEnergy.length > 0
      ? segmentsWithEnergy
          .slice(0, 20)
          .map(
            (x) =>
              `${Math.max(0, Math.min(255, x.modelIndex)).toString(16).padStart(2, '0')}${u32LeHex(
                Math.max(0, Math.round(x.energyKwh * 10000)),
              )}`,
          )
          .join('')
      : `00${u32LeHex(Math.max(0, Math.round(energyEndKwh * 10000)))}`
  return `${makeTimeTag6Hex()}${gunNoHex}${recordIndex}${orderNo}${userId}${userType}${orgCode}${vin}${begin}${end}${beginEnergy}${endEnergy}${beginSoc}${endSoc}${controlMode}${controlParam}${startMode}${scheduleWire}${chargeMode}${stopReason}${modelSelect}${modelVersion}${eleFee}${svcFee}${parkFee}${segCount}${segmentHex}${batterySn}`
}

/**
 * 解析 `0x23`/`0x33` 数据域写入 `out`（与 `decodeCmdPayload` 共用 `take`，便于 segments 记录）。
 * **V2.24**：报文内为 4 字节小端整数 ×0.0001 kWh（与 Java `CovertConst.FOUR_POINT`）；解码后 `startEnergy`/`endEnergy`/分段 energy 为 **0.0001 kWh 整数**，与 `latest23`/segments 一致。
 * **V2.25**：起止电量 5 字节；分段 1+4 字节。
 */
export function decodeOrder23IntoOut(
  out: Record<string, unknown>,
  take: (name: string, bytes: number) => string,
  protocolId: string | undefined,
): void {
  const profile = order23WireProfileFromProtocolId(protocolId)
  if (profile === 'v2.24') {
    const timeTag = take('timeTag', 6)
    const gunNo = take('gunNo', 1)
    const recordIndex = take('recordIndex', 4)
    const orderNo = take('orderNo', 32)
    const userId = take('userId', 32)
    const userType = take('userType', 2)
    const orgCode = take('orgCode', 9)
    const chargingCardBalance = take('chargingCardBalance', 4)
    const vin = take('vin', 17)
    const startTime = take('startTime', 6)
    const endTime = take('endTime', 6)
    const startEnergy = take('startEnergy', 4)
    const endEnergy = take('endEnergy', 4)
    const startSoc = take('startSoc', 1)
    const endSoc = take('endSoc', 1)
    const controlMode = take('controlMode', 1)
    const controlParam = take('controlParam', 4)
    const startMode = take('startMode', 1)
    const scheduleStartTime = take('scheduleStartTime', 6)
    const chargeMode = take('chargeMode', 1)
    const stopReason = take('stopReason', 2)
    const billingModelSelect = take('billingModelSelect', 1)
    const modelVersion = take('modelVersion', 4)
    const electricFee = take('electricFee', 4)
    const serviceFee = take('serviceFee', 4)
    const parkFee = take('parkFee', 4)
    const segmentCountHex = take('segmentCount', 1)
    const segmentCount = segmentCountHex ? Number.parseInt(segmentCountHex, 16) : 0
    const segmentEntries: Array<{ modelIndex: number; energy: number }> = []
    for (let i = 0; i < segmentCount; i += 1) {
      const segModelIndexHex = take(`segment${i}ModelIndex`, 1)
      const segEnergyHex = take(`segment${i}Energy`, 4)
      segmentEntries.push({
        modelIndex: segModelIndexHex ? Number.parseInt(segModelIndexHex, 16) : 0,
        energy: decodeU32Le(segEnergyHex),
      })
    }
    const batterySn = take('batterySn', 27)
    out.orderPayloadVariant = 'v2.24'
    out.timeTag = decodeTimeTag6(timeTag)
    out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
    out.recordIndex = decodeU32Le(recordIndex)
    out.orderNo = parseAsciiFixed(orderNo)
    out.userId = parseAsciiFixed(userId)
    out.userType = decodeU16Le(userType)
    out.orgCode = parseAsciiFixed(orgCode)
    out.chargingCardBalance = decodeU32Le(chargingCardBalance)
    out.vin = parseAsciiFixed(vin)
    out.startTime = decodeTimeTag6(startTime)
    out.endTime = decodeTimeTag6(endTime)
    out.startEnergy = decodeU32Le(startEnergy)
    out.endEnergy = decodeU32Le(endEnergy)
    out.startSoc = startSoc ? Number.parseInt(startSoc, 16) : null
    out.endSoc = endSoc ? Number.parseInt(endSoc, 16) : null
    out.controlMode = controlMode ? Number.parseInt(controlMode, 16) : null
    out.controlParam = decodeU32Le(controlParam)
    out.startMode = startMode ? Number.parseInt(startMode, 16) : null
    out.scheduleStartTime = decodeTimeTag6(scheduleStartTime)
    out.chargeMode = chargeMode ? Number.parseInt(chargeMode, 16) : null
    out.stopReason = decodeU16Le(stopReason)
    out.billingModelSelect = billingModelSelect ? Number.parseInt(billingModelSelect, 16) : null
    out.modelVersion = decodeU32Le(modelVersion)
    out.electricFee = decodeU32Le(electricFee)
    out.serviceFee = decodeU32Le(serviceFee)
    out.parkFee = decodeU32Le(parkFee)
    out.segmentCount = segmentCount
    out.batterySn = parseAsciiFixed(batterySn)
    for (let i = 0; i < segmentEntries.length; i += 1) {
      out[`segment${i}ModelIndex`] = segmentEntries[i].modelIndex
      out[`segment${i}Energy`] = segmentEntries[i].energy
    }
    return
  }

  const timeTag = take('timeTag', 6)
  const gunNo = take('gunNo', 1)
  const recordIndex = take('recordIndex', 4)
  const orderNo = take('orderNo', 32)
  const userId = take('userId', 32)
  const userType = take('userType', 2)
  const orgCode = take('orgCode', 9)
  const vin = take('vin', 17)
  const startTime = take('startTime', 6)
  const endTime = take('endTime', 6)
  const startEnergy = take('startEnergy', 5)
  const endEnergy = take('endEnergy', 5)
  const startSoc = take('startSoc', 1)
  const endSoc = take('endSoc', 1)
  const controlMode = take('controlMode', 1)
  const controlParam = take('controlParam', 4)
  const startMode = take('startMode', 1)
  const scheduleStartTime = take('scheduleStartTime', 6)
  const chargeMode = take('chargeMode', 1)
  const stopReason = take('stopReason', 2)
  const billingModelSelect = take('billingModelSelect', 1)
  const modelVersion = take('modelVersion', 4)
  const electricFee = take('electricFee', 4)
  const serviceFee = take('serviceFee', 4)
  const parkFee = take('parkFee', 4)
  const segmentCountHex = take('segmentCount', 1)
  const segmentCount = segmentCountHex ? Number.parseInt(segmentCountHex, 16) : 0
  const segmentEntries: Array<{ modelIndex: number; energy: number }> = []
  for (let i = 0; i < segmentCount; i += 1) {
    const segModelIndexHex = take(`segment${i}ModelIndex`, 1)
    const segEnergyHex = take(`segment${i}Energy`, 4)
    segmentEntries.push({
      modelIndex: segModelIndexHex ? Number.parseInt(segModelIndexHex, 16) : 0,
      energy: decodeU32Le(segEnergyHex),
    })
  }
  const batterySn = take('batterySn', 17)
  out.orderPayloadVariant = 'v2.25'
  out.timeTag = decodeTimeTag6(timeTag)
  out.gunNo = gunNo ? Number.parseInt(gunNo, 16) : null
  out.recordIndex = decodeU32Le(recordIndex)
  out.orderNo = parseAsciiFixed(orderNo)
  out.userId = parseAsciiFixed(userId)
  out.userType = decodeU16Le(userType)
  out.orgCode = parseAsciiFixed(orgCode)
  out.vin = parseAsciiFixed(vin)
  out.startTime = decodeTimeTag6(startTime)
  out.endTime = decodeTimeTag6(endTime)
  out.startEnergy = decodeU40Le(startEnergy)
  out.endEnergy = decodeU40Le(endEnergy)
  out.startSoc = startSoc ? Number.parseInt(startSoc, 16) : null
  out.endSoc = endSoc ? Number.parseInt(endSoc, 16) : null
  out.controlMode = controlMode ? Number.parseInt(controlMode, 16) : null
  out.controlParam = decodeU32Le(controlParam)
  out.startMode = startMode ? Number.parseInt(startMode, 16) : null
  out.scheduleStartTime = decodeTimeTag6(scheduleStartTime)
  out.chargeMode = chargeMode ? Number.parseInt(chargeMode, 16) : null
  out.stopReason = decodeU16Le(stopReason)
  out.billingModelSelect = billingModelSelect ? Number.parseInt(billingModelSelect, 16) : null
  out.modelVersion = decodeU32Le(modelVersion)
  out.electricFee = decodeU32Le(electricFee)
  out.serviceFee = decodeU32Le(serviceFee)
  out.parkFee = decodeU32Le(parkFee)
  out.segmentCount = segmentCount
  out.batterySn = parseAsciiFixed(batterySn)
  for (let i = 0; i < segmentEntries.length; i += 1) {
    out[`segment${i}ModelIndex`] = segmentEntries[i].modelIndex
    out[`segment${i}Energy`] = segmentEntries[i].energy
  }
}
