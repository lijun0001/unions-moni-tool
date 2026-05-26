/**
 * `0x21` 启动鉴权结果上报：线格式与 `CM21Data` 反射顺序对齐（直流桩尾部 68 字节见 {@link make021DcTailHex}）。
 * 版本差异时可通过 {@link register021WireEncoder} 挂载替代编码（当前 V2.24/V2.25 服务端共用解析）。
 */
import { cm21StartElectRawFromKwh } from './jx-protocol-profile'
import type { JxPileOrder, JxTopologyPile } from './types'

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

export function resolve021UserExtras(
  pile: JxTopologyPile | undefined,
  order: JxPileOrder | undefined,
): { userType: number; userId: string } | undefined {
  if (!order) return undefined
  const src = order.startAuthSource ?? '0x1f-remote'
  if (src === '0x19-card') {
    const ut = typeof order.request23?.userType === 'number' ? order.request23.userType : 3
    return { userType: Math.max(0, Math.min(0xffff, ut)), userId: order.request23?.userId ?? '' }
  }
  if (src === '0x40-vin' || src === '0x59-scan-vin') {
    const gun = pile?.guns.find((g) => g.gunId === order.gunId)
    return { userType: 6, userId: gun?.vin ?? '' }
  }
  const ut = order.request23?.userType
  const n = typeof ut === 'number' && Number.isFinite(ut) ? Math.trunc(ut) : 0
  return { userType: Math.max(0, Math.min(0xffff, n)), userId: order.request23?.userId ?? '' }
}

/**
 * 直流桩 `0x21` 表-3.9.7 序号 16～39：与 `CM21Data` 反射字段顺序一致（68 字节）。
 * BCP-SOC：服务端按 `ONE_POINT`（0.1）换算；此处送 `SOC(%)×10` 无符号整型。
 */
function make021DcTailHex(pile: JxTopologyPile, order: JxPileOrder | undefined): string {
  const gun = order ? pile.guns.find((g) => g.gunId === order.gunId) : undefined
  const vin = gun?.vin ?? ''
  const socTenths =
    typeof gun?.soc === 'number' && Number.isFinite(gun.soc)
      ? Math.max(0, Math.min(1000, Math.round(gun.soc * 10)))
      : 0
  const z16 = () => u16LeHex(0)
  return [
    z16(),
    z16(),
    z16(),
    '000000',
    '00',
    z16(),
    z16(),
    asciiFixedHex('', 4),
    u32LeHex(0),
    '00',
    '00',
    '00',
    '000000',
    '00',
    '00',
    asciiFixedHex(vin, 17),
    asciiFixedHex('', 8),
    z16(),
    z16(),
    z16(),
    z16(),
    '00',
    u16LeHex(socTenths),
    z16(),
  ].join('')
}

/** 默认：表-3.9.7，变长（失败 101B / 交流成功 111B / 直流成功 179B）。 */
export function encodeCm21DefaultLayout(ctx: {
  pile: JxTopologyPile
  order: JxPileOrder | undefined
  gunNoHex: string
  startResult: 1 | 2
  failReason: number
  chargeStartEnergyKwh: number
}): string {
  const { pile, order, gunNoHex, startResult, failReason, chargeStartEnergyKwh } = ctx
  const users = resolve021UserExtras(pile, order) ?? { userType: 0, userId: '' }
  const orderNo = order?.orderNo ?? ''
  const r23 = order?.request23
  const gun = (gunNoHex || '00').replace(/[^0-9a-f]/gi, '').toLowerCase().padStart(2, '0').slice(0, 2)
  const orgHex = asciiFixedHex(r23?.orgCode ?? '', 9)
  const plateHex = asciiFixedHex('', 9)
  const controlModeHex = Math.max(0, Math.min(255, r23?.controlMode ?? 4)).toString(16).padStart(2, '0')
  const controlParamHex = u32LeHex(Math.max(0, Math.trunc(r23?.controlParam ?? 0)))
  const chargeModeHex = Math.max(0, Math.min(255, r23?.chargeMode ?? 1)).toString(16).padStart(2, '0')
  const pileTypeVal = pile.deviceKind === 'ac' ? 1 : 2
  const pileTypeHex = pileTypeVal.toString(16).padStart(2, '0')
  const startResHex = Math.max(1, Math.min(2, startResult)).toString(16).padStart(2, '0')
  const failHex = u16LeHex(Math.max(0, Math.min(0xffff, Math.trunc(failReason))))

  let body = `${makeTimeTag6Hex()}${gun}${asciiFixedHex(orderNo, 32)}${asciiFixedHex(users.userId ?? '', 32)}${u16LeHex(
    users.userType ?? 0,
  )}${orgHex}${plateHex}${controlModeHex}${controlParamHex}${chargeModeHex}${pileTypeHex}${startResHex}${failHex}`

  if (startResult === 2) return body

  const tCharge0 = makeTimeTag6Hex(new Date(order?.startAt ?? Date.now()))
  body += `${tCharge0}${u32LeHex(cm21StartElectRawFromKwh(chargeStartEnergyKwh))}`

  if (pileTypeVal === 1) return body

  body += make021DcTailHex(pile, order)
  return body
}

const registry021 = new Map<string, typeof encodeCm21DefaultLayout>()

export function register021WireEncoder(protocolIdPattern: string, encoder: typeof encodeCm21DefaultLayout): void {
  registry021.set(protocolIdPattern.toLowerCase(), encoder)
}

register021WireEncoder('default', encodeCm21DefaultLayout)

export function resolve021WireAdapter(protocolId: string | undefined): typeof encodeCm21DefaultLayout {
  if (!protocolId) return encodeCm21DefaultLayout
  const id = protocolId.toLowerCase()
  if (registry021.has(id)) return registry021.get(id)!
  for (const [key, enc] of registry021) {
    if (key !== 'default' && id.includes(key)) return enc
  }
  return encodeCm21DefaultLayout
}

/**
 * 表-3.9.7 上行 `0x21` 数据域（纯 hex，小写）。
 */
export function make21Payload(
  pile: JxTopologyPile,
  order: JxPileOrder | undefined,
  gunNoHex: string,
  startResult: 1 | 2,
  failReason: number,
  chargeStartEnergyKwh = 0,
): string {
  const encoder = resolve021WireAdapter(pile.protocolId)
  return encoder({ pile, order, gunNoHex, startResult, failReason, chargeStartEnergyKwh })
}
