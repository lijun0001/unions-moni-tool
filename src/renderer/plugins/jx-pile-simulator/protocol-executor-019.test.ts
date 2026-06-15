import { describe, expect, it } from 'vitest'
import {
  buildCardAuth19Payload,
  decodeCmdPayload,
  parseCardAuth1aPayload,
} from './protocol-executor'
import type { JxTopologyPile } from './types'

function pileStub(): JxTopologyPile {
  return {
    pileId: 'P001',
    protocolId: 'jx-2.24',
    tcpHost: '127.0.0.1',
    tcpPort: 9000,
    status: 'idle',
    onlineState: 'online',
    heartbeatIntervalSec: 30,
    allowTimeoutCount: 3,
    guns: [{ gunId: 'A', status: 'linked' }],
  }
}

describe('buildCardAuth19Payload / parseCardAuth1aPayload', () => {
  it('builds 0x19: time(6)+card(16)+gun(1) = 23 bytes', () => {
    const hex = buildCardAuth19Payload(pileStub(), 'A', 'CARD-8888')
    expect(hex.length).toBe(46)
    const d = decodeCmdPayload('0x19', hex) as Record<string, unknown>
    expect(String(d.cardNo ?? '').trim()).toContain('CARD-8888')
    expect(d.gunNo).toBe(0)
  })

  it('parses 0x1a billing=1 with order no', () => {
    let hex = '1905190a0b0c'
    hex += [...'CARD001'.padEnd(16, '\0')].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    hex += 'e8030000'
    hex += '01'
    hex += '00'
    hex += '01'
    const orderAscii = 'ORD-CARD-TEST-001'.padEnd(32, '\0')
    hex += [...orderAscii].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    expect(hex.length).toBe(122)
    const parsed = parseCardAuth1aPayload(hex)
    expect(parsed).not.toBeNull()
    expect(parsed!.allowChargeFlag).toBe(1)
    expect(parsed!.orderNo).toBe('ORD-CARD-TEST-001')
    expect(parsed!.cardNo.trim()).toContain('CARD001')
  })
})
