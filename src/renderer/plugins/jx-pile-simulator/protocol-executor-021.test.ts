import { describe, expect, it } from 'vitest'
import { decodeCmdPayload, make21Payload } from './protocol-executor'
import type { JxPileOrder, JxTopologyPile } from './types'

function pileBase(over: Partial<JxTopologyPile> = {}): JxTopologyPile {
  return {
    pileId: 'p1',
    protocolId: 'jx-2.25',
    status: 'idle',
    heartbeatIntervalSec: 30,
    allowTimeoutCount: 3,
    guns: [{ gunId: 'A', status: 'linked', vin: 'LGWEEUK59PE000001', soc: 88 }],
    ...over,
  }
}

function orderBase(over: Partial<JxPileOrder> = {}): JxPileOrder {
  return {
    orderNo: 'ORD001',
    pileId: 'p1',
    gunId: 'A',
    startAuthSource: '0x1f-remote',
    startType: 'immediate',
    startParam: '',
    startAt: 1_700_000_000_000,
    status: 'start-accepted',
    request23: {
      userId: 'user-remote-1',
      userType: 0x0201,
      orgCode: 'ORG000001',
      controlMode: 4,
      controlParam: 0,
      chargeMode: 1,
    },
    process25: [],
    process30: [],
    ...over,
  }
}

describe('0x21 表-3.9.7', () => {
  it('启动失败时仅 101 字节前缀', () => {
    const p = pileBase()
    const o = orderBase()
    const hex = make21Payload(p, o, '00', 2, 5)
    expect(hex.length).toBe(101 * 2)
    const d = decodeCmdPayload('0x21', hex, p.protocolId)
    expect(d.startResult).toBe(2)
    expect(d.failReason).toBe(5)
    expect(d.userType).toBe(0x0201)
    expect(d.orderNo).toContain('ORD001')
  })

  it('成功 + 交流桩在起始电量后结束（111 字节）', () => {
    const p = pileBase({ deviceKind: 'ac' })
    const o = orderBase()
    const hex = make21Payload(p, o, '00', 1, 0)
    expect(hex.length).toBe(111 * 2)
    const d = decodeCmdPayload('0x21', hex, p.protocolId)
    expect(d.startResult).toBe(1)
    expect(d.pileType).toBe(1)
    expect(d.chargeStartEnergyKwh).toBe(0)
  })

  it('成功 + 直流桩带 68 字节 BRM/BCP 尾（179 字节）', () => {
    const p = pileBase({ deviceKind: 'dc' })
    const o = orderBase()
    const hex = make21Payload(p, o, '00', 1, 0)
    expect(hex.length).toBe(179 * 2)
    const d = decodeCmdPayload('0x21', hex, p.protocolId) as Record<string, unknown>
    expect(d.startResult).toBe(1)
    expect(d.pileType).toBe(2)
    expect(d.brmVin).toContain('LGW')
    expect(d.bcpSocRaw).toBe(880)
    expect(d.bcpSoc).toBeCloseTo(88, 5)
  })

  it('直流 0x21：BRM-VIN 优先取订单 request23.vin（VIN/扫码VIN 鉴权）', () => {
    const p = pileBase({
      deviceKind: 'dc',
      guns: [{ gunId: 'A', status: 'linked', vin: undefined, soc: 50 }],
    })
    const o = orderBase({
      startAuthSource: '0x40-vin',
      request23: {
        vin: 'LFPH3A1A0R1234567',
        userType: 6,
        userId: 'LFPH3A1A0R1234567',
        controlMode: 4,
        controlParam: 0,
        chargeMode: 1,
      },
    })
    const hex = make21Payload(p, o, '00', 1, 0)
    const d = decodeCmdPayload('0x21', hex, p.protocolId) as Record<string, unknown>
    expect(String(d.brmVin ?? '').trim()).toBe('LFPH3A1A0R1234567')
    expect(String(d.userId ?? '').trim()).toBe('LFPH3A1A0R1234567')
    expect(d.userType).toBe(6)
  })

  it('直流 0x21：扫码VIN 订单无枪 VIN 时仍写入 BRM-VIN', () => {
    const p = pileBase({
      deviceKind: 'dc',
      guns: [{ gunId: 'A', status: 'linked', lastVin: 'WVWZZZ3CZWE123456', soc: 40 }],
    })
    const o = orderBase({
      startAuthSource: '0x59-scan-vin',
      request23: {
        userType: 6,
        userId: 'WVWZZZ3CZWE123456',
        controlMode: 4,
        controlParam: 0,
        chargeMode: 1,
      },
    })
    const hex = make21Payload(p, o, '00', 1, 0)
    const d = decodeCmdPayload('0x21', hex, p.protocolId) as Record<string, unknown>
    expect(String(d.brmVin ?? '').trim()).toBe('WVWZZZ3CZWE123456')
  })

  it('V2.24：充电起始电量按 0.0001kWh 编解码', () => {
    const p = pileBase({ protocolId: 'jx-v2.24-core', deviceKind: 'ac' })
    const o = orderBase()
    const hex = make21Payload(p, o, '00', 1, 0, 12.3456)
    const d = decodeCmdPayload('0x21', hex, 'jx-v2.24-core')
    expect(d.chargeStartEnergyKwh).toBeCloseTo(12.3456, 4)
  })

  it('V2.25：充电起始电量与服务端一致按 0.0001kWh 编解码', () => {
    const p = pileBase({ protocolId: 'jx-v2.25-core', deviceKind: 'ac' })
    const o = orderBase()
    const hex = make21Payload(p, o, '00', 1, 0, 12.3456)
    const d = decodeCmdPayload('0x21', hex, 'jx-v2.25-core')
    expect(d.chargeStartEnergyKwh).toBeCloseTo(12.3456, 4)
  })
})
