import { ref } from 'vue'
import { defineStore } from 'pinia'

/** 菜单「已打开插件」缓存：切换路由不销毁，仅菜单关闭或退出应用时清理 */
export const usePluginWindowStore = defineStore('pluginWindow', () => {
  const openedIds = ref<string[]>([])

  function markOpened(id: string) {
    const trimmed = id.trim()
    if (!trimmed) return
    openedIds.value = [trimmed, ...openedIds.value.filter((x) => x !== trimmed)]
  }

  function isOpen(id: string) {
    return openedIds.value.includes(id)
  }

  function close(id: string) {
    openedIds.value = openedIds.value.filter((x) => x !== id)
  }

  return { openedIds, markOpened, isOpen, close }
})
