import { describe, expect, it } from 'vitest'
import { outboundPlatformSecrets, queryTokenOutboundSecrets } from './cec-http-server'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'
import type { CecLinkConfig } from '../../src/shared/cec-types'
import { encryptDataJson, signEnvelope, verifyEnvelopeSig } from '../../src/shared/cec-crypto'

const LOCAL = {
  operatorId: 'LOCAL_OP',
  requestBaseUrl: 'http://localhost:9790',
  operatorSecret: 'local-operator-secret',
  sigSecret: 'local-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
}

const THIRD = {
  operatorId: 'THIRD_OP',
  operatorSecret: 'third-operator-secret',
  sigSecret: 'third-sig-secret',
  dataSecret: 'fedcba9876543210',
  dataSecretIV: 'zyxwvutsrqponmlk',
  interconnectionUrl: 'https://tp.example.com',
}

function makeLink(): CecLinkConfig {
  return {
    id: 'link-1',
    name: 'link-1',
    linkUuid: 'link-uuid-1',
    protocolId: CEC_DEFAULT_PROTOCOL.protocolId,
    local: LOCAL,
    thirdParty: THIRD,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('outboundPlatformSecrets', () => {
  it('uses local OperatorID with thirdParty crypto secrets for general outbound', () => {
    const s = outboundPlatformSecrets(makeLink())
    expect(s.operatorId).toBe('LOCAL_OP')
    expect(s.operatorSecret).toBe('third-operator-secret')
    expect(s.sigSecret).toBe('third-sig-secret')
    expect(s.dataSecret).toBe('fedcba9876543210')
    expect(s.dataSecretIV).toBe('zyxwvutsrqponmlk')
  })

  it('produces signatures with thirdParty sig secret', () => {
    const s = outboundPlatformSecrets(makeLink())
    const timeStamp = '20260422120000'
    const seq = '0001'
    const dataObj = { PageNo: 1, PageSize: 10 }
    const dataStr = encryptDataJson(JSON.stringify(dataObj), s.dataSecret, s.dataSecretIV)
    const sig = signEnvelope(s.operatorId, dataStr, timeStamp, seq, s.sigSecret)
    expect(
      verifyEnvelopeSig(s.operatorId, dataStr, timeStamp, seq, sig, THIRD.sigSecret),
    ).toBe(true)
    expect(
      verifyEnvelopeSig(s.operatorId, dataStr, timeStamp, seq, sig, LOCAL.sigSecret),
    ).toBe(false)
  })

  it('falls back to local secrets when thirdParty crypto fields are empty', () => {
    const link = makeLink()
    link.thirdParty = {
      ...THIRD,
      operatorSecret: '',
      sigSecret: '',
      dataSecret: '',
      dataSecretIV: '',
    }
    const s = outboundPlatformSecrets(link)
    expect(s.operatorSecret).toBe('')
    expect(s.sigSecret).toBe('local-sig-secret')
    expect(s.dataSecret).toBe('1234567890123456')
  })
})

describe('queryTokenOutboundSecrets', () => {
  it('uses local OperatorID with thirdParty crypto secrets for query_token only', () => {
    const s = queryTokenOutboundSecrets(makeLink())
    expect(s.operatorId).toBe('LOCAL_OP')
    expect(s.operatorSecret).toBe('third-operator-secret')
    expect(s.sigSecret).toBe('third-sig-secret')
    expect(s.dataSecret).toBe('fedcba9876543210')
    expect(s.dataSecretIV).toBe('zyxwvutsrqponmlk')
  })
})
