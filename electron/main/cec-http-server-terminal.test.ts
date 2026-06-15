import { afterEach, describe, expect, it } from 'vitest'
import { dispatchCecRequest, resolveConnectorIdFromQrInLink } from './cec-http-server'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'
import { defaultCecSettings, type CecSnapshot } from '../../src/shared/cec-types'
import { decryptDataBase64, encryptDataJson, signEnvelope } from '../../src/shared/cec-crypto'

const LINK_UUID = 'link-uuid-1'

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

function makeSnapshotWithConnector(connectorId: string): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [
      {
        id: 'link-1',
        name: 'link-1',
        linkUuid: LINK_UUID,
        protocolId: CEC_DEFAULT_PROTOCOL.protocolId,
        local: LOCAL_SECRETS,
        thirdParty: THIRD_SECRETS,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    stationsByLink: {
      [LINK_UUID]: [
        {
          StationID: 'ST01',
          OperatorID: 'OP',
          EquipmentOwnerID: 'EO',
          StationName: '测试站',
          CountryCode: 'CN',
          AreaCode: '310000',
          Address: 'addr',
          ServiceTel: '400',
          StationType: 1,
          StationStatus: 50,
          ParkNums: 1,
          StationLng: 121,
          StationLat: 31,
          Construction: 1,
          EquipmentInfos: [
            {
              EquipmentID: 'EQ1',
              EquipmentType: 1,
              Power: 60,
              ConnectorInfos: [{ ConnectorID: connectorId, ConnectorType: 4, VoltageUpperLimits: 750, VoltageLowerLimits: 200, Current: 250, Power: 60, NationalStandard: 2 }],
            },
          ],
        },
      ],
    },
    openStationIds: {},
    connectorMap: {
      [connectorId]: { linkUuid: LINK_UUID, operatorId: THIRD_SECRETS.operatorId },
    },
    orders: [],
    logs: [],
    thirdPartyTokenByLink: {},
    inboundAuthTokenByLink: {
      [LINK_UUID]: {
        linkUuid: LINK_UUID,
        accessToken: 'test-inbound-token',
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 3_600_000,
      },
    },
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

describe('resolveConnectorIdFromQrInLink / query_terminal_code', () => {
  const originalSnapshot = getCecSnapshot()

  afterEach(() => {
    setCecSnapshot(originalSnapshot)
  })

  it('matches connector id from qr text directly or embedded', () => {
    setCecSnapshot(makeSnapshotWithConnector('GUN-001'))
    expect(resolveConnectorIdFromQrInLink(LINK_UUID, 'GUN-001')).toBe('GUN-001')
    expect(resolveConnectorIdFromQrInLink(LINK_UUID, 'https://x.com?c=GUN-001')).toBe('GUN-001')
    expect(resolveConnectorIdFromQrInLink(LINK_UUID, 'unknown')).toBeNull()
  })

  it('dispatch query_terminal_code returns ConnectorID on success', async () => {
    setCecSnapshot(makeSnapshotWithConnector('42'))
    const body = makeSignedRequestBody({ QRCode: 'prefix-42-suffix' })
    const out = await dispatchCecRequest(
      LINK_UUID,
      'query_terminal_code',
      body,
      'Bearer test-inbound-token',
      '/api/x/query_terminal_code',
    )
    expect(out.status).toBe(200)
    const dataRaw = (out.body as { Data?: string }).Data
    expect(typeof dataRaw).toBe('string')
    const plain = decryptDataBase64(String(dataRaw), LOCAL_SECRETS.dataSecret, LOCAL_SECRETS.dataSecretIV)
    const data = JSON.parse(plain) as Record<string, unknown>
    expect(data.SuccStat).toBe(0)
    expect(data.ConnectorID).toBe('42')
  })

  it('rejects inbound request signed with third-party secrets only', async () => {
    setCecSnapshot(makeSnapshotWithConnector('42'))
    const timeStamp = '20260422120000'
    const seq = '0001'
    const dataRaw = encryptDataJson(
      JSON.stringify({ QRCode: '42' }),
      THIRD_SECRETS.dataSecret,
      THIRD_SECRETS.dataSecretIV,
    )
    const sig = signEnvelope(
      THIRD_SECRETS.operatorId,
      dataRaw,
      timeStamp,
      seq,
      THIRD_SECRETS.sigSecret,
    )
    const body = JSON.stringify({
      OperatorID: THIRD_SECRETS.operatorId,
      TimeStamp: timeStamp,
      Seq: seq,
      Sig: sig,
      Data: dataRaw,
    })
    const out = await dispatchCecRequest(
      LINK_UUID,
      'query_terminal_code',
      body,
      'Bearer test-inbound-token',
      '/api/x/query_terminal_code',
    )
    expect(out.status).toBe(403)
  })
})
