import { describe, expect, it } from 'vitest'
import { buildCm20PayloadFrom1f, decodeCmdPayload } from './protocol-executor'

function u16LeHex(n: number): string {
  const v = n & 0xffff
  return [(v & 0xff).toString(16).padStart(2, '0'), ((v >> 8) & 0xff).toString(16).padStart(2, '0')].join('')
}

function u32LeHex(n: number): string {
  const v = n >>> 0
  return [(v & 0xff), (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

function asciiFixedHex(text: string, len: number): string {
  const bytes = [...text.padEnd(len, '\0').slice(0, len)].map((c) => c.charCodeAt(0))
  return bytes.map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** 构造 billing=1 的最小 0x1F 数据域（106 字节） */
function buildMinimal1fBody(): string {
  let hex = '1905190a0b0c' // 平台下发时标（回复 0x20 时应被替换）
  hex += '00' // gun
  hex += asciiFixedHex('ORD-TEST-001', 32)
  hex += asciiFixedHex('USER-001', 32)
  hex += u16LeHex(1) // user type
  hex += asciiFixedHex('ORG001', 9)
  hex += '04' // control mode: auto full
  hex += u32LeHex(0) // control param
  hex += u32LeHex(10000) // account balance 100.00 yuan — must be stripped in 0x20
  hex += '01' // charge mode
  hex += '01' // start mode immediate
  hex += '000000000000' // schedule
  hex += asciiFixedHex('123456', 6) // oc code
  hex += '01' // billing model select: local
  expect(hex.length).toBe(212)
  return hex
}

describe('buildCm20PayloadFrom1f', () => {
  it('strips account balance and yields 104 bytes when billing=1', () => {
    const body1f = buildMinimal1fBody()
    const hex20 = buildCm20PayloadFrom1f(body1f, 1, 0)
    expect(hex20.length).toBe(208)
    expect(hex20.slice(-4)).toBe('0100') // ret=1 success, reason=0

    const d20 = decodeCmdPayload('0x20', hex20) as Record<string, unknown>
    expect(d20.executeResult).toBe(1)
    expect(d20.failReason).toBe(0)
    expect(d20.billingModelSelect).toBe(1)
    expect(d20.gunNo).toBe(0)
    expect(String(d20.orderNo ?? '').trim()).toBe('ORD-TEST-001')
    expect(d20.accountBalanceFen).toBeUndefined()

    const d1f = decodeCmdPayload('0x1f', body1f) as Record<string, unknown>
    expect(d20.controlMode).toBe(d1f.controlMode)
    expect(d20.controlParam).toBe(d1f.controlParam)
    expect(d20.chargeMode).toBe(d1f.chargeMode)
    expect(d20.timeTag).not.toBe(d1f.timeTag)
  })

  it('appends embedded tariff block when billing=2', () => {
    let body1f = buildMinimal1fBody()
    body1f = body1f.slice(0, -2) + '02' // billing select = embedded
    body1f += u32LeHex(100) // version
    body1f += u32LeHex(0) // parking
    body1f += '01' // 1 period
    body1f += '000003' // 00:00 flat
    body1f += u32LeHex(8000) // electric 0.8
    body1f += u32LeHex(2000) // service 0.2

    const hex20 = buildCm20PayloadFrom1f(body1f, 1, 0)
    expect(hex20.length).toBe(248) // 104 + 20 extension
    const d20 = decodeCmdPayload('0x20', hex20) as Record<string, unknown>
    expect(d20.billingModelSelect).toBe(2)
    expect(d20.embeddedTariffModel).toBeTruthy()
    expect(d20.executeResult).toBe(1)
  })

  it('encodes failure ret/reason', () => {
    const hex20 = buildCm20PayloadFrom1f(buildMinimal1fBody(), 2, 2)
    const d20 = decodeCmdPayload('0x20', hex20) as Record<string, unknown>
    expect(d20.executeResult).toBe(2)
    expect(d20.failReason).toBe(2)
  })
})
