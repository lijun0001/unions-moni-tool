import type { CecPolicyInfo } from './cec-types'

/** 文档拼写 SevicePrice，兼容 ServicePrice */
export function policySevicePrice(p: CecPolicyInfo): number {
  const v = p.SevicePrice ?? p.ServicePrice
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * 按当前时刻匹配时段：StartTime 为 "HHmmss"，取最后一个 StartTime ≤ 当前时刻的时段；
 * 若均大于当前时刻（跨日前的尾段），取列表中最后一条。
 */
export function resolveCurrentPolicyPeriod(
  policyInfos: CecPolicyInfo[] | undefined,
  now: Date,
): CecPolicyInfo | null {
  if (!policyInfos?.length) return null
  const pad = (n: number) => n.toString().padStart(2, '0')
  const cur =
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  const sorted = [...policyInfos].sort((a, b) =>
    String(a.StartTime).localeCompare(String(b.StartTime)),
  )
  let best: CecPolicyInfo | null = null
  for (const p of sorted) {
    const st = String(p.StartTime ?? '').padStart(6, '0').slice(0, 6)
    if (st <= cur) best = p
  }
  return best ?? sorted[sorted.length - 1] ?? null
}
