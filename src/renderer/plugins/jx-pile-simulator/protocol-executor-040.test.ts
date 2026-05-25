import { describe, expect, it } from 'vitest'
import { buildVinAuth40Payload, decodeCmdPayload, parseCm40DataDomainOrderNo } from './protocol-executor'
import type { JxTopologyPile } from './types'

describe('buildVinAuth40Payload (CM40Data224 layout)', () => {
  const pile: JxTopologyPile = {
    pileId: '001',
    protocolId: 'jx-v2.24-core',
    status: 'idle',
    heartbeatIntervalSec: 30,
    allowTimeoutCount: 3,
    guns: [{ gunId: 'A', status: 'linked', vin: 'LGWEEUK59PE000001' }],
  }

  it('emits 56 bytes: time(6)+vin(17)+gun(1)+order(32)', () => {
    const hex = buildVinAuth40Payload(pile, 'A', 'LGWEEUK59PE000001', 'ORD-123')
    expect(hex.length).toBe(112)
    const d = decodeCmdPayload('0x40', hex) as Record<string, unknown>
    expect(d.vin).toBe('LGWEEUK59PE000001')
    expect(d.gunNo).toBe(0)
    expect(String(d.orderNo ?? '').trim()).toBe('ORD-123')
  })

  it('uses 32 zero bytes for empty order (VIN flow default)', () => {
    const hex = buildVinAuth40Payload(pile, 'A', 'LGWEEUK59PE000001', '')
    expect(hex.slice(-64)).toBe('0'.repeat(64))
    const d = decodeCmdPayload('0x40', hex) as Record<string, unknown>
    expect(String(d.orderNo ?? '').trim()).toBe('')
    expect(parseCm40DataDomainOrderNo(hex)).toBe(null)
  })

  it('parseCm40DataDomainOrderNo reads 32-byte order field', () => {
    const hex = buildVinAuth40Payload(pile, 'A', 'LGWEEUK59PE000001', 'PO-TEST-01')
    expect(parseCm40DataDomainOrderNo(hex)).toBe('PO-TEST-01')
  })
})
