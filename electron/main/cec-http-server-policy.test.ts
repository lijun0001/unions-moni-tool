import { afterEach, describe, expect, it } from 'vitest'
import { queryEquipBusinessPolicyFromThirdParty } from './cec-http-server'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'
import { defaultCecSettings, type CecSnapshot } from '../../src/shared/cec-types'

const LINK_UUID = 'link-policy-1'

function makeSnapshot(secrets: { dataSecret: string; dataSecretIV: string }): CecSnapshot {
  return {
    settings: defaultCecSettings(),
    protocols: [CEC_DEFAULT_PROTOCOL],
    links: [
      {
        id: 'link-1',
        name: 'link-1',
        linkUuid: LINK_UUID,
        protocolId: CEC_DEFAULT_PROTOCOL.protocolId,
        local: {
          operatorId: 'LOCAL_OP',
          requestBaseUrl: 'http://localhost:9790',
          operatorSecret: 'local-operator-secret',
          sigSecret: 'local-sig-secret',
          dataSecret: '1234567890123456',
          dataSecretIV: 'abcdefghijklmnop',
        },
        thirdParty: {
          operatorId: 'THIRD_OP',
          operatorSecret: 'third-operator-secret',
          sigSecret: 'third-sig-secret',
          dataSecret: secrets.dataSecret,
          dataSecretIV: secrets.dataSecretIV,
          interconnectionUrl: 'https://tp.example.com',
        },
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

describe('queryEquipBusinessPolicyFromThirdParty', () => {
  const originalSnapshot = getCecSnapshot()

  afterEach(() => {
    setCecSnapshot(originalSnapshot)
  })

  it('returns friendly error when outbound AES secrets are invalid instead of throwing', async () => {
    const snap = makeSnapshot({ dataSecret: 'short', dataSecretIV: 'abcdefghijklmnop' })
    snap.links[0]!.local = {
      ...snap.links[0]!.local,
      dataSecret: 'short',
      dataSecretIV: 'abcdefghijklmnop',
    }
    setCecSnapshot(snap)
    const r = await queryEquipBusinessPolicyFromThirdParty(LINK_UUID, 'GUN-01')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/DataSecret\/DataSecretIV/)
    }
  })
})
