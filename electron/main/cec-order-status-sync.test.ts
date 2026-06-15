import { describe, expect, it } from 'vitest'
import { applyChargeStatusToOrder, isQueryChargeStatusResponseUsable } from './cec-http-server'
import type { CecOrderRecord } from '../../src/shared/cec-types'

function makeOrder(overrides: Partial<CecOrderRecord> = {}): CecOrderRecord {
  return {
    id: 'order-1',
    linkUuid: 'link-1',
    startChargeSeq: '232134123240000000000000001',
    connectorId: '1',
    productState: 'starting',
    protocolState: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    samples: [],
    rawEvents: [],
    ...overrides,
  }
}

describe('isQueryChargeStatusResponseUsable', () => {
  it('accepts response with StartChargeSeqStat when SuccStat omitted', () => {
    expect(isQueryChargeStatusResponseUsable({ StartChargeSeqStat: 2, TotalPower: 1 })).toBe(true)
  })

  it('rejects SuccStat=1 even with StartChargeSeqStat', () => {
    expect(isQueryChargeStatusResponseUsable({ SuccStat: 1, StartChargeSeqStat: 2 })).toBe(false)
  })

  it('rejects response without SuccStat and unknown stat', () => {
    expect(isQueryChargeStatusResponseUsable({ StartChargeSeqStat: 5 })).toBe(false)
  })
})

describe('applyChargeStatusToOrder', () => {
  it('ignores unknown StartChargeSeqStat and leaves order unchanged', () => {
    const order = makeOrder()
    const next = applyChargeStatusToOrder(order, { StartChargeSeqStat: 5 }, 2_000)
    expect(next).toBe(order)
  })

  it('updates protocol/product state for stat 2', () => {
    const order = makeOrder()
    const next = applyChargeStatusToOrder(
      order,
      { StartChargeSeqStat: 2, TotalPower: 3.5, TotalMoney: 10 },
      2_000,
    )
    expect(next.protocolState).toBe(2)
    expect(next.productState).toBe('charging')
    expect(next.samples).toHaveLength(1)
    expect(next.orderInfo).toBeUndefined()
  })

  it('writes orderInfo when stat is 4', () => {
    const order = makeOrder({ protocolState: 2, productState: 'charging' })
    const next = applyChargeStatusToOrder(
      order,
      {
        StartChargeSeqStat: 4,
        TotalPower: 15.5,
        ElecMoney: 23.25,
        SeviceMoney: 7.75,
        TotalMoney: 31,
        StartTime: '2024-01-01 10:00:00',
        EndTime: '2024-01-01 10:30:00',
        SumPeriod: 1,
        ChargeDetails: [
          {
            DetailStartTime: '2024-01-01 10:00:00',
            DetailEndTime: '2024-01-01 10:30:00',
            DetailPower: 15.5,
          },
        ],
      },
      2_000,
    )
    expect(next.protocolState).toBe(4)
    expect(next.productState).toBe('completed')
    expect(next.orderInfo).toMatchObject({
      totalPower: 15.5,
      totalElecMoney: 23.25,
      totalSeviceMoney: 7.75,
      totalMoney: 31,
      startTime: '2024-01-01 10:00:00',
      endTime: '2024-01-01 10:30:00',
      sumPeriod: 1,
    })
    expect(next.orderInfo?.chargeDetails).toHaveLength(1)
  })

  it('reads Soc field per protocol spelling', () => {
    const order = makeOrder()
    const next = applyChargeStatusToOrder(order, { StartChargeSeqStat: 2, Soc: 66.5 }, 2_000)
    expect(next.samples.at(-1)?.soc).toBe(66.5)
  })
})
