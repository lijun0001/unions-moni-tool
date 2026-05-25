import type {
  CecInboundAuthTokenEntry,
  CecEquipBusinessPolicyCache,
  CecLogEntry,
  CecOrderRecord,
  CecStationStatusCache,
  CecThirdPartyTokenEntry,
} from '../../src/shared/cec-types'

/** 按对接码（Record 键 = linkUuid）合并 token，保留过期时间更晚的条目 */
export function mergeThirdPartyTokenByLink(
  cur: Record<string, CecThirdPartyTokenEntry>,
  incoming: Record<string, CecThirdPartyTokenEntry> | undefined,
): Record<string, CecThirdPartyTokenEntry> {
  if (!incoming) return { ...cur }
  const out: Record<string, CecThirdPartyTokenEntry> = { ...cur }
  for (const [k, v] of Object.entries(incoming)) {
    const normalized: CecThirdPartyTokenEntry = {
      ...v,
      linkUuid: v.linkUuid ?? k,
    }
    const ex = out[k]
    if (!ex || normalized.expiresAtMs >= ex.expiresAtMs) out[k] = normalized
  }
  return out
}

/** 按对接码合并本地下发 token，保留过期时间更晚的条目 */
export function mergeInboundAuthTokenByLink(
  cur: Record<string, CecInboundAuthTokenEntry>,
  incoming: Record<string, CecInboundAuthTokenEntry> | undefined,
): Record<string, CecInboundAuthTokenEntry> {
  if (!incoming) return { ...cur }
  const out: Record<string, CecInboundAuthTokenEntry> = { ...cur }
  for (const [k, v] of Object.entries(incoming)) {
    const normalized: CecInboundAuthTokenEntry = {
      ...v,
      linkUuid: v.linkUuid ?? k,
      issuedAtMs: Number(v.issuedAtMs ?? 0),
      expiresAtMs: Number(v.expiresAtMs ?? 0),
    }
    const ex = out[k]
    if (!ex || normalized.expiresAtMs >= ex.expiresAtMs) out[k] = normalized
  }
  return out
}

/** 按 id 合并订单，保留 updatedAt 更新的版本（兼顾主进程 HTTP 与渲染进程持久化回灌） */
export function mergeCecOrders(cur: CecOrderRecord[], incoming: CecOrderRecord[]): CecOrderRecord[] {
  const m = new Map<string, CecOrderRecord>()
  for (const o of cur) m.set(o.id, o)
  for (const o of incoming) {
    const ex = m.get(o.id)
    if (!ex || o.updatedAt >= ex.updatedAt) m.set(o.id, o)
  }
  return [...m.values()]
}

/** 按 id 合并日志后按时间排序，环形保留最近 max 条 */
export function mergeCecLogs(cur: CecLogEntry[], incoming: CecLogEntry[], max: number): CecLogEntry[] {
  const m = new Map<string, CecLogEntry>()
  for (const e of cur) m.set(e.id, e)
  for (const e of incoming) {
    const ex = m.get(e.id)
    if (!ex || e.t >= ex.t) m.set(e.id, e)
  }
  const arr = [...m.values()].sort((a, b) => a.t - b.t)
  return arr.slice(-max)
}

/** 按 key 合并费率缓存，保留 fetchedAt 更新的版本 */
export function mergeEquipBusinessPolicy(
  cur: Record<string, CecEquipBusinessPolicyCache>,
  incoming: Record<string, CecEquipBusinessPolicyCache> | undefined,
): Record<string, CecEquipBusinessPolicyCache> {
  if (!incoming) return { ...cur }
  const out: Record<string, CecEquipBusinessPolicyCache> = { ...cur }
  for (const [k, v] of Object.entries(incoming)) {
    const ex = out[k]
    if (!ex || (v.fetchedAt ?? 0) >= (ex.fetchedAt ?? 0)) out[k] = v
  }
  return out
}

/** 按 key 合并站点接口状态缓存，保留 fetchedAt 更新的版本 */
export function mergeStationStatusByKey(
  cur: Record<string, CecStationStatusCache>,
  incoming: Record<string, CecStationStatusCache> | undefined,
): Record<string, CecStationStatusCache> {
  if (!incoming) return { ...cur }
  const out: Record<string, CecStationStatusCache> = { ...cur }
  for (const [k, v] of Object.entries(incoming)) {
    const ex = out[k]
    if (!ex || (v.fetchedAt ?? 0) >= (ex.fetchedAt ?? 0)) out[k] = v
  }
  return out
}
