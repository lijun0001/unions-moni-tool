import type { CecSnapshot } from '../../src/shared/cec-types'
import { defaultCecSettings } from '../../src/shared/cec-types'
import { CEC_DEFAULT_PROTOCOL } from '../../src/shared/cec-default-protocol'

let snapshot: CecSnapshot = {
  settings: defaultCecSettings(),
  protocols: [CEC_DEFAULT_PROTOCOL],
  links: [],
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

export function getCecSnapshot(): CecSnapshot {
  return snapshot
}

export function setCecSnapshot(next: CecSnapshot): void {
  snapshot = next
}

export function patchCecSnapshot(patch: Partial<CecSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
}
