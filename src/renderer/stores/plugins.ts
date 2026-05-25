import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { InstalledPluginRecord, ProtocolSimulatorPlugin } from '@shared/plugin-contract'
import { loadPluginModule } from '@renderer/services/plugin-loader'

const BUILTIN_CEC_RECORD: InstalledPluginRecord = {
  id: 'cec-inner-link',
  name: '充电互联互通（内互联）模拟',
  version: '1.0.0',
  rootPath: '',
  entryRelative: '',
}

const BUILTIN_JX_RECORD: InstalledPluginRecord = {
  id: 'jx-pile-simulator',
  name: '玖行电桩模拟',
  version: '1.0.0',
  rootPath: '',
  entryRelative: '',
}

const BUILTIN_QR_RECORD: InstalledPluginRecord = {
  id: 'qr-batch-export',
  name: '二维码批量生成导出',
  version: '1.0.0',
  rootPath: '',
  entryRelative: '',
}

export interface LoadedPlugin {
  record: InstalledPluginRecord
  plugin: ProtocolSimulatorPlugin | null
  error: string | null
}

export const usePluginStore = defineStore('plugins', () => {
  const items = ref<LoadedPlugin[]>([])
  const loading = ref(false)
  /** 整表加载失败（如未在 Electron 中运行、IPC 异常） */
  const loadError = ref<string | null>(null)

  const byId = computed(() => {
    const m = new Map<string, LoadedPlugin>()
    for (const it of items.value) m.set(it.record.id, it)
    return m
  })

  async function loadAll() {
    loading.value = true
    loadError.value = null
    try {
      const unions = (window as Window & { unions?: typeof window.unions }).unions
      if (typeof unions?.listPlugins !== 'function') {
        loadError.value =
          '未检测到 Electron 预加载 API（window.unions）。请使用「npm run dev」启动后出现的桌面窗口使用本应用，不要单独用浏览器打开 localhost（浏览器中无法加载插件列表）。'
        items.value = []
        return
      }
      const records = await unions.listPlugins()
      const safeRecords = [...records]
      if (!safeRecords.some((r) => r.id === BUILTIN_CEC_RECORD.id)) safeRecords.push(BUILTIN_CEC_RECORD)
      if (!safeRecords.some((r) => r.id === BUILTIN_JX_RECORD.id)) safeRecords.push(BUILTIN_JX_RECORD)
      if (!safeRecords.some((r) => r.id === BUILTIN_QR_RECORD.id)) safeRecords.push(BUILTIN_QR_RECORD)
      const next: LoadedPlugin[] = []
      for (const record of safeRecords) {
        try {
          const plugin = await loadPluginModule(record)
          next.push({ record, plugin, error: null })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          next.push({ record, plugin: null, error: msg })
        }
      }
      items.value = next
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      loadError.value = `插件列表加载失败：${msg}`
      items.value = []
    } finally {
      loading.value = false
    }
  }

  async function refreshFromMain() {
    await loadAll()
  }

  async function remove(id: string) {
    await window.unions.removePlugin(id)
    await loadAll()
  }

  return { items, loading, loadError, byId, loadAll, refreshFromMain, remove }
})
