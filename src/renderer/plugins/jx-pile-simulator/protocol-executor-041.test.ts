import { describe, expect, it } from 'vitest'
import {
  decodeCmdPayload,
  formatVin41DenyMessage,
  formatVinStartFailureMessage,
  isVin41AllowCharge,
  parseVinAuth41Payload,
} from './protocol-executor'

describe('VIN 0x41 allowChargeFlag', () => {
  it('isVin41AllowCharge accepts only flag 1', () => {
    expect(isVin41AllowCharge(1)).toBe(true)
    expect(isVin41AllowCharge(2)).toBe(false)
  })

  it('formatVinStartFailureMessage prefixes reason', () => {
    expect(formatVinStartFailureMessage('请先连接平台（桩需在线）')).toBe(
      'VIN启动失败：请先连接平台（桩需在线）',
    )
    expect(formatVinStartFailureMessage('VIN启动失败：已提示')).toBe('VIN启动失败：已提示')
  })

  it('formatVin41DenyMessage explains prohibit reason when denied', () => {
    expect(formatVin41DenyMessage(1, 0)).toBe('')
    expect(formatVin41DenyMessage(2, 3)).toBe('VIN启动失败：平台禁止充电（黑名单）')
  })
})

describe('parseVinAuth41Payload (表 3.8.4 / 71+11N)', () => {
  it('parses billing=2: embedded tariff + order field at byte 39+11N', () => {
    const timeTag = '00'.repeat(6)
    const vin = '56'.repeat(17)
    const balance = '00000000'
    const allow = '01'
    const prohibit = '00'
    const billing = '02'
    const head = `${timeTag}${vin}${balance}${allow}${prohibit}${billing}`
    expect(head.length).toBe(60)

    const ver = '01000000'
    const park = '00000000'
    const periodCount = '01'
    /* 1.0 元/kWh 量级：原始值 0x2710，小端 10270000 */
    const period11 =
      '08' + '00' + '01' + '10270000' + '10270000'

    const orderRaw = 'ORDER-UNIT-TEST-PARSE-41________'.padEnd(32, ' ')
    expect(orderRaw.length).toBe(32)
    const orderHex = [...Buffer.from(orderRaw, 'latin1')].map((b) => b.toString(16).padStart(2, '0')).join('')

    const body = `${head}${ver}${park}${periodCount}${period11}${orderHex}`
    expect(body.length).toBe(164)

    const p = parseVinAuth41Payload(body)
    expect(p).not.toBeNull()
    expect(p!.billingModelSelect).toBe(2)
    expect(p!.allowChargeFlag).toBe(1)
    expect(p!.embeddedTariffModel?.periods.length).toBe(1)
    expect(p!.embeddedTariffModel?.periods[0].electricRate).toBeCloseTo(1, 5)
    expect(p!.orderNo).toBe(orderRaw.trim())

    const dec = decodeCmdPayload('0x41', body) as {
      segments?: Array<{ name?: string }>
      tariffModelVersion?: number
      periodCount?: number
      orderNo?: string
    }
    const names = (dec.segments ?? []).map((s) => String(s.name ?? ''))
    expect(names).toContain('tariffModelVersion')
    expect(names).toContain('parkingRate')
    expect(names).toContain('periodCount')
    expect(names).toContain('period1StartHour')
    expect(names).toContain('orderNo')
    expect(dec.tariffModelVersion).toBe(1)
    expect(dec.periodCount).toBe(1)
    expect(dec.orderNo?.trim()).toBe(orderRaw.trim())
  })
})
