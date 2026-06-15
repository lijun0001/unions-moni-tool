import { describe, expect, it } from 'vitest'
import { buildOrderTariffSnapshotForOrder } from './protocol-executor'
import type { JxPileOrder, JxTopologyPile } from './types'

function makePile(tariffModel?: JxTopologyPile['tariffModel']): JxTopologyPile {
  return {
    pileId: 'P1',
    protocolId: 'jx-v2.24-core',
    status: 'idle',
    heartbeatIntervalSec: 30,
    allowTimeoutCount: 3,
    guns: [{ gunId: 'A', status: 'linked' }],
    onlineState: 'online',
    tariffModel,
  }
}

function baseOrder(overrides: Partial<JxPileOrder> = {}): JxPileOrder {
  return {
    orderNo: 'ORD1',
    pileId: 'P1',
    gunId: 'A',
    startType: 'immediate',
    startParam: '',
    startAt: Date.now(),
    status: 'created',
    process25: [],
    process30: [],
    ...overrides,
  }
}

describe('buildOrderTariffSnapshotForOrder', () => {
  it('uses pending embedded tariff when billing=2 on 0x1f remote start', () => {
    const pile = makePile({
      version: 1,
      parkingRate: 0.1,
      updatedAt: 1,
      periods: [{ index: 1, startHour: 0, startMinute: 0, type: 3, electricRate: 0.5, serviceRate: 0.1 }],
    })
    const order = baseOrder({
      startAuthSource: '0x1f-remote',
      request23: {
        billingModelSelect1f: 2,
        billingModelSelect: 2,
        pendingEmbeddedTariff: {
          version: 9,
          parkingRate: 0.2,
          updatedAt: 2,
          periods: [{ index: 1, startHour: 8, startMinute: 0, type: 2, electricRate: 1.2, serviceRate: 0.3 }],
        },
      },
    })
    const snap = buildOrderTariffSnapshotForOrder(pile, order)
    expect(snap.source).toBe('0x1f-embedded')
    expect(snap.version).toBe(9)
    expect(snap.periods[0]?.electricRate).toBe(1.2)
  })

  it('uses pile local tariff when billing=1', () => {
    const pile = makePile({
      version: 3,
      parkingRate: 0.1,
      updatedAt: 1,
      periods: [{ index: 1, startHour: 0, startMinute: 0, type: 3, electricRate: 0.88, serviceRate: 0.12 }],
    })
    const order = baseOrder({
      startAuthSource: '0x40-vin',
      request23: { billingModelSelect: 1, billingModelSelect1f: 1 },
    })
    const snap = buildOrderTariffSnapshotForOrder(pile, order)
    expect(snap.source).toBe('0x41-vin-local')
    expect(snap.version).toBe(3)
    expect(snap.periods[0]?.electricRate).toBe(0.88)
  })
})
