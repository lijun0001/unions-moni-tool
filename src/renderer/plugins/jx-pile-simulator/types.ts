export type JxFlowStepType = 'send' | 'expect' | 'branch' | 'retry' | 'delay' | 'emitState'

export interface JxCommandDefinition {
  cmd: string
  name: string
  direction: 'up' | 'down'
  requiredParams: string[]
  optionalParams?: string[]
  resultFields?: string[]
  links?: {
    requestOf?: string | null
    responseOf?: string | null
    nextCmds?: string[]
  }
}

export interface JxFlowStep {
  id: string
  type: JxFlowStepType
  cmd?: string
  timeoutMs?: number
  by?: string
  cases?: Record<string, string>
  maxRetries?: number
  ms?: number
  statePatch?: Record<string, unknown>
}

export interface JxFlowTemplate {
  flowId: string
  name: string
  version: string
  scene?: string
  requiresCommands: string[]
  requiresParams?: string[]
  steps: JxFlowStep[]
}

export interface JxProtocolDefinition {
  schemaVersion: string
  protocolId: string
  protocolName: string
  version: string
  vendor?: string
  source: 'builtin' | 'imported'
  description?: string
  commandCatalog: Record<string, JxCommandDefinition>
  flowTemplates: JxFlowTemplate[]
  meta?: {
    author?: string
    createdAt?: string
    updatedAt?: string
  }
}

export interface JxFlowSupportResult {
  flowId: string
  support: 'supported' | 'partial' | 'unsupported'
  missingCommands: string[]
  missingParams: string[]
  invalidDirections: string[]
}

export interface JxImportSummary {
  commandsTotal: number
  flowsTotal: number
  supportedFlows: number
  partialFlows: number
  unsupportedFlows: number
}

export interface JxImportOk {
  ok: true
  protocolId: string
  version: string
  importMode: 'create' | 'overwrite' | 'fork' | 'dryRun'
  summary: JxImportSummary
  compatibilityReport: JxFlowSupportResult[]
  warnings: string[]
  protocol?: JxProtocolDefinition
  forkedProtocolId?: string
}

export interface JxImportErr {
  ok: false
  errorCode:
    | 'PROTO_IMPORT_JSON_INVALID'
    | 'PROTO_IMPORT_SCHEMA_UNSUPPORTED'
    | 'PROTO_IMPORT_PROTOCOL_ID_CONFLICT'
    | 'PROTO_IMPORT_CMD_KEY_MISMATCH'
    | 'PROTO_IMPORT_CMD_DIRECTION_INVALID'
    | 'PROTO_IMPORT_FLOW_DEP_MISSING'
    | 'PROTO_IMPORT_STEP_INVALID'
    | 'PROTO_IMPORT_UNKNOWN'
  message: string
  details?: Record<string, unknown>
}

export type JxImportResult = JxImportOk | JxImportErr

export interface JxTopologyPile {
  pileId: string
  /** 绑定协议（如 `jx-v2.24-core` / `jx-v2.25-core`）；决定 `0x23` 等线格式与电量分辨率；`0x21` 起始电量见 `cm21StartElect*`（与服务端共用） */
  protocolId: string
  /** 设备类型（用于筛选展示，默认直流） */
  deviceKind?: 'dc' | 'ac'
  tcpHost?: string
  tcpPort?: number
  onlineState?: 'offline' | 'online' | 'fault'
  status: 'idle' | 'charging' | 'offline' | 'fault'
  heartbeatIntervalSec: number
  allowTimeoutCount: number
  pilePowerKw?: number
  tariffModel?: {
    version: number
    parkingRate: number
    periods: Array<{
      index: number
      startHour: number
      startMinute: number
      type: number
      electricRate: number
      serviceRate: number
    }>
    updatedAt: number
  }
  guns: Array<{
    gunId: string
    status: 'idle' | 'linked' | 'occupied' | 'charging' | 'fault'
    vin?: string
    /** 用户最近一次确认的车辆 VIN（车辆录入或启动控制保存）；断链后仍保留，供再次录入时默认带出 */
    lastVin?: string
    soc?: number
    qrCode?: string
  }>
}

export interface JxRuntimeLog {
  id: string
  pileId: string
  t: number
  command: string
  direction: 'send' | 'receive'
  remoteIp: string
  rawHex: string
  structured: Record<string, unknown> | null
  parseError?: string
}

export type JxOrderStatus = 'created' | 'start-accepted' | 'starting' | 'charging' | 'failed' | 'stopped'

/** 订单分段电量表（充电过程中逐段累积，已结束段不丢） */
export type JxOrderPeriodEnergySegment = {
  modelIndex: number
  startMs: number
  endMs: number
  startTime: string
  endTime: string
  electricRate: number
  serviceRate: number
  energyKwh: number
  electricFeeYuan: number
  serviceFeeYuan: number
}

/** 订单绑定的计费模型副本（与桩当前 `tariffModel` 结构一致，另带来源标记） */
export type JxOrderTariffSnapshot = {
  version: number
  parkingRate: number
  periods: Array<{
    index: number
    startHour: number
    startMinute: number
    type: number
    electricRate: number
    serviceRate: number
  }>
  /** `pile-0x37` / `0x1f-embedded` / `0x41-vin-local` / `0x41-vin-embedded` 等来源说明见订单详情节律费率展示 */
  source: 'pile-0x37' | '0x1f-embedded' | '0x41-vin-local' | '0x41-vin-embedded' | '0x1a-local' | '0x1a-embedded'
  updatedAt: number
}

export interface JxPileOrder {
  orderNo: string
  pileId: string
  gunId: string
  /** 启动鉴权来源，决定上行 `0x21` 中用户类型与用户ID（见协议表1.8及手册工程约定） */
  startAuthSource?: '0x19-card' | '0x40-vin' | '0x59-scan-vin' | '0x1f-remote'
  startType: 'immediate' | 'scheduled'
  startParam: string
  startAt: number
  status: JxOrderStatus
  failReasonCode?: number
  failReasonText?: string
  /** 与本次充电绑定的费率副本；`0x25`/`0x23`/`0x33` 等优先使用此数据 */
  tariffSnapshot?: JxOrderTariffSnapshot
  request23?: {
    /** 会话 VIN，如 `0x40` 鉴权订单 */
    vin?: string
    userId?: string
    userType?: number
    orgCode?: string
    controlMode?: number
    controlParam?: number
    chargeMode?: number
    startMode?: number
    scheduleStartTime?: string
    /** 来自 `0x1F` 报文原始 6 字节（12 hex），用于 `0x23/0x33` 定时启动时间回显 */
    scheduleStartTimeWireHex?: string
    /** `0x1F` 原字段：1 本地计费模型；2 本报文附带模型 */
    billingModelSelect1f?: 1 | 2
    /** 兼容旧持久化；新逻辑以 `billingModelSelect1f` 为准 */
    billingModelSelect?: number
    /** `0x1F` 账户余额，报文分辨率 0.01 元（整型，与卡余额字段同量级） */
    accountBalanceFen?: number
    /** 启动时桩内计费模型版本（与 `0x37` 下发一致），用于订单推送 */
    tariffModelVersionAtStart?: number
    /**
     * 启动报文 billing=2 时附带的内嵌费率；`0x22` 充电成功后再写入 `tariffSnapshot`。
     * 桩展示/存储仍只用 `pile.tariffModel`（0x37）。
     */
    pendingEmbeddedTariff?: {
      version: number
      parkingRate: number
      periods: Array<{
        index: number
        startHour: number
        startMinute: number
        type: number
        electricRate: number
        serviceRate: number
      }>
      updatedAt: number
    }
    /** V2.24 `0x23`：充电卡余额（元），报文分辨率 0.01 元 */
    chargingCardBalanceYuan?: number
  }
  latest23?: {
    timeTag?: string
    gunNo?: number | null
    recordIndex?: number
    orderNo?: string
    userId?: string
    userType?: number
    orgCode?: string
    /** V2.24：充电卡余额，报文 0.01 元整数 */
    chargingCardBalance?: number
    vin?: string
    startTime?: string
    endTime?: string
    startEnergy?: number
    endEnergy?: number
    startSoc?: number
    endSoc?: number
    controlMode?: number
    controlParam?: number
    startMode?: number
    scheduleStartTime?: string
    chargeMode?: number
    stopReason?: number
    billingModelSelect?: number
    modelVersion?: number
    electricFee?: number
    serviceFee?: number
    parkFee?: number
    segmentCount?: number
    segments?: Array<{
      modelIndex: number
      energyKwh: number
    }>
    batterySn?: string
  }
  process25?: Array<{
    t: number
    voltage: number
    current: number
    energy: number
    amount: number
  }>
  process30?: Array<{
    t: number
    bclVoltageReq: number
    bclCurrentReq: number
    bcsVoltage: number
    bcsCurrent: number
    soc: number
  }>
  /** 分段电量表：跨费率时段逐段累积，已结束段保留；充电中仅末段更新结束时间与电量 */
  periodEnergySegments?: JxOrderPeriodEnergySegment[]
  latest25?: {
    chargeEnergyKwh: number
    chargeAmountYuan: number
    electricFeeYuan: number
    serviceFeeYuan: number
    accountBalanceYuan: number
    segments: Array<{
      modelIndex: number
      startTime: string
      endTime: string
      electricPrice: number
      servicePrice: number
      energyKwh: number
      electricFeeYuan: number
      serviceFeeYuan: number
    }>
  }
  /** 最近一次 0x30 采样（充电过程与 latest25 同步刷新） */
  latestBms?: {
    at: number
    soc: number
    energyKwh: number
    bclVoltageReq: number
    bclCurrentReq: number
    bcsVoltage: number
    bcsCurrent: number
  }
  stoppedAt?: number
  /** 为 true 时不主动上送 `0x23`/`0x33`（如 VIN 流程鉴权未通过，或模拟器配置的启动失败） */
  excludeFromOrderPush?: boolean
  delivery?: {
    pushed: boolean
    lastPushCmd?: '0x23' | '0x33'
    status: 'undelivered' | 'delivered'
    lastAckCmd?: '0x24' | '0x34'
    lastPushedAt?: number
    lastAckAt?: number
  }
}
