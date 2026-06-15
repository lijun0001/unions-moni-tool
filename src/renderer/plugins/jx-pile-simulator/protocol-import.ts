import type {
  JxFlowSupportResult,
  JxImportErr,
  JxImportOk,
  JxImportResult,
  JxProtocolDefinition,
} from './types'

type ConflictMode = 'reject' | 'overwrite' | 'fork'

const BASELINE_DIRECTIONS: Record<string, 'up' | 'down'> = {
  '0x01': 'up',
  '0x02': 'down',
  '0x03': 'up',
  '0x04': 'down',
  '0x05': 'up',
  '0x06': 'down',
  '0x07': 'up',
  '0x0b': 'down',
  '0x0c': 'up',
  '0x1f': 'down',
  '0x20': 'up',
  '0x21': 'up',
  '0x22': 'down',
  '0x25': 'up',
  '0x30': 'up',
  '0x26': 'down',
  '0x27': 'up',
  '0x19': 'up',
  '0x1a': 'down',
  '0x40': 'up',
  '0x41': 'down',
  '0x46': 'up',
  '0x47': 'down',
  '0x59': 'down',
  '0x5b': 'up',
}

function toError(
  errorCode: JxImportErr['errorCode'],
  message: string,
  details?: Record<string, unknown>,
): JxImportErr {
  return { ok: false, errorCode, message, details }
}

function normalizeCmd(cmd: string): string {
  return cmd.trim().toLowerCase()
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function validateProtocolShape(raw: unknown): JxImportResult | JxProtocolDefinition {
  if (!isObj(raw)) return toError('PROTO_IMPORT_JSON_INVALID', '协议 JSON 根节点必须是对象')
  const schemaVersion = String(raw.schemaVersion ?? '')
  if (!/^1\./.test(schemaVersion)) {
    return toError('PROTO_IMPORT_SCHEMA_UNSUPPORTED', 'schemaVersion 仅支持 1.x', { schemaVersion })
  }
  const protocolId = String(raw.protocolId ?? '')
  if (!/^[a-z0-9][a-z0-9-_]{2,63}$/.test(protocolId)) {
    return toError('PROTO_IMPORT_JSON_INVALID', 'protocolId 不符合规范')
  }
  const protocolName = String(raw.protocolName ?? '').trim()
  if (protocolName.length < 2 || protocolName.length > 64) {
    return toError('PROTO_IMPORT_JSON_INVALID', 'protocolName 长度需在 2~64')
  }
  const version = String(raw.version ?? '').trim()
  if (!version) return toError('PROTO_IMPORT_JSON_INVALID', 'version 不能为空')
  const source = raw.source === 'builtin' ? 'builtin' : raw.source === 'imported' ? 'imported' : null
  if (!source) return toError('PROTO_IMPORT_JSON_INVALID', 'source 必须是 builtin/imported')
  if (!isObj(raw.commandCatalog) || Object.keys(raw.commandCatalog).length === 0) {
    return toError('PROTO_IMPORT_JSON_INVALID', 'commandCatalog 至少包含 1 条命令')
  }
  if (!Array.isArray(raw.flowTemplates) || raw.flowTemplates.length === 0) {
    return toError('PROTO_IMPORT_JSON_INVALID', 'flowTemplates 至少包含 1 条流程')
  }
  return {
    schemaVersion,
    protocolId,
    protocolName,
    version,
    source,
    vendor: typeof raw.vendor === 'string' ? raw.vendor : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    commandCatalog: raw.commandCatalog as JxProtocolDefinition['commandCatalog'],
    flowTemplates: raw.flowTemplates as JxProtocolDefinition['flowTemplates'],
    meta: isObj(raw.meta) ? (raw.meta as JxProtocolDefinition['meta']) : undefined,
  }
}

function computeCompatibility(protocol: JxProtocolDefinition): {
  report: JxFlowSupportResult[]
  warnings: string[]
} {
  const warnings: string[] = []
  const report = protocol.flowTemplates.map((flow) => {
    const missingCommands = (flow.requiresCommands ?? [])
      .map((c) => normalizeCmd(c))
      .filter((c) => !protocol.commandCatalog[c])
    const invalidDirections = (flow.requiresCommands ?? [])
      .map((c) => normalizeCmd(c))
      .filter((c) => {
        const base = BASELINE_DIRECTIONS[c]
        const got = protocol.commandCatalog[c]?.direction
        return !!base && !!got && base !== got
      })

    const missingParams = (flow.requiresParams ?? []).filter((param) => {
      const hasAny = (flow.requiresCommands ?? []).some((cmd) => {
        const def = protocol.commandCatalog[normalizeCmd(cmd)]
        return (
          !!def &&
          (def.requiredParams.includes(param) || (def.optionalParams ?? []).includes(param))
        )
      })
      return !hasAny
    })

    let support: JxFlowSupportResult['support'] = 'supported'
    if (missingCommands.length > 0 || invalidDirections.length > 0) support = 'unsupported'
    else if (missingParams.length > 0) support = 'partial'

    return {
      flowId: flow.flowId,
      support,
      missingCommands,
      missingParams,
      invalidDirections,
    }
  })

  const cmd25 = protocol.commandCatalog['0x25']
  if (cmd25 && !cmd25.requiredParams.includes('chargeAmount')) {
    warnings.push('命令 0x25 缺少 chargeAmount，计费看板将降级')
  }

  return { report, warnings }
}

function validateCatalogAndFlow(protocol: JxProtocolDefinition): JxImportResult | null {
  const flowIdSet = new Set<string>()
  for (const [key, def] of Object.entries(protocol.commandCatalog)) {
    if (!isObj(def)) {
      return toError('PROTO_IMPORT_JSON_INVALID', 'commandCatalog 命令定义必须是对象', { key })
    }
    const cmd = normalizeCmd(String(def.cmd ?? ''))
    const k = normalizeCmd(key)
    if (cmd !== k) {
      return toError('PROTO_IMPORT_CMD_KEY_MISMATCH', '命令 key 与 cmd 不一致', { key, cmd })
    }
    if (def.direction !== 'up' && def.direction !== 'down') {
      return toError('PROTO_IMPORT_CMD_DIRECTION_INVALID', '命令方向非法', { cmd, direction: def.direction })
    }
    const req = Array.isArray(def.requiredParams) ? def.requiredParams : []
    if (req.some((p) => typeof p !== 'string' || !p.trim())) {
      return toError('PROTO_IMPORT_JSON_INVALID', 'requiredParams 含非法参数', { cmd })
    }
    const reqSet = new Set(req)
    if (reqSet.size !== req.length) {
      return toError('PROTO_IMPORT_JSON_INVALID', 'requiredParams 不能重复', { cmd })
    }
    const opt = Array.isArray(def.optionalParams) ? def.optionalParams : []
    if (opt.some((p) => reqSet.has(p))) {
      return toError('PROTO_IMPORT_JSON_INVALID', 'optionalParams 不能与 requiredParams 重复', { cmd })
    }
  }

  for (const flow of protocol.flowTemplates) {
    if (!flow.flowId || flowIdSet.has(flow.flowId)) {
      return toError('PROTO_IMPORT_JSON_INVALID', 'flowId 不能为空且需唯一', { flowId: flow.flowId })
    }
    flowIdSet.add(flow.flowId)
    if (!Array.isArray(flow.steps) || flow.steps.length === 0) {
      return toError('PROTO_IMPORT_STEP_INVALID', 'steps 不能为空', { flowId: flow.flowId })
    }
    const stepIdSet = new Set<string>()
    for (const step of flow.steps) {
      if (!step.id || stepIdSet.has(step.id)) {
        return toError('PROTO_IMPORT_STEP_INVALID', 'step id 不能为空且需唯一', {
          flowId: flow.flowId,
          stepId: step.id,
        })
      }
      stepIdSet.add(step.id)
      if (
        !['send', 'expect', 'branch', 'retry', 'delay', 'emitState'].includes(
          String(step.type),
        )
      ) {
        return toError('PROTO_IMPORT_STEP_INVALID', '不支持的 step 类型', {
          flowId: flow.flowId,
          stepId: step.id,
        })
      }
      if ((step.type === 'send' || step.type === 'expect') && !step.cmd) {
        return toError('PROTO_IMPORT_STEP_INVALID', `${step.type} 步骤缺少 cmd`, {
          flowId: flow.flowId,
          stepId: step.id,
        })
      }
      if (step.type === 'expect' && (typeof step.timeoutMs !== 'number' || step.timeoutMs < 100)) {
        return toError('PROTO_IMPORT_STEP_INVALID', 'expect 步骤缺少合法 timeoutMs', {
          flowId: flow.flowId,
          stepId: step.id,
        })
      }
      if (step.type === 'branch' && (!step.by || !step.cases || Object.keys(step.cases).length === 0)) {
        return toError('PROTO_IMPORT_STEP_INVALID', 'branch 步骤缺少 by/cases', {
          flowId: flow.flowId,
          stepId: step.id,
        })
      }
    }
  }

  return null
}

function buildSummary(report: JxFlowSupportResult[]): JxImportOk['summary'] {
  return {
    commandsTotal: 0,
    flowsTotal: report.length,
    supportedFlows: report.filter((x) => x.support === 'supported').length,
    partialFlows: report.filter((x) => x.support === 'partial').length,
    unsupportedFlows: report.filter((x) => x.support === 'unsupported').length,
  }
}

export function importProtocolJson(input: {
  jsonText: string
  existing: JxProtocolDefinition[]
  onConflict: ConflictMode
  dryRun?: boolean
}): JxImportResult {
  try {
    const parsed = JSON.parse(input.jsonText) as unknown
    const shaped = validateProtocolShape(parsed)
    if ('ok' in shaped && !shaped.ok) return shaped
    const protocol = shaped as JxProtocolDefinition
    const flowErr = validateCatalogAndFlow(protocol)
    if (flowErr) return flowErr

    const conflict = input.existing.find((p) => p.protocolId === protocol.protocolId)
    let finalProtocol = protocol
    let mode: JxImportOk['importMode'] = input.dryRun ? 'dryRun' : 'create'
    let forkedProtocolId: string | undefined
    if (conflict) {
      if (input.onConflict === 'reject') {
        return toError('PROTO_IMPORT_PROTOCOL_ID_CONFLICT', 'protocolId 冲突', {
          protocolId: protocol.protocolId,
        })
      }
      if (input.onConflict === 'fork') {
        let seq = 1
        let next = `${protocol.protocolId}-copy${seq}`
        while (input.existing.some((p) => p.protocolId === next)) {
          seq += 1
          next = `${protocol.protocolId}-copy${seq}`
        }
        finalProtocol = { ...protocol, protocolId: next, protocolName: `${protocol.protocolName}-副本` }
        forkedProtocolId = next
        mode = input.dryRun ? 'dryRun' : 'fork'
      } else {
        mode = input.dryRun ? 'dryRun' : 'overwrite'
      }
    }

    const { report, warnings } = computeCompatibility(finalProtocol)
    const summary = buildSummary(report)
    summary.commandsTotal = Object.keys(finalProtocol.commandCatalog).length

    return {
      ok: true,
      protocolId: finalProtocol.protocolId,
      version: finalProtocol.version,
      importMode: mode,
      summary,
      compatibilityReport: report,
      warnings,
      protocol: finalProtocol,
      forkedProtocolId,
    }
  } catch (error) {
    return toError('PROTO_IMPORT_JSON_INVALID', 'JSON 解析失败', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

