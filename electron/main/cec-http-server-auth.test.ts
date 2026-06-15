import { afterEach, describe, expect, it } from 'vitest'
import { dispatchCecRequest } from './cec-http-server'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'
import { defaultCecSettings, type CecSnapshot } from '../../src/shared/cec-types'
import { encryptDataJson, signEnvelope } from '../../src/shared/cec-crypto'

const LOCAL_SECRETS = {
  operatorId: 'LOCAL_OP',
  requestBaseUrl: 'http://localhost:9790',
  operatorSecret: 'local-operator-secret',
  sigSecret: 'local-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
}

const THIRD_SECRETS = {
  operatorId: 'THIRD_OP',
  operatorSecret: 'third-operator-secret',
  sigSecret: 'third-sig-secret',
  dataSecret: '1234567890123456',
  dataSecretIV: 'abcdefghijklmnop',
  interconnectionUrl: 'https://tp.example.com',
}

function makeBaseSnapshot(): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [
      {
        id: 'link-1',
        name: 'link-1',
        linkUuid: 'link-uuid-1',
        protocolId: CEC_DEFAULT_PROTOCOL.protocolId,
        local: LOCAL_SECRETS,
        thirdParty: THIRD_SECRETS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    stationsByLink: {},
    openStationIds: {},
    connectorMap: {},
    orders: [],
    logs: [],
    thirdPartyTokenByLink: {},
    inboundAuthTokenByLink: {},
    equipBusinessPolicyByKey: {},
    stationStatusByKey: {},
  }
}

function makeSignedRequestBody(dataObj: Record<string, unknown>): string {
  const timeStamp = '20260422120000'
  const seq = '0001'
  const dataRaw = encryptDataJson(
    JSON.stringify(dataObj),
    LOCAL_SECRETS.dataSecret,
    LOCAL_SECRETS.dataSecretIV,
  )
  const sig = signEnvelope(
    LOCAL_SECRETS.operatorId,
    dataRaw,
    timeStamp,
    seq,
    LOCAL_SECRETS.sigSecret,
  )
  return JSON.stringify({
    OperatorID: LOCAL_SECRETS.operatorId,
    TimeStamp: timeStamp,
    Seq: seq,
    Sig: sig,
    Data: dataRaw,
  })
}

describe('dispatchCecRequest token reject response', () => {
  const originalSnapshot = getCecSnapshot()

  afterEach(() => {
    setCecSnapshot(originalSnapshot)
  })

  it('returns signed response when inbound token validation fails', async () => {
    setCecSnapshot(makeBaseSnapshot())
    const rawBody = makeSignedRequestBody({ PageNo: 1, PageSize: 10 })

    const out = await dispatchCecRequest(
      'link-uuid-1',
      'query_stations_info',
      rawBody,
      undefined,
      '/api/link-uuid-1/query_stations_info',
    )

    expect(out.status).toBe(200)
    expect(out.body.Msg).toBe('token有误，请重新获取')
    expect(String(out.body.Sig ?? '')).toMatch(/^[0-9A-F]{32}$/)
  })
})
