import http from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import {
  thirdPartyOutboundBase,
  type CecInboundAuthTokenEntry,
  type CecConnectorStatusInfo,
  type CecEquipBusinessPolicyCache,
  type CecLinkConfig,
  type CecLogEntry,
  type CecOrderRecord,
  type CecPolicyInfo,
  type CecSnapshot,
  type CecStationRecord,
  type CecStationStatusCache,
} from '../../src/shared/cec-types'
import {
  decryptDataBase64,
  encryptDataJson,
  signEnvelope,
  validateCecAesSecretPair,
  verifyEnvelopeSig,
} from '../../src/shared/cec-crypto'
import { getCecSnapshot, patchCecSnapshot, setCecSnapshot } from './cec-state'

type CecNotify = (entry: Omit<CecLogEntry, 'id'> & { id?: string }) => void

let server: Server | null = null
let notifyRenderer: CecNotify | (() => void) = () => {}
const INBOUND_LOCAL_TOKEN_TTL_MS = 48 * 60 * 60 * 1000

export function setCecLogNotifier(fn: CecNotify): void {
  notifyRenderer = fn
}

function pushLog(partial: Omit<CecLogEntry, 'id'>): void {
  const snap = getCecSnapshot()
  const entry: CecLogEntry = {
    id: randomUUID(),
    ...partial,
  }
  const logs = [...snap.logs, entry].slice(-snap.settings.logMaxEntries)
  setCecSnapshot({ ...snap, logs })
  notifyRenderer(entry)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(
  res: http.ServerResponse,
  code: number,
  obj: Record<string, unknown>,
  headers?: Record<string, string>,
): void {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  res.end(body)
}

interface ParsedEnvelope {
  operatorId: string
  timeStamp: string
  seq: string
  sig: string
  dataRaw: string
  dataObj: Record<string, unknown>
}

type InboundCryptoSecrets = {
  dataSecret: string
  dataSecretIV: string
  sigSecret: string
}

function trimOp(s: string): string {
  return String(s ?? '').trim()
}

function extractQueryTokenRequestFields(
  dataObj: Record<string, unknown>,
  envelopeOperatorId: string,
): { reqOid: string; reqSec: string } {
  const reqOid = String(
    dataObj.OperatorID ?? dataObj.operatorID ?? dataObj.operatorId ?? envelopeOperatorId ?? '',
  ).trim()
  const reqSec = String(dataObj.OperatorSecret ?? dataObj.operatorSecret ?? '')
  return { reqOid, reqSec }
}

/**
 * 入站 query_token 凭证：仅校验三方 OperatorID + 本地 OperatorSecret。
 */
export function matchInboundQueryTokenCredentials(
  link: CecLinkConfig,
  reqOid: string,
  reqSec: string,
): boolean {
  const oid = trimOp(reqOid)
  if (!oid || !String(reqSec ?? '')) return false
  return oid === trimOp(link.thirdParty.operatorId) && reqSec === link.local.operatorSecret
}

/** 入站验签与解密固定使用互联互通本地配置（服务平台侧秘钥） */
function inboundLocalSecrets(link: CecLinkConfig): InboundCryptoSecrets {
  const loc = link.local
  return {
    dataSecret: loc.dataSecret,
    dataSecretIV: loc.dataSecretIV,
    sigSecret: loc.sigSecret,
  }
}

/** Data 参与签名的字符串：加密时为 Base64 原文；未加密 JSON 时为与对端一致的序列化串 */
function extractDataRawForSig(body: Record<string, unknown>): string {
  const rawData = body.Data
  if (typeof rawData === 'string') return rawData
  if (rawData && typeof rawData === 'object') return JSON.stringify(rawData)
  return ''
}

/**
 * 使用本地配置验签（HMAC-MD5）并解密 Data（AES-128-CBC）。
 */
function parseInboundEnvelope(
  body: Record<string, unknown>,
  link: CecLinkConfig,
  encrypt: boolean,
): { ok: true; parsed: ParsedEnvelope } | { ok: false; parsed: ParsedEnvelope } {
  const operatorId = String(body.OperatorID ?? '')
  const timeStamp = String(body.TimeStamp ?? '')
  const seq = String(body.Seq ?? '')
  const sig = String(body.Sig ?? '')
  const dataRaw = extractDataRawForSig(body)
  const rawData = body.Data

  const base: Omit<ParsedEnvelope, 'dataObj'> = {
    operatorId,
    timeStamp,
    seq,
    sig,
    dataRaw,
    dataObj: {},
  }

  const secrets = inboundLocalSecrets(link)
  if (!verifyEnvelopeSig(operatorId, dataRaw, timeStamp, seq, sig, secrets.sigSecret)) {
    return { ok: false, parsed: { ...base, dataObj: {} } }
  }
  let dataObj: Record<string, unknown> = {}
  try {
    if (encrypt && typeof rawData === 'string' && rawData.length > 0) {
      const plain = decryptDataBase64(rawData, secrets.dataSecret, secrets.dataSecretIV)
      dataObj = JSON.parse(plain) as Record<string, unknown>
    } else if (rawData && typeof rawData === 'object') {
      dataObj = rawData as Record<string, unknown>
    } else if (typeof rawData === 'string') {
      dataObj = JSON.parse(rawData) as Record<string, unknown>
    }
  } catch {
    return { ok: false, parsed: { ...base, dataObj: {} } }
  }
  return { ok: true, parsed: { ...base, dataObj } }
}

export function makeStartChargeSeq(operatorId: string): string {
  const suffix = randomBytes(8).toString('hex')
  const base = operatorId.replace(/\s/g, '')
  const combined = (base + suffix).slice(0, 27)
  return combined.padEnd(27, '0')
}

/** 20 位十进制数字串，作手机模拟等场景下的启动订单号（query_start_charge 请求体 StartChargeSeq） */
export function makeStartChargeSeqNumeric20(): string {
  let s = ''
  for (let i = 0; i < 20; i++) {
    s += String(randomInt(0, 10))
  }
  return s
}

function parseQueryStartChargeHttpResponse(
  text: string,
  decryptSecrets: { dataSecret: string; dataSecretIV: string },
):
  | { ok: true; startChargeSeq: string }
  | { ok: false; error: string } {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: '响应不是合法 JSON' }
  }
  const ret = Number(json.Ret ?? -1)
  if (ret !== 0) {
    return { ok: false, error: String(json.Msg ?? `Ret=${ret}`) }
  }
  const enc = json.Data
  let dataOut: Record<string, unknown>
  try {
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, decryptSecrets.dataSecret, decryptSecrets.dataSecretIV)
      dataOut = JSON.parse(plain) as Record<string, unknown>
    } else {
      dataOut = (json.Data as Record<string, unknown>) ?? {}
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `解密或解析 Data 失败: ${msg}` }
  }
  const rawSucc = dataOut.SuccStat ?? dataOut.succStat
  if (rawSucc !== undefined && rawSucc !== null && rawSucc !== '') {
    const succ = Number(rawSucc)
    if (succ !== 0) {
      return {
        ok: false,
        error: `服务平台返回失败：SuccStat=${succ}，FailReason=${String(dataOut.FailReason ?? '')}`,
      }
    }
  }
  return { ok: true, startChargeSeq: String(dataOut.StartChargeSeq ?? '') }
}

function parseQueryTerminalCodeHttpResponse(
  text: string,
  decryptSecrets: { dataSecret: string; dataSecretIV: string },
):
  | { ok: true; connectorId: string }
  | { ok: false; error: string } {
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: '响应不是合法 JSON' }
  }
  const ret = Number(json.Ret ?? -1)
  if (ret !== 0) {
    return { ok: false, error: String(json.Msg ?? `Ret=${ret}`) }
  }
  const enc = json.Data
  let dataOut: Record<string, unknown>
  try {
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, decryptSecrets.dataSecret, decryptSecrets.dataSecretIV)
      dataOut = JSON.parse(plain) as Record<string, unknown>
    } else {
      dataOut = (json.Data as Record<string, unknown>) ?? {}
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `解密或解析 Data 失败: ${msg}` }
  }
  const succ = Number(dataOut.SuccStat ?? dataOut.succStat ?? 1)
  if (succ !== 0) {
    return { ok: false, error: '二维码解析失败（SuccStat=1）' }
  }
  const connectorId = String(dataOut.ConnectorID ?? dataOut.connectorID ?? '').trim()
  if (!connectorId) {
    return { ok: false, error: '解析成功但未返回 ConnectorID' }
  }
  return { ok: true, connectorId }
}

/** 在本对接站点数据中，根据二维码原文匹配充电设备接口编码 */
export function resolveConnectorIdFromQrInLink(linkUuid: string, qrCode: string): string | null {
  const qr = String(qrCode ?? '').trim()
  if (!qr) return null
  const snap = getCecSnapshot()
  const mapped = snap.connectorMap[qr]
  if (mapped?.linkUuid === linkUuid) return qr

  const stations = snap.stationsByLink[linkUuid] ?? []
  for (const st of stations) {
    const eqs = (st as { EquipmentInfos?: { ConnectorInfos?: { ConnectorID: string }[] }[] }).EquipmentInfos
    if (!Array.isArray(eqs)) continue
    for (const eq of eqs) {
      const cis = eq?.ConnectorInfos
      if (!Array.isArray(cis)) continue
      for (const c of cis) {
        const cid = String(c?.ConnectorID ?? '').trim()
        if (!cid) continue
        if (qr === cid || qr.endsWith(cid) || qr.includes(cid)) return cid
      }
    }
  }
  return null
}

function buildResponseData(
  ret: number,
  msg: string,
  dataObj: Record<string, unknown>,
  secrets: CecLinkConfig['local'],
  encrypt: boolean,
): Record<string, unknown> {
  const ts = formatTs(new Date())
  const seq = '0001'
  const dataStr = encrypt
    ? encryptDataJson(JSON.stringify(dataObj), secrets.dataSecret, secrets.dataSecretIV)
    : JSON.stringify(dataObj)
  const sig = signEnvelope(secrets.operatorId, dataStr, ts, seq, secrets.sigSecret)
  return {
    Ret: ret,
    Msg: msg,
    Sig: sig,
    Data: encrypt ? dataStr : dataObj,
  }
}

function formatTs(d: Date): string {
  const p = (n: number) => n.toString().padStart(2, '0')
  return (
    d.getFullYear().toString() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

export function getCecLinkByUuid(linkUuid: string): CecLinkConfig | undefined {
  return getCecSnapshot().links.find((l) => l.linkUuid === linkUuid)
}

function extractBearerToken(authorizationHeader: string | undefined): string {
  const raw = String(authorizationHeader ?? '').trim()
  if (!raw) return ''
  const m = raw.match(/^Bearer\s+(.+)$/i)
  if (!m?.[1]) return ''
  return m[1].trim()
}

function issueInboundAuthTokenForLink(linkUuid: string): CecInboundAuthTokenEntry {
  const now = Date.now()
  const accessToken = `local-${linkUuid}-${randomBytes(16).toString('hex')}`
  const entry: CecInboundAuthTokenEntry = {
    linkUuid,
    accessToken,
    issuedAtMs: now,
    expiresAtMs: now + INBOUND_LOCAL_TOKEN_TTL_MS,
  }
  const snap = getCecSnapshot()
  setCecSnapshot({
    ...snap,
    inboundAuthTokenByLink: {
      ...(snap.inboundAuthTokenByLink ?? {}),
      [linkUuid]: entry,
    },
  })
  return entry
}

function validateInboundAuthToken(linkUuid: string, token: string): { ok: true } | { ok: false; reason: string } {
  if (!token) return { ok: false, reason: 'token missing' }
  const entry = getCecSnapshot().inboundAuthTokenByLink?.[linkUuid]
  if (!entry?.accessToken) return { ok: false, reason: 'token not issued' }
  if (entry.linkUuid !== linkUuid) return { ok: false, reason: 'token link mismatch' }
  if (entry.expiresAtMs <= Date.now()) return { ok: false, reason: 'token expired' }
  if (entry.accessToken !== token) return { ok: false, reason: 'token invalid' }
  return { ok: true }
}

function isInvalidInboundTokenReason(reason: string): boolean {
  return [
    'token missing',
    'token not issued',
    'token link mismatch',
    'token expired',
    'token invalid',
  ].includes(reason)
}

function inboundAuthRejectMsg(reason: string): string {
  if (isInvalidInboundTokenReason(reason)) return 'token有误，请重新获取'
  return reason
}

function buildInboundRejectLogBody(params: {
  linkUuid: string
  actionKey: string
  requestUrl: string
  reason: string
  hasBearerToken: boolean
  bearerToken: string
  parsed: ParsedEnvelope
  rawBody: string
  response: Record<string, unknown>
}): string {
  const structured = {
    kind: 'cec_inbound_reject' as const,
    linkUuid: params.linkUuid,
    action: params.actionKey,
    requestUrl: params.requestUrl,
    reason: params.reason,
    hasBearerToken: params.hasBearerToken,
    tokenPreview: params.bearerToken ? `${params.bearerToken.slice(0, 12)}...` : '',
    operatorId: params.parsed.operatorId,
    timeStamp: params.parsed.timeStamp,
    seq: params.parsed.seq,
    paramsPlain: params.parsed.dataObj,
    params: params.parsed.dataObj,
    response: params.response,
    requestEnvelopeCipher: params.rawBody,
  }
  return JSON.stringify(structured).slice(0, 16000)
}

/**
 * 入站日志体：同时保留「加密前/解密后」明文与线上密文，供前端按条切换展示。
 * - paramsPlain / responsePlain：业务明文
 * - requestEnvelopeCipher：收到的 HTTP 原文；responseCipher：返回信封（含 Data 密文）
 */
function buildInboundCallLogBody(
  linkUuid: string,
  actionKey: string,
  parsed: ParsedEnvelope,
  rawBody: string,
  authToken: string,
  requestUrl: string,
  responseEnvelope?: Record<string, unknown>,
  responsePlain?: Record<string, unknown> | null,
): string {
  const structured = {
    kind: 'cec_inbound_http' as const,
    linkUuid,
    action: actionKey,
    requestUrl,
    operatorId: parsed.operatorId,
    timeStamp: parsed.timeStamp,
    seq: parsed.seq,
    hasBearerToken: Boolean(authToken),
    paramsPlain: parsed.dataObj,
    requestEnvelopeCipher: rawBody,
    paramsDataCipher: typeof parsed.dataRaw === 'string' ? parsed.dataRaw : '',
    responsePlain: responsePlain ?? null,
    responseCipher: responseEnvelope ?? null,
  }
  return JSON.stringify(structured).slice(0, 16000)
}

/** 受支持的互联互通接口名（路径结构固定为 /api/{linkUuid}/{action}） */
const CEC_ROOT_POST_ACTIONS = new Set([
  'query_stations_info',
  'query_start_charge',
  'query_stop_charge',
  'query_equip_charge_status',
  'query_token',
  'query_station_status',
  'query_station_stats',
  'query_equip_auth',
  'query_equip_business_policy',
  'query_terminal_code',
  'notification_status',
  'notification_station_status',
  'notification_equip_charge_status',
  'notification_start_charge_result',
  'notification_charge_order_info',
  'notification_stop_charge_result',
])

function endpointExistsInProtocol(link: CecLinkConfig, action: string): boolean {
  const actionKey = normalizeCecAction(action)
  const snap = getCecSnapshot()
  const protocol = snap.protocols.find((p) => p.protocolId === link.protocolId)
  if (!protocol) return false
  const endpoints = Object.entries(protocol.endpoints ?? {})
  for (const [endpointName, endpoint] of endpoints) {
    const endpointKey = normalizeCecAction(endpointName)
    if (endpointKey !== actionKey) continue
    const mappedPath = normalizeCecAction(String(endpoint.path ?? '').trim().replace(/^\/+/, ''))
    if (mappedPath === actionKey) return true
  }
  return false
}

function findStationIdByConnectorId(linkUuid: string, connectorId: string): string | undefined {
  const snap = getCecSnapshot()
  const stations = snap.stationsByLink[linkUuid] ?? []
  for (const st of stations) {
    const stationId = String(st.StationID ?? '').trim()
    if (!stationId) continue
    const eqs = (st as { EquipmentInfos?: { ConnectorInfos?: { ConnectorID: string }[] }[] }).EquipmentInfos
    if (!Array.isArray(eqs)) continue
    for (const eq of eqs) {
      const infos = eq?.ConnectorInfos
      if (!Array.isArray(infos)) continue
      for (const info of infos) {
        if (String(info?.ConnectorID ?? '').trim() === connectorId) {
          return stationId
        }
      }
    }
  }
  return undefined
}

function upsertConnectorStatusForStation(
  linkUuid: string,
  stationId: string,
  statusInfo: CecConnectorStatusInfo,
): void {
  const snap = getCecSnapshot()
  const key = `${linkUuid}::${stationId}`
  const prev = snap.stationStatusByKey[key]
  const infos = prev ? [...prev.ConnectorStatusInfos] : []
  const idx = infos.findIndex(
    (x) => String(x.ConnectorID ?? '').trim() === String(statusInfo.ConnectorID ?? '').trim(),
  )
  if (idx >= 0) infos[idx] = statusInfo
  else infos.push(statusInfo)
  setCecSnapshot({
    ...snap,
    stationStatusByKey: {
      ...snap.stationStatusByKey,
      [key]: {
        linkUuid,
        StationID: stationId,
        ConnectorStatusInfos: infos,
        fetchedAt: Date.now(),
      },
    },
  })
}

function mapNotificationStationStatusToConnectorStatusInfo(
  dataObj: Record<string, unknown>,
): CecConnectorStatusInfo | null {
  const raw = dataObj.ConnectorStatusInfo
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const connectorId = String(o.ConnectorID ?? '').trim()
  if (!connectorId) return null
  return {
    ConnectorID: connectorId,
    Status: Number(o.Status ?? 0),
    ParkStatus: o.ParkStatus != null && o.ParkStatus !== '' ? Number(o.ParkStatus) : undefined,
    LockStatus: o.LockStatus != null && o.LockStatus !== '' ? Number(o.LockStatus) : undefined,
  }
}

function asPlainNotificationPayload(
  actionKey: string,
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (actionKey !== 'notification_station_status') return null
  const hasEnvelopeFields =
    body.OperatorID != null ||
    body.TimeStamp != null ||
    body.Seq != null ||
    body.Sig != null ||
    body.Data != null
  if (hasEnvelopeFields) return null
  const raw = body.ConnectorStatusInfo
  if (!raw || typeof raw !== 'object') return null
  return { ConnectorStatusInfo: raw }
}

function handleNotificationStationStatus(
  link: CecLinkConfig,
  parsed: ParsedEnvelope,
): Record<string, unknown> {
  const mapped = mapNotificationStationStatusToConnectorStatusInfo(parsed.dataObj)
  if (!mapped) {
    return { Status: 1 }
  }
  const stationId = findStationIdByConnectorId(link.linkUuid, mapped.ConnectorID)
  if (!stationId) {
    return { Status: 1 }
  }
  upsertConnectorStatusForStation(link.linkUuid, stationId, mapped)
  return { Status: 0 }
}

function handleQueryStationsInfo(
  link: CecLinkConfig,
  parsed: ParsedEnvelope,
): Record<string, unknown> {
  const pageNo = Number(parsed.dataObj.PageNo ?? 1)
  const pageSize = Number(parsed.dataObj.PageSize ?? 10)
  const snap = getCecSnapshot()
  const all = snap.stationsByLink[link.linkUuid] ?? []
  const itemSize = all.length
  const pageCount = Math.max(1, Math.ceil(itemSize / pageSize))
  const start = (pageNo - 1) * pageSize
  const slice = all.slice(start, start + pageSize)
  return {
    ItemSize: itemSize,
    PageNo: pageNo,
    PageCount: pageCount,
    StationInfos: slice,
  }
}

function handleQueryTerminalCode(link: CecLinkConfig, parsed: ParsedEnvelope): Record<string, unknown> {
  const qrCode = String(parsed.dataObj.QRCode ?? parsed.dataObj.qrCode ?? '').trim()
  const connectorId = resolveConnectorIdFromQrInLink(link.linkUuid, qrCode)
  if (!connectorId) {
    return { ConnectorID: '', SuccStat: 1 }
  }
  return { ConnectorID: connectorId, SuccStat: 0 }
}

function handleQueryStartCharge(link: CecLinkConfig, parsed: ParsedEnvelope): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '')
  const connectorId = String(parsed.dataObj.ConnectorID ?? '')
  const snap = getCecSnapshot()
  const mapped = snap.connectorMap[connectorId]

  const fail = (failReason: number) => ({
    StartChargeSeq: startChargeSeq,
    StartChargeSeqSta: 5,
    ConnectorID: connectorId,
    SuccStat: 1,
    FailReason: failReason,
  })

  if (!connectorId.trim() || !startChargeSeq.trim()) {
    return fail(3)
  }
  if (!mapped || mapped.linkUuid !== link.linkUuid) {
    return fail(3)
  }

  const order: CecOrderRecord = {
    id: randomUUID(),
    linkUuid: link.linkUuid,
    startChargeSeq,
    connectorId,
    productState: 'starting',
    protocolState: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    suspendAt: Date.now() + 120_000,
    samples: [],
    rawEvents: [],
  }
  const orders = [...snap.orders, order]
  setCecSnapshot({ ...snap, orders })
  return {
    StartChargeSeq: startChargeSeq,
    StartChargeSeqSta: 1,
    ConnectorID: connectorId,
    SuccStat: 0,
    FailReason: 0,
  }
}

function handleQueryStopCharge(_link: CecLinkConfig, parsed: ParsedEnvelope): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '')
  const connectorId = String(parsed.dataObj.ConnectorID ?? '')
  const snap = getCecSnapshot()
  const orders = snap.orders.map((o) => {
    if (o.startChargeSeq !== startChargeSeq) return o
    return {
      ...o,
      productState: 'stopping' as const,
      protocolState: 3 as const,
      updatedAt: Date.now(),
    }
  })
  setCecSnapshot({ ...snap, orders })
  return {
    StartChargeSeq: startChargeSeq,
    StartChargeSeqSta: 3,
    SuccStat: 0,
    FailReason: 0,
    ConnectorID: connectorId,
  }
}

function formatProtocolDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function readChargeStatusSoc(dataOut: Record<string, unknown>): number {
  return Number(dataOut.SOC ?? dataOut.Soc ?? dataOut.soc ?? 0)
}

function readChargeStatusServiceMoney(dataOut: Record<string, unknown>): number {
  return Number(dataOut.SeviceMoney ?? dataOut.ServiceMoney ?? dataOut.TotalSeviceMoney ?? 0)
}

/** query_equip_charge_status 响应是否含可用充电状态（SuccStat 省略时以 StartChargeSeqStat 1~4 判定成功） */
export function isQueryChargeStatusResponseUsable(dataOut: Record<string, unknown>): boolean {
  const succRaw = dataOut.SuccStat ?? dataOut.succStat
  if (succRaw !== undefined && succRaw !== null && succRaw !== '') {
    const n = Number(succRaw)
    return !Number.isNaN(n) && n === 0
  }
  return parseSyncStartChargeSeqStat(dataOut) !== null
}

function buildEquipChargeStatusPayloadFromOrder(order: CecOrderRecord): Record<string, unknown> {
  const last = order.samples.at(-1)
  const info = order.orderInfo
  const endTime =
    info?.endTime ||
    (last?.t ? formatProtocolDateTime(last.t) : formatProtocolDateTime(order.updatedAt))
  const connectorStatus =
    order.protocolState === 2 || order.protocolState === 3
      ? 3
      : order.protocolState === 1
        ? 2
        : 1
  return {
    StartChargeSeq: order.startChargeSeq,
    StartChargeSeqStat: order.protocolState,
    ConnectorID: order.connectorId,
    ConnectorStatus: connectorStatus,
    CurrentA: last?.currentA ?? 0,
    VoltageA: last?.voltageA ?? 0,
    Soc: last?.soc ?? 0,
    StartTime: info?.startTime ?? (order.createdAt ? formatProtocolDateTime(order.createdAt) : ''),
    EndTime: endTime,
    TotalPower: info?.totalPower ?? last?.totalPower ?? 0,
    ElecMoney: info?.totalElecMoney ?? last?.elecMoney ?? 0,
    SeviceMoney: info?.totalSeviceMoney ?? last?.serviceMoney ?? 0,
    TotalMoney: info?.totalMoney ?? last?.totalMoney ?? 0,
    SumPeriod: info?.sumPeriod ?? (info?.chargeDetails?.length ? info.chargeDetails.length : 0),
    ChargeDetails: info?.chargeDetails ?? [],
    SuccStat: 0,
  }
}

function handleQueryEquipChargeStatus(_link: CecLinkConfig, parsed: ParsedEnvelope): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '').trim()
  const snap = getCecSnapshot()
  const order = snap.orders.find((o) => o.startChargeSeq === startChargeSeq)
  if (!order) {
    return { StartChargeSeq: startChargeSeq, SuccStat: 1, FailReason: 1 }
  }
  return buildEquipChargeStatusPayloadFromOrder(order)
}

function productStateFromStartChargeSeqSta(sta: number): CecOrderRecord['productState'] {
  switch (sta) {
    case 1:
      return 'starting'
    case 2:
      return 'charging'
    case 3:
      return 'stopping'
    case 4:
      return 'completed'
    default:
      return 'start_failed'
  }
}

function normalizeOrderStateFromProtocol(
  staRaw: number,
): { protocolState: 1 | 2 | 3 | 4 | 5; productState: CecOrderRecord['productState'] } {
  const protocolState = (staRaw >= 1 && staRaw <= 5 ? staRaw : 5) as 1 | 2 | 3 | 4 | 5
  return {
    protocolState,
    productState: productStateFromStartChargeSeqSta(protocolState),
  }
}

function isEndedOrderState(o: CecOrderRecord): boolean {
  return o.protocolState === 4 || o.productState === 'completed'
}

function canAdvanceOrderStateByNotification(
  current: CecOrderRecord,
  nextProtocolState: 1 | 2 | 3 | 4 | 5,
): boolean {
  if (isEndedOrderState(current)) return false
  if (nextProtocolState === 5) {
    return current.productState === 'starting' || current.productState === 'suspended'
  }
  return nextProtocolState > current.protocolState
}

function handleNotificationStartChargeResult(
  link: CecLinkConfig,
  parsed: ParsedEnvelope,
): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '').trim()
  const connectorId = String(parsed.dataObj.ConnectorID ?? '').trim()
  const startChargeSeqSta = Number(parsed.dataObj.StartChargeSeqStat ?? parsed.dataObj.StartChargeSeqSta ?? 5)
  const startTime = String(parsed.dataObj.StartTime ?? '').trim()
  const identCode = String(parsed.dataObj.IdentCode ?? '').trim()
  const mapped = normalizeOrderStateFromProtocol(startChargeSeqSta)

  const snap = getCecSnapshot()
  const now = Date.now()
  const orders = snap.orders.map((o) => {
    const matchBySeq = startChargeSeq && o.startChargeSeq === startChargeSeq
    const matchByConnector = !startChargeSeq && connectorId && o.connectorId === connectorId
    if (!matchBySeq && !matchByConnector) return o
    const canUpdateState = canAdvanceOrderStateByNotification(o, mapped.protocolState)
    return {
      ...o,
      protocolState: canUpdateState ? mapped.protocolState : o.protocolState,
      productState: canUpdateState ? mapped.productState : o.productState,
      suspendAt: canUpdateState ? undefined : o.suspendAt,
      updatedAt: now,
      rawEvents: [
        ...o.rawEvents,
        {
          t: now,
          direction: 'inbound',
          name: 'notification_start_charge_result',
          payload: JSON.stringify(parsed.dataObj),
        },
      ].slice(-500),
      orderInfo: {
        ...(o.orderInfo ?? {
          startChargeSeq: o.startChargeSeq,
          connectorId: o.connectorId,
          totalPower: 0,
          totalElecMoney: 0,
          totalSeviceMoney: 0,
          totalMoney: 0,
        }),
        startTime: startTime || o.orderInfo?.startTime,
      },
    }
  })
  setCecSnapshot({ ...snap, orders })
  return {
    StartChargeSeq: startChargeSeq,
    SuccStat: 0,
    FailReason: 0,
  }
}

function handleNotificationChargeOrderInfo(
  _link: CecLinkConfig,
  parsed: ParsedEnvelope,
): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '').trim()
  const connectorId = String(parsed.dataObj.ConnectorID ?? '').trim()
  const now = Date.now()
  const totalPower = Number(parsed.dataObj.TotalPower ?? 0)
  const totalElecMoney = Number(parsed.dataObj.TotalElecMoney ?? parsed.dataObj.ElecMoney ?? 0)
  const totalSeviceMoney = Number(parsed.dataObj.TotalSeviceMoney ?? parsed.dataObj.SeviceMoney ?? 0)
  const totalMoney = Number(parsed.dataObj.TotalMoney ?? 0)
  const stopReasonRaw = parsed.dataObj.StopReason
  const sumPeriodRaw = parsed.dataObj.SumPeriod
  const chargeDetailsRaw = parsed.dataObj.ChargeDetails
  let matched = false

  const snap = getCecSnapshot()
  const orders = snap.orders.map((o) => {
    const hitBySeq = Boolean(startChargeSeq) && o.startChargeSeq === startChargeSeq
    const hitByConnector = !startChargeSeq && Boolean(connectorId) && o.connectorId === connectorId
    if (!hitBySeq && !hitByConnector) return o
    matched = true
    return {
      ...o,
      protocolState: 4,
      productState: 'completed',
      suspendAt: undefined,
      updatedAt: now,
      samples: [
        ...o.samples,
        {
          t: now,
          totalPower,
          totalMoney,
          elecMoney: totalElecMoney,
          serviceMoney: totalSeviceMoney,
        },
      ].slice(-2000),
      rawEvents: [
        ...o.rawEvents,
        {
          t: now,
          direction: 'inbound',
          name: 'notification_charge_order_info',
          payload: JSON.stringify(parsed.dataObj),
        },
      ].slice(-500),
      orderInfo: {
        startChargeSeq: startChargeSeq || o.startChargeSeq,
        connectorId: connectorId || o.connectorId,
        totalPower,
        totalElecMoney,
        totalSeviceMoney,
        totalMoney,
        stopReason:
          stopReasonRaw != null && stopReasonRaw !== '' ? Number(stopReasonRaw) : o.orderInfo?.stopReason,
        sumPeriod:
          sumPeriodRaw != null && sumPeriodRaw !== '' ? Number(sumPeriodRaw) : o.orderInfo?.sumPeriod,
        chargeDetails: Array.isArray(chargeDetailsRaw)
          ? (chargeDetailsRaw as unknown[])
          : (o.orderInfo?.chargeDetails ?? []),
        startTime: String(parsed.dataObj.StartTime ?? o.orderInfo?.startTime ?? '').trim() || o.orderInfo?.startTime,
        endTime: String(parsed.dataObj.EndTime ?? o.orderInfo?.endTime ?? '').trim() || o.orderInfo?.endTime,
      },
    }
  })
  if (matched) setCecSnapshot({ ...snap, orders })
  return {
    StartChargeSeq: startChargeSeq,
    ConnectorID: connectorId,
    ConfirmResult: matched ? 0 : 1,
  }
}

function handleNotificationStopChargeResult(
  _link: CecLinkConfig,
  parsed: ParsedEnvelope,
): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '').trim()
  const connectorId = String(parsed.dataObj.ConnectorID ?? '').trim()
  const sta = Number(parsed.dataObj.StartChargeSeqStat ?? parsed.dataObj.StartChargeSeqSta ?? 4)
  const succStat = Number(parsed.dataObj.SuccStat ?? 1)
  const failReason = Number(parsed.dataObj.FailReason ?? 0)
  const now = Date.now()
  const mapped = normalizeOrderStateFromProtocol(sta)
  const failState = normalizeOrderStateFromProtocol(2)
  let matched = false

  const snap = getCecSnapshot()
  const orders = snap.orders.map((o) => {
    const hitBySeq = Boolean(startChargeSeq) && o.startChargeSeq === startChargeSeq
    const hitByConnector = !startChargeSeq && Boolean(connectorId) && o.connectorId === connectorId
    if (!hitBySeq && !hitByConnector) return o
    matched = true
    const ok = succStat === 0
    return {
      ...o,
      protocolState: ok ? mapped.protocolState : failState.protocolState,
      productState: ok ? 'completed' : 'charging',
      suspendAt: undefined,
      updatedAt: now,
      rawEvents: [
        ...o.rawEvents,
        {
          t: now,
          direction: 'inbound',
          name: 'notification_stop_charge_result',
          payload: JSON.stringify(parsed.dataObj),
        },
      ].slice(-500),
    }
  })
  if (matched) setCecSnapshot({ ...snap, orders })
  return {
    StartChargeSeq: startChargeSeq,
    SuccStat: matched ? 0 : 1,
    FailReason: matched ? 0 : 1,
  }
}

function handleNotificationEquipChargeStatus(
  _link: CecLinkConfig,
  parsed: ParsedEnvelope,
): Record<string, unknown> {
  const startChargeSeq = String(parsed.dataObj.StartChargeSeq ?? '').trim()
  const connectorId = String(parsed.dataObj.ConnectorID ?? '').trim()
  const sta = Number(parsed.dataObj.StartChargeSeqStat ?? parsed.dataObj.StartChargeSeqSta ?? 5)
  const mapped = normalizeOrderStateFromProtocol(sta)
  const now = Date.now()
  const sample = {
    t: now,
    totalPower: Number(parsed.dataObj.TotalPower ?? 0),
    totalMoney: Number(parsed.dataObj.TotalMoney ?? 0),
    elecMoney: Number(parsed.dataObj.ElecMoney ?? 0),
    serviceMoney: Number(parsed.dataObj.SeviceMoney ?? parsed.dataObj.ServiceMoney ?? 0),
    voltageA: Number(parsed.dataObj.VoltageA ?? 0),
    currentA: Number(parsed.dataObj.CurrentA ?? 0),
    soc: Number(parsed.dataObj.SOC ?? parsed.dataObj.Soc ?? 0),
  }

  const snap = getCecSnapshot()
  let matched = false
  const orders = snap.orders.map((o) => {
    const hitBySeq = Boolean(startChargeSeq) && o.startChargeSeq === startChargeSeq
    const hitByConnector = !startChargeSeq && Boolean(connectorId) && o.connectorId === connectorId
    if (!hitBySeq && !hitByConnector) return o
    matched = true
    return {
      ...o,
      protocolState: mapped.protocolState,
      productState: mapped.productState,
      updatedAt: now,
      samples: [...o.samples, sample].slice(-2000),
      rawEvents: [
        ...o.rawEvents,
        {
          t: now,
          direction: 'inbound',
          name: 'notification_equip_charge_status',
          payload: JSON.stringify(parsed.dataObj),
        },
      ].slice(-500),
    }
  })
  if (matched) setCecSnapshot({ ...snap, orders })
  return {
    StartChargeSeq: startChargeSeq,
    SuccStat: matched ? 0 : 1,
  }
}

function notImplemented(): Record<string, unknown> {
  return { SuccStat: 0 }
}

/** 将路径最后一段接口名统一为内部使用的 snake_case（如 notificationStatus → notification_status） */
export function normalizeCecAction(action: string): string {
  const s = action.trim().replace(/-/g, '_')
  if (!s) return s
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/_+/g, '_')
    .toLowerCase()
}

export async function dispatchCecRequest(
  linkUuid: string,
  action: string,
  rawBody: string,
  authorizationHeader?: string,
  requestUrl = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const link = getCecLinkByUuid(linkUuid)
  if (!link) {
    return { status: 404, body: { Ret: 4004, Msg: 'unknown link', Sig: '', Data: {} } }
  }
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return { status: 400, body: { Ret: 4000, Msg: 'invalid json', Sig: '', Data: {} } }
  }
  const encrypt = true
  const actionKey = normalizeCecAction(action)
  const plainPayload = asPlainNotificationPayload(actionKey, body)
  const inbound = plainPayload ? { ok: false as const, parsed: null } : parseInboundEnvelope(body, link, encrypt)
  const bearerToken = extractBearerToken(authorizationHeader)

  // 兼容对端仅推送业务体（无信封、无签名）的 notification_stationStatus。
  if (plainPayload) {
    const parsedPlain: ParsedEnvelope = {
      operatorId: '',
      timeStamp: '',
      seq: '',
      sig: '',
      dataRaw: JSON.stringify(plainPayload),
      dataObj: plainPayload,
    }
    const dataOut = handleNotificationStationStatus(link, parsedPlain)
    const plainResp = { Status: Number(dataOut.Status ?? 1) }
    pushLog({
      t: Date.now(),
      direction: 'inbound',
      name: actionKey,
      summary: 'handled',
      body: buildInboundCallLogBody(
        linkUuid,
        actionKey,
        parsedPlain,
        rawBody,
        bearerToken,
        requestUrl,
        plainResp,
        dataOut,
      ),
    })
    // 纯业务体兼容模式下返回对端可直接识别的简洁应答
    return { status: 200, body: plainResp }
  }

  if (!inbound.ok) {
    pushLog({
      t: Date.now(),
      direction: 'inbound',
      name: actionKey,
      summary: 'sig_fail',
      body: rawBody.slice(0, 4000),
    })
    return { status: 403, body: { Ret: 4001, Msg: '签名错误', Sig: '', Data: {} } }
  }
  const parsed = inbound.parsed
  if (actionKey !== 'query_token') {
    const auth = validateInboundAuthToken(linkUuid, bearerToken)
    if (!auth.ok) {
      const rejectMsg = inboundAuthRejectMsg(auth.reason)
      const rejectResponse = buildResponseData(4002, rejectMsg, {}, link.local, encrypt)
      pushLog({
        t: Date.now(),
        direction: 'inbound',
        name: actionKey,
        summary: `reject: ${auth.reason}`,
        body: buildInboundRejectLogBody({
          linkUuid,
          actionKey,
          requestUrl,
          reason: auth.reason,
          hasBearerToken: Boolean(bearerToken),
          bearerToken,
          parsed,
          rawBody,
          response: rejectResponse,
        }),
      })
      return { status: 200, body: rejectResponse }
    }
  }
  let dataOut: Record<string, unknown>
  let inboundResponseRet = 0
  switch (actionKey) {
    case 'query_stations_info':
      dataOut = handleQueryStationsInfo(link, parsed)
      break
    case 'query_terminal_code':
      dataOut = handleQueryTerminalCode(link, parsed)
      break
    case 'query_start_charge':
      dataOut = handleQueryStartCharge(link, parsed)
      break
    case 'query_stop_charge':
      dataOut = handleQueryStopCharge(link, parsed)
      break
    case 'query_equip_charge_status':
      dataOut = handleQueryEquipChargeStatus(link, parsed)
      break
    case 'query_station_status':
    case 'query_station_stats':
    case 'query_equip_auth':
    case 'query_equip_business_policy':
      dataOut = notImplemented()
      break
    case 'query_token': {
      const { reqOid, reqSec } = extractQueryTokenRequestFields(parsed.dataObj, parsed.operatorId)
      const authOk = matchInboundQueryTokenCredentials(link, reqOid, reqSec)
      if (!authOk) {
        const oidKnown = trimOp(reqOid) === trimOp(link.thirdParty.operatorId)
        dataOut = {
          OperatorID: reqOid || parsed.operatorId,
          SuccStat: 1,
          AccessToken: '',
          TokenAvailableTime: 0,
          FailReason: oidKnown ? 2 : 1,
        }
        inboundResponseRet = 4003
      } else {
        const tokenEntry = issueInboundAuthTokenForLink(link.linkUuid)
        dataOut = {
          OperatorID: link.thirdParty.operatorId,
          SuccStat: 0,
          AccessToken: tokenEntry.accessToken,
          TokenAvailableTime: Math.floor((tokenEntry.expiresAtMs - tokenEntry.issuedAtMs) / 1000),
          FailReason: 0,
        }
      }
      break
    }
    /** 常见驼峰命名占位，与 query_station_status 同类处理 */
    case 'notification_status':
      dataOut = notImplemented()
      break
    case 'notification_station_status':
      dataOut = handleNotificationStationStatus(link, parsed)
      break
    case 'notification_equip_charge_status':
      dataOut = handleNotificationEquipChargeStatus(link, parsed)
      break
    case 'notification_charge_order_info':
      dataOut = handleNotificationChargeOrderInfo(link, parsed)
      break
    case 'notification_stop_charge_result':
      dataOut = handleNotificationStopChargeResult(link, parsed)
      break
    case 'notification_start_charge_result':
      dataOut = handleNotificationStartChargeResult(link, parsed)
      break
    default:
      return { status: 404, body: { Ret: 404, Msg: 'action', Sig: '', Data: {} } }
  }
  /** 服务平台应答：Data 加解密与 Sig 使用本地（玖行侧）秘钥，与附件 §4.2 查询类一致 */
  const resp = buildResponseData(inboundResponseRet, '', dataOut, link.local, encrypt)
  pushLog({
    t: Date.now(),
    direction: 'inbound',
    name: actionKey,
    summary: 'handled',
    body: buildInboundCallLogBody(linkUuid, actionKey, parsed, rawBody, bearerToken, requestUrl, resp, dataOut),
  })
  return { status: 200, body: resp as Record<string, unknown> }
}

export function startCecHttp(
  port: number,
  host: string,
): Promise<{ ok: true; port: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    if (server) {
      resolve({ ok: false, error: 'already running' })
      return
    }
    server = http.createServer((req, res) => {
      void (async () => {
        if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
          json(res, 200, { ok: true, service: 'cec-inner-link' })
          return
        }
        if (req.method !== 'POST' || !req.url) {
          json(res, 405, { error: 'method' })
          return
        }
        const pathOnly = req.url.split('?')[0] ?? ''
        const m = pathOnly.replace(/^\//, '').split('/').filter(Boolean)
        // 严格路由：域名+端口+api+对接码+接口名（如 /api/{linkUuid}/{action}），结构不符直接 404
        if (m.length !== 3 || m[0] !== 'api') {
          json(res, 404, { error: 'not found' })
          return
        }
        const linkId = m[1]!
        const action = m[2]!
        const actionKey = normalizeCecAction(action)
        if (!CEC_ROOT_POST_ACTIONS.has(actionKey)) {
          json(res, 404, { error: 'not found' })
          return
        }
        const link = getCecLinkByUuid(linkId)
        if (!link || !endpointExistsInProtocol(link, action)) {
          json(res, 404, { error: 'not found' })
          return
        }
        const raw = await readBody(req)
        const out = await dispatchCecRequest(
          linkId,
          action,
          raw,
          typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
          pathOnly,
        )
        json(res, out.status, out.body)
      })().catch((e) => {
        json(res, 500, { error: String(e) })
      })
    })
    server.on('error', (err) => {
      console.error('[cec-http]', err)
    })
    server.listen(port, host, () => {
      resolve({ ok: true, port })
    })
  })
}

export function stopCecHttp(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      server = null
      resolve()
    })
  })
}

export function cecHttpRunning(): boolean {
  return server !== null
}

const DEFAULT_STATION_PULL_PAGE_SIZE = 200
const STATION_PULL_PAGE_SIZE_MAX = 2000

export type CecPullStationsProgress = {
  pageNo: number
  totalPages: number
  pagesFetched: number
}
/** 提前刷新 token，避免边界时刻过期 */
const THIRD_PARTY_TOKEN_SKEW_MS = 60_000

/**
 * 主动调用对端互联互通接口（除 query_token 以外）：
 * - OperatorID 使用本地平台编码（本地为空时回退 thirdParty）
 * - 签名与 Data 加解密优先使用三方配置秘钥（为空时回退 local，兼容旧配置）
 */
export function outboundPlatformSecrets(link: CecLinkConfig): {
  operatorId: string
  operatorSecret: string
  sigSecret: string
  dataSecret: string
  dataSecretIV: string
} {
  const loc = link.local
  const tp = link.thirdParty
  const operatorId = String(loc.operatorId ?? '').trim() ? loc.operatorId : tp.operatorId
  return {
    operatorId,
    operatorSecret: tp.operatorSecret,
    sigSecret: String(tp.sigSecret ?? '').trim() ? tp.sigSecret : loc.sigSecret,
    dataSecret: String(tp.dataSecret ?? '').trim() ? tp.dataSecret : loc.dataSecret,
    dataSecretIV: String(tp.dataSecretIV ?? '').trim() ? tp.dataSecretIV : loc.dataSecretIV,
  }
}

function validateOutboundCryptoSecrets(link: CecLinkConfig): string | null {
  const s = outboundPlatformSecrets(link)
  if (!String(s.operatorId ?? '').trim()) {
    return '平台编码（OperatorID）为空，请完善本地或三方配置'
  }
  if (!String(s.sigSecret ?? '').trim()) return 'SigSecret 为空，请完善三方或本地配置'
  if (!String(s.operatorSecret ?? '').trim()) return 'OperatorSecret 为空，请完善三方配置'
  const aesErr = validateCecAesSecretPair(s.dataSecret, s.dataSecretIV)
  if (aesErr) {
    return `DataSecret/DataSecretIV 无效（须各为 16 字节 UTF-8）：${aesErr}`
  }
  return null
}

/**
 * query_token 专用出站秘钥（与 outboundPlatformSecrets 分离，保持历史联调行为）：
 * - 信封 OperatorID：本地平台编码
 * - Data 内 OperatorSecret 及签名/加解密：三方配置秘钥
 */
export function queryTokenOutboundSecrets(link: CecLinkConfig): {
  operatorId: string
  operatorSecret: string
  sigSecret: string
  dataSecret: string
  dataSecretIV: string
} {
  const loc = link.local
  const tp = link.thirdParty
  return {
    operatorId: String(loc.operatorId ?? '').trim(),
    operatorSecret: tp.operatorSecret,
    sigSecret: tp.sigSecret,
    dataSecret: tp.dataSecret,
    dataSecretIV: tp.dataSecretIV,
  }
}

function validateQueryTokenOutboundSecrets(link: CecLinkConfig): string | null {
  const s = queryTokenOutboundSecrets(link)
  if (!String(s.operatorId ?? '').trim()) {
    return '本地平台编码（OperatorID）为空，无法发起 query_token；请完善本地配置'
  }
  if (!String(s.operatorSecret ?? '').trim()) return 'OperatorSecret 为空，请完善三方配置'
  if (!String(s.sigSecret ?? '').trim()) return 'SigSecret 为空，请完善三方配置'
  const aesErr = validateCecAesSecretPair(s.dataSecret, s.dataSecretIV)
  if (aesErr) {
    return `DataSecret/DataSecretIV 无效（须各为 16 字节 UTF-8）：${aesErr}`
  }
  return null
}

export function invalidateThirdPartyToken(linkUuid: string): void {
  const snap = getCecSnapshot()
  const next = { ...snap.thirdPartyTokenByLink }
  delete next[linkUuid]
  patchCecSnapshot({ thirdPartyTokenByLink: next })
}

/** 清除本机签发给对端的 inbound Bearer token 缓存 */
export function invalidateInboundAuthToken(linkUuid: string): void {
  const snap = getCecSnapshot()
  const next = { ...(snap.inboundAuthTokenByLink ?? {}) }
  delete next[linkUuid]
  patchCecSnapshot({ inboundAuthTokenByLink: next })
}

/** 调用第三方 query_token，写入 thirdPartyTokenByLink */
async function fetchThirdPartyQueryToken(
  link: CecLinkConfig,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) {
    return { ok: false, error: '第三方互联互通地址无效' }
  }
  const url = `${base}/query_token`
  const ts = formatTs(new Date())
  const seq = '0001'
  const s = queryTokenOutboundSecrets(link)
  const cryptoErr = validateQueryTokenOutboundSecrets(link)
  if (cryptoErr) {
    return { ok: false, error: cryptoErr }
  }
  const dataObj: Record<string, unknown> = {
    OperatorID: s.operatorId,
    OperatorSecret: s.operatorSecret,
  }
  const dataStr = encryptDataJson(JSON.stringify(dataObj), s.dataSecret, s.dataSecretIV)
  const body = {
    OperatorID: s.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(s.operatorId, dataStr, ts, seq, s.sigSecret),
    Data: dataStr,
  }
  let res: Response
  let text: string
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    text = await res.text()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pushOutboundHttpLog('query_token(third)', 'fetch 失败', url, body, dataObj, { ok: false, error: msg })
    return { ok: false, error: `query_token: ${msg}` }
  }
  pushOutboundHttpLog(
    'query_token(third)',
    String(res.status),
    url,
    body,
    dataObj,
    {
      ok: true,
      status: res.status,
      responseText: text,
    },
    { responseDecrypt: { dataSecret: s.dataSecret, dataSecretIV: s.dataSecretIV } },
  )
  let json: Record<string, unknown>
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'query_token 响应非 JSON' }
  }
  const ret = Number(json.Ret ?? -1)
  if (ret !== 0) {
    return { ok: false, error: String(json.Msg ?? `Ret=${ret}`) }
  }
  const enc = json.Data
  let dataOut: Record<string, unknown>
  try {
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, s.dataSecret, s.dataSecretIV)
      dataOut = JSON.parse(plain) as Record<string, unknown>
    } else {
      dataOut = (json.Data as Record<string, unknown>) ?? {}
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `query_token Data 解析失败: ${err}` }
  }
  const accessToken = String(dataOut.AccessToken ?? dataOut.accessToken ?? '')
  if (!accessToken) {
    return { ok: false, error: 'query_token 响应中无 AccessToken' }
  }
  const ttlSec = Number(dataOut.TokenAvailableTime ?? dataOut.tokenAvailableTime ?? 3600)
  const expiresAtMs = Date.now() + Math.max(120, ttlSec) * 1000
  const snap = getCecSnapshot()
  const dock = link.linkUuid
  patchCecSnapshot({
    thirdPartyTokenByLink: {
      ...snap.thirdPartyTokenByLink,
      [dock]: { linkUuid: dock, accessToken, expiresAtMs },
    },
  })
  return { ok: true }
}

/**
 * 外联：仅按对接码（linkUuid）读缓存、刷新 query_token；订单/设备侧请求须传入其归属的对接码。
 */
async function ensureThirdPartyAccessTokenForLinkUuid(
  linkUuid: string,
  forceRefresh = false,
): Promise<string> {
  const link = getCecLinkByUuid(linkUuid)
  if (!link) throw new Error(`未找到对接码 ${linkUuid} 对应的互联互通配置`)

  if (!forceRefresh) {
    const c = getCecSnapshot().thirdPartyTokenByLink?.[linkUuid]
    const sameDock = !c?.linkUuid || c.linkUuid === linkUuid
    if (
      sameDock &&
      c?.accessToken &&
      c.expiresAtMs > Date.now() + THIRD_PARTY_TOKEN_SKEW_MS
    ) {
      return c.accessToken
    }
  }
  const r = await fetchThirdPartyQueryToken(link)
  if (!r.ok) throw new Error(r.error)
  const t = getCecSnapshot().thirdPartyTokenByLink?.[linkUuid]?.accessToken
  if (!t) throw new Error('token 未写入缓存')
  return t
}

export function isLikelyTokenBusinessFailure(ret: number, json: Record<string, unknown>): boolean {
  const msg = String(json.Msg ?? '')
  // 4002：对端 token 无效/过期（与本机 inbound 拒 token 的 Ret 一致）
  if ([4002, 4005, 4006, 4010].includes(ret)) return true
  if (/token|Token|令牌|鉴权|登录|access|过期|失效|未获取|没有/i.test(msg)) return true
  return false
}

type OutboundFetchAttempt = {
  httpStatus: number
  responseText: string
}

type OutboundJsonRetryResult =
  | { ok: true; json: Record<string, unknown>; httpStatus: number; responseText: string }
  | {
      ok: false
      error: string
      json?: Record<string, unknown>
      httpStatus?: number
      responseText?: string
    }

/**
 * 向外 HTTP：缓存无 token 时先 query_token；响应 Ret 表明 token 失效（含 4002）时刷新 token 并重试一次。
 */
async function fetchThirdPartyJsonWithTokenRetry(
  linkUuid: string,
  fetchOnce: (accessToken: string) => Promise<OutboundFetchAttempt>,
): Promise<OutboundJsonRetryResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let accessToken: string
    try {
      accessToken = await ensureThirdPartyAccessTokenForLinkUuid(linkUuid, attempt > 0)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: `获取 token 失败: ${msg}` }
    }
    if (!String(accessToken ?? '').trim()) {
      invalidateThirdPartyToken(linkUuid)
      if (attempt === 0) continue
      return { ok: false, error: 'token 为空' }
    }

    let httpStatus: number
    let responseText: string
    try {
      const res = await fetchOnce(accessToken)
      httpStatus = res.httpStatus
      responseText = res.responseText
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, error: msg }
    }

    let json: Record<string, unknown>
    try {
      json = JSON.parse(responseText) as Record<string, unknown>
    } catch {
      return { ok: false, error: '响应不是合法 JSON', httpStatus, responseText }
    }

    const ret = Number(json.Ret ?? -1)
    if (ret === 0) {
      return { ok: true, json, httpStatus, responseText }
    }

    if (attempt < 1 && isLikelyTokenBusinessFailure(ret, json)) {
      invalidateThirdPartyToken(linkUuid)
      continue
    }

    return {
      ok: false,
      error: String(json.Msg ?? `Ret=${ret}`),
      json,
      httpStatus,
      responseText,
    }
  }
  return { ok: false, error: '请求失败' }
}

function buildQueryStationsRequestBody(link: CecLinkConfig, pageNo: number, pageSize: number) {
  const ts = formatTs(new Date())
  const seq = pageNo.toString().padStart(4, '0')
  const s = outboundPlatformSecrets(link)
  const dataObj: Record<string, unknown> = {
    LastQueryTime: '',
    PageNo: pageNo,
    PageSize: pageSize,
  }
  const dataStr = encryptDataJson(JSON.stringify(dataObj), s.dataSecret, s.dataSecretIV)
  const body = {
    OperatorID: s.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(s.operatorId, dataStr, ts, seq, s.sigSecret),
    Data: dataStr,
  }
  return { ts, seq, body, dataObj }
}

function tryDecryptOutboundResponseData(
  responseText: string,
  secrets: { dataSecret: string; dataSecretIV: string },
): Record<string, unknown> | null {
  try {
    const json = JSON.parse(responseText) as Record<string, unknown>
    const enc = json.Data
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, secrets.dataSecret, secrets.dataSecretIV)
      return JSON.parse(plain) as Record<string, unknown>
    }
    if (enc && typeof enc === 'object') return enc as Record<string, unknown>
    return {}
  } catch {
    return null
  }
}

/** 向外 HTTP：JSON 结构含请求/响应明文与密文，供前端按条切换 */
function pushOutboundHttpLog(
  name: string,
  summary: string,
  url: string,
  requestBody: Record<string, unknown>,
  requestDataPlain: Record<string, unknown> | null,
  extra:
    | { ok: true; status: number; responseText: string }
    | { ok: false; error: string },
  opts?: { prefix?: string; responseDecrypt?: { dataSecret: string; dataSecretIV: string } },
): void {
  let responsePlain: Record<string, unknown> | null = null
  if (extra.ok && opts?.responseDecrypt) {
    responsePlain = tryDecryptOutboundResponseData(extra.responseText, opts.responseDecrypt)
  }
  const structured = {
    kind: 'cec_outbound_http' as const,
    name,
    summary,
    prefix: opts?.prefix ?? '',
    requestUrl: url,
    requestPlain: requestDataPlain,
    requestCipher: requestBody,
    responsePlain,
    responseCipher: extra.ok ? extra.responseText : null,
    httpStatus: extra.ok ? extra.status : null,
    error: extra.ok ? null : extra.error,
  }
  pushLog({
    t: Date.now(),
    direction: 'outbound',
    name,
    summary,
    body: JSON.stringify(structured).slice(0, 16000),
  })
}

function logPullAttempt(
  url: string,
  pageNo: number,
  requestBody: Record<string, unknown>,
  requestDataPlain: Record<string, unknown>,
  extra: { ok: true; status: number; responseText: string } | { ok: false; error: string },
  responseDecrypt?: { dataSecret: string; dataSecretIV: string },
): void {
  const prefix = `分页: ${pageNo}`
  if (extra.ok) {
    pushOutboundHttpLog(
      'query_stations_info',
      `${extra.status} page ${pageNo}`,
      url,
      requestBody,
      requestDataPlain,
      { ok: true, status: extra.status, responseText: extra.responseText },
      { prefix, responseDecrypt },
    )
  } else {
    pushOutboundHttpLog(
      'query_stations_info',
      `失败 page ${pageNo}`,
      url,
      requestBody,
      requestDataPlain,
      { ok: false, error: extra.error },
      { prefix },
    )
  }
}

function tagStationForDock(st: CecStationRecord, linkUuid: string): CecStationRecord {
  const equipmentInfos = Array.isArray(st.EquipmentInfos)
    ? st.EquipmentInfos.map((eq) => {
        if (eq && typeof eq === 'object') {
          return { ...(eq as Record<string, unknown>), LinkUuid: linkUuid }
        }
        return eq
      })
    : st.EquipmentInfos
  return {
    ...st,
    DockLinkUuid: linkUuid,
    EquipmentInfos: equipmentInfos,
  }
}

/** 同一对接码下按 StationID 合并：本次拉取覆盖同编号，保留本次未返回的已有站点 */
function mergeStationsForLink(
  prev: CecStationRecord[],
  pulledTagged: CecStationRecord[],
  linkUuid: string,
): CecStationRecord[] {
  const map = new Map<string, CecStationRecord>()
  for (const st of prev) {
    const sid = String(st.StationID ?? '').trim()
    if (sid) map.set(sid, tagStationForDock(st, linkUuid))
  }
  for (const st of pulledTagged) {
    const sid = String(st.StationID ?? '').trim()
    if (sid) map.set(sid, st)
  }
  const pullOrder: string[] = []
  const seenPull = new Set<string>()
  for (const st of pulledTagged) {
    const sid = String(st.StationID ?? '').trim()
    if (sid && !seenPull.has(sid)) {
      seenPull.add(sid)
      pullOrder.push(sid)
    }
  }
  const pullSet = new Set(pullOrder)
  const out: CecStationRecord[] = []
  for (const sid of pullOrder) {
    const row = map.get(sid)
    if (row) out.push(row)
  }
  for (const st of prev) {
    const sid = String(st.StationID ?? '').trim()
    if (sid && !pullSet.has(sid)) {
      const row = map.get(sid)
      if (row) out.push(row)
    }
  }
  return out
}

/** 作为第三方调用对端服务平台的 query_stations_info，分页直至拉完，结果写入 snapshot */
export async function pullStationsFromThirdParty(
  linkUuid: string,
  opts?: {
    pageSize?: number
    onProgress?: (p: CecPullStationsProgress) => void
  },
): Promise<{ ok: true; count: number; pages: number } | { ok: false; error: string }> {
  const link = getCecLinkByUuid(linkUuid)
  if (!link) return { ok: false, error: '未找到配置' }
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error: '第三方互联互通地址无效，请填写以 http:// 或 https:// 开头的根地址',
    }
  }
  const url = `${base.replace(/\/$/, '')}/query_stations_info`
  const pullSecrets = outboundPlatformSecrets(link)
  if (!String(pullSecrets.operatorId ?? '').trim()) {
    return {
      ok: false,
      error: '平台编码（OperatorID）为空，无法签名 query_stations_info；请填写本地或三方配置',
    }
  }

  const merged: CecStationRecord[] = []
  const seenStationId = new Set<string>()
  let pageNo = 1
  let pagesFetched = 0
  const pageSize = Math.min(
    STATION_PULL_PAGE_SIZE_MAX,
    Math.max(1, Math.floor(Number(opts?.pageSize ?? DEFAULT_STATION_PULL_PAGE_SIZE) || DEFAULT_STATION_PULL_PAGE_SIZE)),
  )

  try {
    for (;;) {
      const { body, dataObj } = buildQueryStationsRequestBody(link, pageNo, pageSize)
      const attempt = await fetchThirdPartyJsonWithTokenRetry(link.linkUuid, async (token) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(body),
          })
          return { httpStatus: res.status, responseText: await res.text() }
        } catch (fetchErr) {
          const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          const hint =
            errMsg.includes('fetch failed') || errMsg === 'Failed to fetch'
              ? `${errMsg}（常见原因：地址不可达、端口未开放、HTTPS 证书、或本机未启动对端服务）`
              : errMsg
          throw new Error(hint)
        }
      })

      if (!attempt.ok) {
        logPullAttempt(url, pageNo, body, dataObj, { ok: false, error: attempt.error })
        return { ok: false, error: attempt.error.startsWith('获取 token 失败') ? attempt.error : `网络请求失败: ${attempt.error}` }
      }

      logPullAttempt(
        url,
        pageNo,
        body,
        dataObj,
        { ok: true, status: attempt.httpStatus, responseText: attempt.responseText },
        pullSecrets,
      )

      const json = attempt.json
      const enc = json.Data
      let dataOut: Record<string, unknown>
      try {
        if (typeof enc === 'string') {
          const plain = decryptDataBase64(enc, pullSecrets.dataSecret, pullSecrets.dataSecretIV)
          dataOut = JSON.parse(plain) as Record<string, unknown>
        } else {
          dataOut = (json.Data as Record<string, unknown>) ?? {}
        }
      } catch (decErr) {
        const msg = decErr instanceof Error ? decErr.message : String(decErr)
        return { ok: false, error: `解密或解析 Data 失败: ${msg}` }
      }
      const stationInfos = (dataOut.StationInfos as CecStationRecord[]) ?? []
      pagesFetched += 1

      for (const st of stationInfos) {
        const sid = String(st.StationID ?? '')
        if (sid) {
          if (seenStationId.has(sid)) continue
          seenStationId.add(sid)
        }
        merged.push(st)
      }

      const totalPages = Number(dataOut.PageCount ?? 0)
      opts?.onProgress?.({ pageNo, totalPages, pagesFetched })

      if (totalPages > 0 && pageNo >= totalPages) break
      if (stationInfos.length === 0) break
      if (stationInfos.length < pageSize) break

      pageNo += 1
      if (pageNo > 5000) break
    }

    const tagged = merged.map((st) => tagStationForDock(st, linkUuid))
    const snap = getCecSnapshot()
    const prev = snap.stationsByLink[linkUuid] ?? []
    const finalStations = mergeStationsForLink(prev, tagged, linkUuid)

    const stationsByLink = { ...snap.stationsByLink, [linkUuid]: finalStations }
    const connectorMap: CecSnapshot['connectorMap'] = {}
    for (const [cid, meta] of Object.entries(snap.connectorMap)) {
      if (meta.linkUuid !== linkUuid) connectorMap[cid] = meta
    }
    for (const st of finalStations) {
      const eqs = (st as { EquipmentInfos?: { ConnectorInfos?: { ConnectorID: string }[] }[] })
        .EquipmentInfos
      if (!eqs) continue
      for (const eq of eqs) {
        const cis = eq.ConnectorInfos
        if (!cis) continue
        for (const c of cis) {
          connectorMap[String(c.ConnectorID)] = {
            linkUuid,
            operatorId: link.thirdParty.operatorId,
          }
        }
      }
    }
    setCecSnapshot({ ...snap, stationsByLink, connectorMap })
    return { ok: true, count: finalStations.length, pages: pagesFetched }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    pushLog({
      t: Date.now(),
      direction: 'outbound',
      name: 'query_stations_info',
      summary: '异常',
      body: String(msg).slice(0, 8000),
    })
    return { ok: false, error: msg }
  }
}

function normalizePolicyInfosFromData(raw: unknown): CecPolicyInfo[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => {
    const o = x as Record<string, unknown>
    const elec = o.ElecPrice ?? o.elecPrice
    const sev = o.SevicePrice ?? o.ServicePrice ?? o.sevicePrice ?? o.servicePrice
    return {
      StartTime: String(o.StartTime ?? '').padStart(6, '0').slice(0, 6),
      ElecPrice: Number(elec),
      SevicePrice: Number(sev),
      ServicePrice: o.ServicePrice != null ? Number(o.ServicePrice) : undefined,
    }
  })
}

/** 兼容各平台对 Data 内字段命名（Pascal / camel / 单条 PolicyInfo） */
function extractPolicyInfosFromDataOut(dataOut: Record<string, unknown>): CecPolicyInfo[] {
  const raw =
    dataOut.PolicyInfos ??
    dataOut.policyInfos ??
    dataOut.PolicyInfo ??
    dataOut.policyInfo
  if (Array.isArray(raw)) return normalizePolicyInfosFromData(raw)
  if (raw && typeof raw === 'object') return normalizePolicyInfosFromData([raw])
  return []
}

function parseSuccStat(dataOut: Record<string, unknown>, policyInfosLen: number): number {
  const raw = dataOut.SuccStat ?? dataOut.succStat
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw)
    return Number.isNaN(n) ? 1 : n
  }
  /** 多数平台在 Ret=0 且返回时段列表时省略 SuccStat，文档默认成功为 0 */
  return policyInfosLen > 0 ? 0 : 1
}

function isOrderFinishedByProtocolState(o: CecOrderRecord): boolean {
  return o.protocolState === 4 || o.productState === 'completed'
}

/** 订单状态同步：仅 1~4 为有效 StartChargeSeqStat，5 及其他值不更新本地订单 */
function parseSyncStartChargeSeqStat(dataOut: Record<string, unknown>): 1 | 2 | 3 | 4 | null {
  const raw = dataOut.StartChargeSeqStat ?? dataOut.StartChargeSeqSta
  if (raw === undefined || raw === null || raw === '') return null
  const n = Number(raw)
  if (n >= 1 && n <= 4) return n as 1 | 2 | 3 | 4
  return null
}

function buildCompletedOrderInfoFromChargeStatus(
  order: CecOrderRecord,
  dataOut: Record<string, unknown>,
): NonNullable<CecOrderRecord['orderInfo']> {
  const totalPower = Number(dataOut.TotalPower ?? 0)
  const totalMoney = Number(dataOut.TotalMoney ?? 0)
  const totalElecMoney = Number(dataOut.ElecMoney ?? dataOut.TotalElecMoney ?? 0)
  const totalSeviceMoney = readChargeStatusServiceMoney(dataOut)
  return {
    ...(order.orderInfo ?? {
      startChargeSeq: order.startChargeSeq,
      connectorId: order.connectorId,
      totalPower: 0,
      totalElecMoney: 0,
      totalSeviceMoney: 0,
      totalMoney: 0,
    }),
    startChargeSeq: String(dataOut.StartChargeSeq ?? order.startChargeSeq).trim() || order.startChargeSeq,
    connectorId: String(dataOut.ConnectorID ?? order.connectorId).trim() || order.connectorId,
    totalPower,
    totalElecMoney,
    totalSeviceMoney,
    totalMoney,
    stopReason:
      dataOut.StopReason != null && dataOut.StopReason !== ''
        ? Number(dataOut.StopReason)
        : order.orderInfo?.stopReason,
    sumPeriod:
      dataOut.SumPeriod != null && dataOut.SumPeriod !== ''
        ? Number(dataOut.SumPeriod)
        : Array.isArray(dataOut.ChargeDetails)
          ? dataOut.ChargeDetails.length
          : order.orderInfo?.sumPeriod,
    chargeDetails: Array.isArray(dataOut.ChargeDetails)
      ? (dataOut.ChargeDetails as unknown[])
      : (order.orderInfo?.chargeDetails ?? []),
    startTime: String(dataOut.StartTime ?? order.orderInfo?.startTime ?? '').trim() || order.orderInfo?.startTime,
    endTime: String(dataOut.EndTime ?? order.orderInfo?.endTime ?? '').trim() || order.orderInfo?.endTime,
  }
}

export function applyChargeStatusToOrder(
  order: CecOrderRecord,
  dataOut: Record<string, unknown>,
  now: number,
): CecOrderRecord {
  const sta = parseSyncStartChargeSeqStat(dataOut)
  if (sta === null) return order

  const totalPower = Number(dataOut.TotalPower ?? 0)
  const totalMoney = Number(dataOut.TotalMoney ?? 0)
  const totalElecMoney = Number(dataOut.ElecMoney ?? dataOut.TotalElecMoney ?? 0)
  const totalSeviceMoney = readChargeStatusServiceMoney(dataOut)
  const nextOrderInfo = sta === 4 ? buildCompletedOrderInfoFromChargeStatus(order, dataOut) : order.orderInfo
  return {
    ...order,
    protocolState: sta,
    productState: productStateFromStartChargeSeqSta(sta),
    suspendAt: sta >= 2 ? undefined : order.suspendAt,
    updatedAt: now,
    samples: [
      ...order.samples,
      {
        t: now,
        totalPower,
        totalMoney,
        elecMoney: totalElecMoney,
        serviceMoney: totalSeviceMoney,
        voltageA: Number(dataOut.VoltageA ?? 0),
        currentA: Number(dataOut.CurrentA ?? 0),
        soc: readChargeStatusSoc(dataOut),
      },
    ].slice(-2000),
    rawEvents: [
      ...order.rawEvents,
      {
        t: now,
        direction: 'inbound',
        // 复用 notification 名称，保证前端过程数据图表按既有逻辑展示
        name: 'notification_equip_charge_status',
        payload: JSON.stringify(dataOut),
      },
    ].slice(-500),
    orderInfo: nextOrderInfo,
  }
}

/**
 * 作为第三方调用对端服务平台的 query_equip_business_policy，结果写入 equipBusinessPolicyByKey。
 */
export async function queryEquipBusinessPolicyFromThirdParty(
  linkUuid: string,
  connectorId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const link = getCecLinkByUuid(linkUuid)
    if (!link) return { ok: false, error: '未找到配置' }
    const base = thirdPartyOutboundBase(link.thirdParty)
    if (!base || !/^https?:\/\//i.test(base)) {
      return {
        ok: false,
        error: '第三方互联互通地址无效，请填写以 http:// 或 https:// 开头的根地址',
      }
    }
    const cryptoErr = validateOutboundCryptoSecrets(link)
    if (cryptoErr) return { ok: false, error: cryptoErr }
    const url = `${base.replace(/\/$/, '')}/query_equip_business_policy`
    const pullSecrets = outboundPlatformSecrets(link)
    const cid = String(connectorId ?? '').trim()
    if (!cid) return { ok: false, error: 'ConnectorID 为空' }

    const policyCacheKey = `${linkUuid}::${cid}`

    const equipBizSeq = makeStartChargeSeq(pullSecrets.operatorId)
    const dataObj: Record<string, unknown> = {
      EquipBizSeq: equipBizSeq,
      ConnectorID: cid,
    }
    const ts = formatTs(new Date())
    const seq = '0001'
    const dataStr = encryptDataJson(JSON.stringify(dataObj), pullSecrets.dataSecret, pullSecrets.dataSecretIV)
    const body = {
      OperatorID: pullSecrets.operatorId,
      TimeStamp: ts,
      Seq: seq,
      Sig: signEnvelope(pullSecrets.operatorId, dataStr, ts, seq, pullSecrets.sigSecret),
      Data: dataStr,
    }

    const patchPolicy = (entry: CecEquipBusinessPolicyCache) => {
      const snap = getCecSnapshot()
      setCecSnapshot({
        ...snap,
        equipBusinessPolicyByKey: {
          ...(snap.equipBusinessPolicyByKey ?? {}),
          [policyCacheKey]: entry,
        },
      })
    }

    const attempt = await fetchThirdPartyJsonWithTokenRetry(link.linkUuid, async (token) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        })
        return { httpStatus: res.status, responseText: await res.text() }
      } catch (fetchErr) {
        const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        const hint =
          errMsg.includes('fetch failed') || errMsg === 'Failed to fetch'
            ? `${errMsg}（常见原因：地址不可达、端口未开放）`
            : errMsg
        throw new Error(hint)
      }
    })

    if (!attempt.ok) {
      pushOutboundHttpLog(
        'query_equip_business_policy',
        attempt.httpStatus != null ? String(attempt.httpStatus) : 'fetch 失败',
        url,
        body,
        dataObj,
        { ok: false, error: attempt.error },
      )
      patchPolicy({
        linkUuid,
        connectorId: cid,
        fetchedAt: Date.now(),
        errorMessage: attempt.error,
      })
      return { ok: false, error: attempt.error }
    }

    pushOutboundHttpLog(
      'query_equip_business_policy',
      String(attempt.httpStatus),
      url,
      body,
      dataObj,
      { ok: true, status: attempt.httpStatus, responseText: attempt.responseText },
      { responseDecrypt: { dataSecret: pullSecrets.dataSecret, dataSecretIV: pullSecrets.dataSecretIV } },
    )

    const json = attempt.json
    const enc = json.Data
    let dataOut: Record<string, unknown>
    try {
      if (typeof enc === 'string') {
        const plain = decryptDataBase64(enc, pullSecrets.dataSecret, pullSecrets.dataSecretIV)
        dataOut = JSON.parse(plain) as Record<string, unknown>
      } else {
        dataOut = (json.Data as Record<string, unknown>) ?? {}
      }
    } catch (decErr) {
      const msg = decErr instanceof Error ? decErr.message : String(decErr)
      patchPolicy({
        linkUuid,
        connectorId: cid,
        fetchedAt: Date.now(),
        errorMessage: `解密或解析 Data 失败: ${msg}`,
      })
      return { ok: false, error: `解密或解析 Data 失败: ${msg}` }
    }

    const policyInfos = extractPolicyInfosFromDataOut(dataOut)
    const succ = parseSuccStat(dataOut, policyInfos.length)
    const bizErr =
      succ !== 0
        ? `业务失败 SuccStat=${succ} FailReason=${String(dataOut.FailReason ?? dataOut.failReason ?? '')}`
        : undefined

    patchPolicy({
      linkUuid,
      connectorId: cid,
      fetchedAt: Date.now(),
      EquipBizSeq: String(dataOut.EquipBizSeq ?? equipBizSeq),
      SuccStat: succ,
      FailReason: Number(dataOut.FailReason ?? 0),
      SumPeriod: Number(
        dataOut.SumPeriod ?? dataOut.sumPeriod ?? (policyInfos.length > 0 ? policyInfos.length : 0),
      ),
      PolicyInfos: policyInfos,
      errorMessage: bizErr,
    })

    if (succ !== 0) {
      return { ok: false, error: bizErr ?? '业务失败' }
    }
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: msg }
  }
}

function parseConnectorStatusInfosFromPayload(raw: unknown): CecConnectorStatusInfo[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => {
    const o = x as Record<string, unknown>
    return {
      ConnectorID: String(o.ConnectorID ?? o.connectorID ?? ''),
      Status: Number(o.Status ?? o.status ?? 0),
      ParkStatus:
        o.ParkStatus != null && o.ParkStatus !== ''
          ? Number(o.ParkStatus)
          : o.parkStatus != null && o.parkStatus !== ''
            ? Number(o.parkStatus)
            : undefined,
      LockStatus:
        o.LockStatus != null && o.LockStatus !== ''
          ? Number(o.LockStatus)
          : o.lockStatus != null && o.lockStatus !== ''
            ? Number(o.lockStatus)
            : undefined,
    }
  })
}

/**
 * 作为第三方调用对端服务平台的 query_station_status，结果写入 stationStatusByKey。
 */
export async function queryStationStatusFromThirdParty(
  linkUuid: string,
  stationIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const link = getCecLinkByUuid(linkUuid)
  if (!link) return { ok: false, error: '未找到配置' }
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error: '第三方互联互通地址无效，请填写以 http:// 或 https:// 开头的根地址',
    }
  }
  const ids = stationIds.map((s) => String(s).trim()).filter(Boolean)
  if (ids.length === 0) return { ok: false, error: 'StationIDs 为空' }
  if (ids.length > 50) return { ok: false, error: 'StationIDs 数量不能超过 50' }

  const url = `${base.replace(/\/$/, '')}/query_station_status`
  const pullSecrets = outboundPlatformSecrets(link)
  if (!String(pullSecrets.operatorId ?? '').trim()) {
    return { ok: false, error: '平台编码（OperatorID）为空，无法签名 query_station_status' }
  }

  const dataObj: Record<string, unknown> = {
    StationIDs: ids,
  }
  const ts = formatTs(new Date())
  const seq = '0001'
  const dataStr = encryptDataJson(JSON.stringify(dataObj), pullSecrets.dataSecret, pullSecrets.dataSecretIV)
  const body = {
    OperatorID: pullSecrets.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(pullSecrets.operatorId, dataStr, ts, seq, pullSecrets.sigSecret),
    Data: dataStr,
  }

  const patchStatus = (entries: CecStationStatusCache[]) => {
    const snap = getCecSnapshot()
    const next = { ...(snap.stationStatusByKey ?? {}) }
    const now = Date.now()
    for (const e of entries) {
      const key = `${e.linkUuid}::${e.StationID}`
      next[key] = { ...e, fetchedAt: e.fetchedAt || now }
    }
    setCecSnapshot({ ...snap, stationStatusByKey: next })
  }

  const attempt = await fetchThirdPartyJsonWithTokenRetry(link.linkUuid, async (token) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      return { httpStatus: res.status, responseText: await res.text() }
    } catch (fetchErr) {
      const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      const hint =
        errMsg.includes('fetch failed') || errMsg === 'Failed to fetch'
          ? `${errMsg}（常见原因：地址不可达、端口未开放）`
          : errMsg
      throw new Error(hint)
    }
  })

  if (!attempt.ok) {
    pushOutboundHttpLog(
      'query_station_status',
      attempt.httpStatus != null ? String(attempt.httpStatus) : 'fetch 失败',
      url,
      body,
      dataObj,
      { ok: false, error: attempt.error },
    )
    return { ok: false, error: attempt.error }
  }

  pushOutboundHttpLog(
    'query_station_status',
    String(attempt.httpStatus),
    url,
    body,
    dataObj,
    {
      ok: true,
      status: attempt.httpStatus,
      responseText: attempt.responseText,
    },
    { responseDecrypt: { dataSecret: pullSecrets.dataSecret, dataSecretIV: pullSecrets.dataSecretIV } },
  )

  const json = attempt.json
  const enc = json.Data
  let dataOut: Record<string, unknown>
  try {
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, pullSecrets.dataSecret, pullSecrets.dataSecretIV)
      dataOut = JSON.parse(plain) as Record<string, unknown>
    } else {
      dataOut = (json.Data as Record<string, unknown>) ?? {}
    }
  } catch (decErr) {
    const msg = decErr instanceof Error ? decErr.message : String(decErr)
    return { ok: false, error: `解密或解析 Data 失败: ${msg}` }
  }

  const rawList =
    dataOut.StationStatusInfos ??
    dataOut.stationStatusInfos ??
    (Array.isArray(dataOut.StationStatusInfo) ? dataOut.StationStatusInfo : undefined)

  let list: Record<string, unknown>[]
  if (Array.isArray(rawList)) {
    list = rawList as Record<string, unknown>[]
  } else if (rawList && typeof rawList === 'object') {
    list = [rawList as Record<string, unknown>]
  } else {
    list = []
  }

  const entries: CecStationStatusCache[] = []
  for (const st of list) {
    const sid = String(st.StationID ?? st.stationID ?? '').trim()
    if (!sid) continue
    const infos = parseConnectorStatusInfosFromPayload(st.ConnectorStatusInfos ?? st.connectorStatusInfos)
    entries.push({
      linkUuid,
      StationID: sid,
      ConnectorStatusInfos: infos,
      fetchedAt: Date.now(),
    })
  }

  patchStatus(entries)
  return { ok: true }
}

/** 模拟第三方调用对端服务平台的 query_stop_charge（互联互通根地址 + outboundPlatformSecrets + Bearer，与 query_stations_info 一致） */
export async function postLocalQueryStopCharge(
  link: CecLinkConfig,
  startChargeSeq: string,
  connectorId: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error: '第三方互联互通地址无效，请填写以 http:// 或 https:// 开头的根地址',
    }
  }
  const pullSecrets = outboundPlatformSecrets(link)
  if (!String(pullSecrets.operatorId ?? '').trim()) {
    return { ok: false, error: '平台编码（OperatorID）为空，无法签名 query_stop_charge' }
  }
  const cid = String(connectorId ?? '').trim()
  if (!cid) return { ok: false, error: 'ConnectorID 为空' }
  const seqStr = String(startChargeSeq ?? '').trim()
  if (!seqStr) return { ok: false, error: 'StartChargeSeq 为空' }

  const url = `${base.replace(/\/$/, '')}/query_stop_charge`
  const dataObj: Record<string, unknown> = {
    StartChargeSeq: seqStr,
    ConnectorID: cid,
  }
  const ts = formatTs(new Date())
  const seq = '0001'
  const dataStr = encryptDataJson(JSON.stringify(dataObj), pullSecrets.dataSecret, pullSecrets.dataSecretIV)
  const body = {
    OperatorID: pullSecrets.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(pullSecrets.operatorId, dataStr, ts, seq, pullSecrets.sigSecret),
    Data: dataStr,
  }

  const attempt = await fetchThirdPartyJsonWithTokenRetry(link.linkUuid, async (token) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      return { httpStatus: res.status, responseText: await res.text() }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const hint =
        msg.includes('fetch failed') || msg === 'Failed to fetch'
          ? `${msg}（常见原因：地址不可达、端口未开放、HTTPS 证书、或本机未启动对端服务）`
          : msg
      throw new Error(hint)
    }
  })

  if (!attempt.ok) {
    pushOutboundHttpLog(
      'query_stop_charge',
      attempt.httpStatus != null ? String(attempt.httpStatus) : 'fetch 失败',
      url,
      body,
      dataObj,
      { ok: false, error: attempt.error },
    )
    return { ok: false, error: attempt.error }
  }

  pushOutboundHttpLog(
    'query_stop_charge',
    String(attempt.httpStatus),
    url,
    body,
    dataObj,
    {
      ok: true,
      status: attempt.httpStatus,
      responseText: attempt.responseText,
    },
    { responseDecrypt: { dataSecret: pullSecrets.dataSecret, dataSecretIV: pullSecrets.dataSecretIV } },
  )

  const json = attempt.json
  const text = attempt.responseText
  let dataOut: Record<string, unknown>
  try {
    const enc = json.Data
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, pullSecrets.dataSecret, pullSecrets.dataSecretIV)
      dataOut = JSON.parse(plain) as Record<string, unknown>
    } else {
      dataOut = (enc as Record<string, unknown>) ?? {}
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `停止响应解析失败: ${msg}` }
  }
  const succStat = Number(dataOut.SuccStat ?? 1)
  if (succStat !== 0) {
    const failReason = String(dataOut.FailReason ?? '')
    return { ok: false, error: `停止失败：FailReason=${failReason || '未知'}` }
  }

  return { ok: true, text }
}

/** 模拟第三方调用对端服务平台的 query_start_charge（互联互通根地址 + outboundPlatformSecrets + Bearer，与 query_stations_info 一致） */
export async function postLocalQueryStartCharge(
  link: CecLinkConfig,
  connectorId: string,
  qr: string,
  money?: number,
): Promise<
  { ok: true; text: string; startChargeSeq: string } | { ok: false; error: string }
> {
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error: '第三方互联互通地址无效，请填写以 http:// 或 https:// 开头的根地址',
    }
  }
  const pullSecrets = outboundPlatformSecrets(link)
  if (!String(pullSecrets.operatorId ?? '').trim()) {
    return {
      ok: false,
      error: '平台编码（OperatorID）为空，无法签名 query_start_charge；请完善本地或三方配置',
    }
  }
  const cid = String(connectorId ?? '').trim()
  if (!cid) return { ok: false, error: 'ConnectorID 为空' }

  const startChargeSeq = makeStartChargeSeqNumeric20()
  const localOrderId = randomUUID()
  const createAt = Date.now()
  {
    const snap = getCecSnapshot()
    const order: CecOrderRecord = {
      id: localOrderId,
      linkUuid: link.linkUuid,
      startChargeSeq,
      connectorId: cid,
      productState: 'starting',
      protocolState: 1,
      createdAt: createAt,
      updatedAt: createAt,
      suspendAt: createAt + 120_000,
      samples: [],
      rawEvents: [],
    }
    setCecSnapshot({ ...snap, orders: [...snap.orders, order] })
  }

  const patchLocalOrder = (
    patch: Partial<Pick<CecOrderRecord, 'startChargeSeq' | 'productState' | 'protocolState' | 'suspendAt'>>,
  ) => {
    const snap = getCecSnapshot()
    const now = Date.now()
    const orders = snap.orders.map((o) => {
      if (o.id !== localOrderId) return o
      return {
        ...o,
        ...patch,
        updatedAt: now,
      }
    })
    setCecSnapshot({ ...snap, orders })
  }

  const dataObj: Record<string, unknown> = {
    StartChargeSeq: startChargeSeq,
    ConnectorID: cid,
    QRCode: qr,
  }
  if (money != null && Number.isFinite(money)) {
    dataObj.Money = money
  }
  const ts = formatTs(new Date())
  const seq = '0001'
  const dataStr = encryptDataJson(JSON.stringify(dataObj), pullSecrets.dataSecret, pullSecrets.dataSecretIV)
  const body = {
    OperatorID: pullSecrets.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(pullSecrets.operatorId, dataStr, ts, seq, pullSecrets.sigSecret),
    Data: dataStr,
  }

  const url = `${base.replace(/\/$/, '')}/query_start_charge`

  const attempt = await fetchThirdPartyJsonWithTokenRetry(link.linkUuid, async (token) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      return { httpStatus: res.status, responseText: await res.text() }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const hint =
        msg.includes('fetch failed') || msg === 'Failed to fetch'
          ? `${msg}（常见原因：地址不可达、端口未开放、HTTPS 证书、或本机未启动对端服务）`
          : msg
      throw new Error(hint)
    }
  })

  const failStart = () => {
    patchLocalOrder({
      productState: 'start_failed',
      protocolState: 5,
      suspendAt: undefined,
    })
  }

  if (!attempt.ok) {
    pushOutboundHttpLog(
      'query_start_charge',
      attempt.httpStatus != null ? String(attempt.httpStatus) : 'fetch 失败',
      url,
      body,
      dataObj,
      { ok: false, error: attempt.error },
    )
    failStart()
    return { ok: false, error: attempt.error }
  }

  pushOutboundHttpLog(
    'query_start_charge',
    String(attempt.httpStatus),
    url,
    body,
    dataObj,
    {
      ok: true,
      status: attempt.httpStatus,
      responseText: attempt.responseText,
    },
    { responseDecrypt: { dataSecret: pullSecrets.dataSecret, dataSecretIV: pullSecrets.dataSecretIV } },
  )

  const text = attempt.responseText
  if (attempt.httpStatus < 200 || attempt.httpStatus >= 300) {
    failStart()
    return { ok: false, error: `HTTP ${attempt.httpStatus}` }
  }

  const biz = parseQueryStartChargeHttpResponse(text, pullSecrets)
  if (!biz.ok) {
    failStart()
    return biz
  }
  patchLocalOrder({
    startChargeSeq: String(biz.startChargeSeq || startChargeSeq),
    productState: 'starting',
    protocolState: 1,
    suspendAt: Date.now() + 120_000,
  })
  return { ok: true, text, startChargeSeq: biz.startChargeSeq }
}

/** 模拟第三方调用对端服务平台的 query_terminal_code（token + 加解密签名与 query_stations_info 一致） */
export async function postLocalQueryTerminalCode(
  link: CecLinkConfig,
  qrCode: string,
  opts?: { longitude?: number; latitude?: number },
): Promise<{ ok: true; connectorId: string; linkUuid: string } | { ok: false; error: string }> {
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) {
    return {
      ok: false,
      error: '第三方互联互通地址无效，请填写以 http:// 或 https:// 开头的根地址',
    }
  }
  const pullSecrets = outboundPlatformSecrets(link)
  if (!String(pullSecrets.operatorId ?? '').trim()) {
    return {
      ok: false,
      error: '平台编码（OperatorID）为空，无法签名 query_terminal_code；请完善本地或三方配置',
    }
  }
  const qr = String(qrCode ?? '').trim()
  if (!qr) return { ok: false, error: 'QRCode 为空' }

  const dataObj: Record<string, unknown> = { QRCode: qr }
  if (opts?.longitude != null && Number.isFinite(opts.longitude)) {
    dataObj.Longitude = opts.longitude
  }
  if (opts?.latitude != null && Number.isFinite(opts.latitude)) {
    dataObj.Latitude = opts.latitude
  }
  const ts = formatTs(new Date())
  const seq = '0001'
  const dataStr = encryptDataJson(JSON.stringify(dataObj), pullSecrets.dataSecret, pullSecrets.dataSecretIV)
  const body = {
    OperatorID: pullSecrets.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(pullSecrets.operatorId, dataStr, ts, seq, pullSecrets.sigSecret),
    Data: dataStr,
  }

  const url = `${base.replace(/\/$/, '')}/query_terminal_code`

  const attempt = await fetchThirdPartyJsonWithTokenRetry(link.linkUuid, async (token) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      return { httpStatus: res.status, responseText: await res.text() }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const hint =
        msg.includes('fetch failed') || msg === 'Failed to fetch'
          ? `${msg}（常见原因：地址不可达、端口未开放、HTTPS 证书、或本机未启动对端服务）`
          : msg
      throw new Error(hint)
    }
  })

  if (!attempt.ok) {
    pushOutboundHttpLog(
      'query_terminal_code',
      attempt.httpStatus != null ? String(attempt.httpStatus) : 'fetch 失败',
      url,
      body,
      dataObj,
      { ok: false, error: attempt.error },
    )
    return { ok: false, error: attempt.error }
  }

  pushOutboundHttpLog(
    'query_terminal_code',
    String(attempt.httpStatus),
    url,
    body,
    dataObj,
    { ok: true, status: attempt.httpStatus, responseText: attempt.responseText },
    { responseDecrypt: { dataSecret: pullSecrets.dataSecret, dataSecretIV: pullSecrets.dataSecretIV } },
  )

  if (attempt.httpStatus < 200 || attempt.httpStatus >= 300) {
    return { ok: false, error: `HTTP ${attempt.httpStatus}` }
  }

  const biz = parseQueryTerminalCodeHttpResponse(attempt.responseText, pullSecrets)
  if (!biz.ok) return biz
  return { ok: true, connectorId: biz.connectorId, linkUuid: link.linkUuid }
}

async function pullOrderChargeStatusFromThirdParty(order: CecOrderRecord): Promise<void> {
  const link = getCecLinkByUuid(order.linkUuid)
  if (!link) return
  const base = thirdPartyOutboundBase(link.thirdParty)
  if (!base || !/^https?:\/\//i.test(base)) return
  const pullSecrets = outboundPlatformSecrets(link)
  if (!String(pullSecrets.operatorId ?? '').trim()) return

  const url = `${base.replace(/\/$/, '')}/query_equip_charge_status`
  const dataObj: Record<string, unknown> = {
    StartChargeSeq: order.startChargeSeq,
  }
  const ts = formatTs(new Date())
  const seq = '0001'
  const dataStr = encryptDataJson(JSON.stringify(dataObj), pullSecrets.dataSecret, pullSecrets.dataSecretIV)
  const body = {
    OperatorID: pullSecrets.operatorId,
    TimeStamp: ts,
    Seq: seq,
    Sig: signEnvelope(pullSecrets.operatorId, dataStr, ts, seq, pullSecrets.sigSecret),
    Data: dataStr,
  }

  const attempt = await fetchThirdPartyJsonWithTokenRetry(order.linkUuid, async (token) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })
      return { httpStatus: res.status, responseText: await res.text() }
    } catch {
      throw new Error('fetch failed')
    }
  })

  if (!attempt.ok) return

  pushOutboundHttpLog(
    'query_equip_charge_status',
    String(attempt.httpStatus),
    url,
    body,
    dataObj,
    { ok: true, status: attempt.httpStatus, responseText: attempt.responseText },
    { responseDecrypt: { dataSecret: pullSecrets.dataSecret, dataSecretIV: pullSecrets.dataSecretIV } },
  )

  const json = attempt.json
  let dataOut: Record<string, unknown>
  try {
    const enc = json.Data
    if (typeof enc === 'string') {
      const plain = decryptDataBase64(enc, pullSecrets.dataSecret, pullSecrets.dataSecretIV)
      dataOut = JSON.parse(plain) as Record<string, unknown>
    } else {
      dataOut = (enc as Record<string, unknown>) ?? {}
    }
  } catch {
    return
  }
  if (!isQueryChargeStatusResponseUsable(dataOut)) return

  const now = Date.now()
  const snap = getCecSnapshot()
  const orders = snap.orders.map((o) => {
    if (o.id !== order.id) return o
    return applyChargeStatusToOrder(o, dataOut, now)
  })
  setCecSnapshot({ ...snap, orders })
}

/** 订单挂起巡检 */
export function tickCecOrders(): void {
  const snap = getCecSnapshot()
  const now = Date.now()
  let changed = false
  const orders = snap.orders.map((o) => {
    if (o.productState !== 'starting' || !o.suspendAt) return o
    if (now < o.suspendAt) return o
    changed = true
    return { ...o, productState: 'suspended' as const, updatedAt: now }
  })
  if (changed) setCecSnapshot({ ...snap, orders })
}

export async function syncOrderChargeStatusById(
  orderId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = String(orderId ?? '').trim()
  if (!id) return { ok: false, error: 'order id 为空' }
  const order = getCecSnapshot().orders.find((o) => o.id === id)
  if (!order) return { ok: false, error: '订单不存在' }
  await pullOrderChargeStatusFromThirdParty(order)
  const updated = getCecSnapshot().orders.find((o) => o.id === id)
  if (!updated || updated.updatedAt <= order.updatedAt) {
    return { ok: false, error: '未收到有效充电状态响应，订单未更新' }
  }
  return { ok: true }
}
