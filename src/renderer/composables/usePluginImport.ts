import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { usePluginStore } from '@renderer/stores/plugins'

export function usePluginImport() {
  const plugins = usePluginStore()
  const busy = ref(false)

  async function pickAndInstall(kind: 'zip' | 'dir') {
    if (busy.value) return null
    busy.value = true
    try {
      const p = await window.unions.openPluginSourceDialog(kind)
      if (!p) return null
      const res = await window.unions.installPluginFromPath(p)
      if (res.ok) {
        await plugins.refreshFromMain()
        ElMessage.success(`已安装：${res.record.name}`)
        return res.record
      }
      ElMessage.error(res.error)
      return null
    } finally {
      busy.value = false
    }
  }

  return { busy, pickAndInstall }
}
