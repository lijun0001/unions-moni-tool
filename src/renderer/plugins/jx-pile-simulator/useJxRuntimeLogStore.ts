import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { JxRuntimeLog } from './types'

export const useJxRuntimeLogStore = defineStore('jx-runtime-log', () => {
  const logsByPile = ref<Record<string, JxRuntimeLog[]>>({})
  const maxVisibleLogs = ref(5000)
  const followTail = ref(true)
  const mode = ref<'raw' | 'structured'>('raw')
  const directionFilter = ref<'all' | 'send' | 'receive'>('all')
  const keyword = ref('')

  function appendLog(pileId: string, entry: Omit<JxRuntimeLog, 'id'>) {
    const list = logsByPile.value[pileId] ?? []
    list.push({ ...entry, id: `${entry.t}-${Math.random().toString(16).slice(2, 8)}` })
    const overflow = list.length - maxVisibleLogs.value
    if (overflow > 0) list.splice(0, overflow)
    logsByPile.value[pileId] = list
  }

  function clearPileLogs(pileId: string) {
    logsByPile.value[pileId] = []
  }

  const getLogsByPile = computed(
    () => (pileId: string) =>
      (logsByPile.value[pileId] ?? [])
        .filter((x) => {
          if (directionFilter.value !== 'all' && x.direction !== directionFilter.value) return false
          const q = keyword.value.trim().toLowerCase()
          if (!q) return true
          return (
            x.command.toLowerCase().includes(q) ||
            x.remoteIp.toLowerCase().includes(q) ||
            x.rawHex.toLowerCase().includes(q)
          )
        })
        .sort((a, b) => b.t - a.t),
  )

  return {
    logsByPile,
    maxVisibleLogs,
    followTail,
    mode,
    directionFilter,
    keyword,
    appendLog,
    clearPileLogs,
    getLogsByPile,
  }
})

