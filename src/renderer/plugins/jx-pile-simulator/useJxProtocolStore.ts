import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { JX_V224_BUILTIN, JX_V225_BUILTIN } from './builtins'
import { importProtocolJson } from './protocol-import'
import {
  isJxProtocolSelectable,
  JX_PROTOCOL_V224_ID,
  normalizeSelectableProtocolId,
} from './jx-protocol-policy'
import type { JxImportResult, JxProtocolDefinition } from './types'

export const useJxProtocolStore = defineStore('jx-protocol', () => {
  const protocols = ref<JxProtocolDefinition[]>([JX_V224_BUILTIN, JX_V225_BUILTIN])
  const activeProtocolId = ref(JX_PROTOCOL_V224_ID)
  const lastImportResult = ref<JxImportResult | null>(null)

  const selectableProtocols = computed(() =>
    protocols.value.filter((p) => isJxProtocolSelectable(p.protocolId)),
  )

  const activeProtocol = computed(() => {
    const hit = protocols.value.find((x) => x.protocolId === activeProtocolId.value)
    if (hit && isJxProtocolSelectable(hit.protocolId)) return hit
    return selectableProtocols.value[0] ?? JX_V224_BUILTIN
  })

  function setActiveProtocol(id: string) {
    const next = normalizeSelectableProtocolId(id)
    if (protocols.value.some((x) => x.protocolId === next)) activeProtocolId.value = next
  }

  function importFromJsonText(payload: {
    jsonText: string
    onConflict: 'reject' | 'overwrite' | 'fork'
    dryRun?: boolean
  }): JxImportResult {
    const res = importProtocolJson({
      jsonText: payload.jsonText,
      existing: protocols.value,
      onConflict: payload.onConflict,
      dryRun: payload.dryRun,
    })
    lastImportResult.value = res
    if (!res.ok || payload.dryRun || !res.protocol) return res

    const next = protocols.value.filter((p) => p.protocolId !== res.protocolId)
    next.push(res.protocol)
    protocols.value = next
    activeProtocolId.value = normalizeSelectableProtocolId(res.protocolId)
    return res
  }

  function exportActiveProtocol(): string {
    const cur = activeProtocol.value
    return JSON.stringify(cur, null, 2)
  }

  function findProtocol(protocolId: string) {
    return protocols.value.find((p) => p.protocolId === protocolId) ?? null
  }

  function getFlowTemplate(protocolId: string, flowId: string) {
    return findProtocol(protocolId)?.flowTemplates.find((f) => f.flowId === flowId) ?? null
  }

  return {
    protocols,
    selectableProtocols,
    activeProtocolId,
    activeProtocol,
    lastImportResult,
    setActiveProtocol,
    importFromJsonText,
    exportActiveProtocol,
    findProtocol,
    getFlowTemplate,
    isJxProtocolSelectable,
  }
})

