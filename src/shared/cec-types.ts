/** 产品侧订单状态（设计文档 §9） */
export type CecOrderProductState =
  | 'starting'
  | 'suspended'
  | 'charging'
  | 'start_failed'
  | 'stopping'
  | 'pending_settlement'
  | 'completed'

/** 协议 StartChargeSeqSta */
export type StartChargeSeqSta = 1 | 2 | 3 | 4 | 5

export interface CecSecrets {
  operatorId: string
  requestBaseUrl: string
  operatorSecret: string
  sigSecret: string
  dataSecret: string
  dataSecretIV: string
}

/** 第三方侧：仅保留互联互通根地址（不再单独维护 requestBaseUrl，避免与 interconnectionUrl 重复） */
export type CecThirdPartySecrets = Omit<CecSecrets, 'requestBaseUrl'> & {
  /** 第三方互联互通根地址，如 https://tp.example.com */
  interconnectionUrl: string
}

/** 主进程缓存：按对接码（linkUuid）保存 query_token 结果；键与 linkUuid 一致 */
export interface CecThirdPartyTokenEntry {
  /** 对接唯一码，与 CecLinkConfig.linkUuid、本 Record 的键一致 */
  linkUuid: string
  accessToken: string
  /** 过期时间戳（毫秒） */
  expiresAtMs: number
}

/** 本地服务（被调用侧）签发给对端的 token（按 linkUuid 绑定） */
export interface CecInboundAuthTokenEntry {
  linkUuid: string
  accessToken: string
  issuedAtMs: number
  expiresAtMs: number
}

export interface CecLinkConfig {
  id: string
  name: string
  /** 16 位无分隔 UUID */
  linkUuid: string
  protocolId: string
  local: CecSecrets
  thirdParty: CecThirdPartySecrets
  createdAt: number
  updatedAt: number
}

/** 对外调用第三方时的根地址 */
export function thirdPartyOutboundBase(tp: CecThirdPartySecrets): string {
  return String(tp.interconnectionUrl ?? '')
    .trim()
    .replace(/\/$/, '')
}

/** 兼容旧数据：补齐 interconnectionUrl，去掉已废弃的 thirdParty.requestBaseUrl */
export function normalizeCecLink(link: CecLinkConfig): CecLinkConfig {
  const tp = link.thirdParty as CecThirdPartySecrets & { requestBaseUrl?: string }
  const interconnectionUrl =
    String(tp.interconnectionUrl ?? '').trim() ||
    String(tp.requestBaseUrl ?? '').trim() ||
    ''
  return {
    ...link,
    thirdParty: {
      operatorId: tp.operatorId,
      operatorSecret: tp.operatorSecret,
      sigSecret: tp.sigSecret,
      dataSecret: tp.dataSecret,
      dataSecretIV: tp.dataSecretIV,
      interconnectionUrl,
    },
  }
}

/**
 * 互联互通配置唯一性：本地平台编码 + 三方平台编码 + 互联互通根地址（规范化后）仅允许一条配置。
 */
export function interconnectionConfigFingerprint(link: CecLinkConfig): string {
  const loc = String(link.local?.operatorId ?? '').trim().toLowerCase()
  const tp = String(link.thirdParty?.operatorId ?? '').trim().toLowerCase()
  const url = thirdPartyOutboundBase(link.thirdParty).toLowerCase().replace(/\/$/, '')
  return `${loc}\u0001${tp}\u0001${url}`
}

/** 若存在与 candidate 指纹相同且 id 不同的配置则返回该配置 */
export function findConflictingInterconnectionLink(
  links: CecLinkConfig[],
  candidate: CecLinkConfig,
): CecLinkConfig | undefined {
  const fp = interconnectionConfigFingerprint(candidate)
  return links.find((l) => l.id !== candidate.id && interconnectionConfigFingerprint(l) === fp)
}

export interface CecProtocolMapping {
  protocolId: string
  protocolName: string
  version: string
  /** 导入时间（毫秒时间戳）；内置协议可为空 */
  importedAt?: number
  endpoints: Record<
    string,
    {
      path: string
      method: 'POST'
    }
  >
  envelope: {
    operatorIdField: string
    dataField: string
    encryptData: boolean
  }
}

export interface CecPluginSettings {
  httpPort: number
  bindHost: string
  logMaxEntries: number
  currentProtocolId: string | null
}

export interface CecStationRecord {
  StationID: string
  OperatorID: string
  EquipmentOwnerID: string
  StationName: string
  CountryCode: string
  AreaCode: string
  Address: string
  StationTel?: string
  ServiceTel: string
  StationType: number
  StationStatus: number
  ParkNums: number
  StationLng: number
  StationLat: number
  SiteGuide?: string
  Construction: number
  Pictures?: string[]
  MatchCars?: string
  ParkInfo?: string
  BusinetHours?: string
  ElectricityFee?: string
  ServiceFee?: string
  ParkFee?: string
  Payment?: string
  SupportOrder?: number
  Remark?: string
  EquipmentInfos: unknown[]
  /** 工具侧扩展：本站点数据所属互联互通对接码（与 stationsByLink 键一致） */
  DockLinkUuid?: string
}

export interface CecOrderRecord {
  id: string
  linkUuid: string
  startChargeSeq: string
  connectorId: string
  productState: CecOrderProductState
  protocolState: StartChargeSeqSta
  createdAt: number
  updatedAt: number
  /** 启动中截止时间 */
  suspendAt?: number
  /** 过程数据点 */
  samples: CecChargeSample[]
  /** 原始报文 */
  rawEvents: CecRawEvent[]
  /** 订单信息（notification_charge_order_info） */
  orderInfo?: {
    startChargeSeq: string
    connectorId: string
    totalPower: number
    totalElecMoney: number
    totalSeviceMoney: number
    totalMoney: number
    stopReason?: number
    sumPeriod?: number
    chargeDetails?: unknown[]
    startTime?: string
    endTime?: string
  }
}

export interface CecChargeSample {
  t: number
  totalPower: number
  totalMoney: number
  elecMoney?: number
  serviceMoney?: number
  voltageA?: number
  currentA?: number
  soc?: number
}

export interface CecRawEvent {
  t: number
  direction: 'inbound' | 'outbound'
  name: string
  payload: string
}

export interface CecLogEntry {
  id: string
  t: number
  direction: 'inbound' | 'outbound'
  name: string
  summary: string
  body: string
}

/** query_equip_business_policy 返回的时段费率（文档字段 SevicePrice 为历史拼写） */
export interface CecPolicyInfo {
  StartTime: string
  ElecPrice: number
  /** 文档为 SevicePrice，部分实现可能写作 ServicePrice */
  SevicePrice?: number
  ServicePrice?: number
}

/** query_station_status 单枪接口状态（文档 5.6 ConnectorStatusInfo） */
export interface CecConnectorStatusInfo {
  ConnectorID: string
  Status: number
  ParkStatus?: number
  LockStatus?: number
}

/** query_station_status 按站缓存（key：`${linkUuid}::${StationID}`） */
export interface CecStationStatusCache {
  linkUuid: string
  StationID: string
  ConnectorStatusInfos: CecConnectorStatusInfo[]
  fetchedAt: number
  errorMessage?: string
}

/** 按枪缓存的费率策略查询结果（key：`${linkUuid}::${ConnectorID}`） */
export interface CecEquipBusinessPolicyCache {
  linkUuid: string
  connectorId: string
  fetchedAt: number
  EquipBizSeq?: string
  SuccStat?: number
  FailReason?: number
  SumPeriod?: number
  PolicyInfos?: CecPolicyInfo[]
  /** 请求失败或业务失败说明 */
  errorMessage?: string
}

export interface CecSnapshot {
  settings: CecPluginSettings
  protocols: CecProtocolMapping[]
  links: CecLinkConfig[]
  /** linkUuid -> 同步的站点 */
  stationsByLink: Record<string, CecStationRecord[]>
  /** linkUuid -> 已开放 StationID */
  openStationIds: Record<string, string[]>
  /** ConnectorID -> 归属 */
  connectorMap: Record<string, { linkUuid: string; operatorId: string }>
  orders: CecOrderRecord[]
  logs: CecLogEntry[]
  /** 对接码 linkUuid -> 第三方 query_token 缓存（外联请求按设备/订单归属对接码取 token） */
  thirdPartyTokenByLink: Record<string, CecThirdPartyTokenEntry>
  /** 对接码 linkUuid -> 本地被调用时用于鉴权的 Bearer token */
  inboundAuthTokenByLink: Record<string, CecInboundAuthTokenEntry>
  /** query_equip_business_policy 缓存 */
  equipBusinessPolicyByKey: Record<string, CecEquipBusinessPolicyCache>
  /** query_station_status 缓存（key：`${linkUuid}::${StationID}`） */
  stationStatusByKey: Record<string, CecStationStatusCache>
}

export function defaultCecSettings(): CecPluginSettings {
  return {
    httpPort: 9790,
    bindHost: '0.0.0.0',
    logMaxEntries: 5000,
    currentProtocolId: null,
  }
}
