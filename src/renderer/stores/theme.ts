import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

export type ResolvedTheme = 'light' | 'dark'

function getSystemDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<'light' | 'dark' | 'system'>('dark')
  const systemDark = ref(getSystemDark())

  const resolved = computed<ResolvedTheme>(() => {
    if (mode.value === 'system') return systemDark.value ? 'dark' : 'light'
    return mode.value
  })

  function applyDom() {
    const root = document.documentElement
    const r = resolved.value
    root.classList.toggle('dark', r === 'dark')
    root.dataset.theme = r
  }

  watch(resolved, () => applyDom(), { immediate: true })

  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => {
      systemDark.value = mq.matches
    })
  }

  async function hydrateFromMain() {
    const unions = (window as Window & { unions?: typeof window.unions }).unions
    if (typeof unions?.getSettings !== 'function') {
      applyDom()
      return
    }
    const s = await unions.getSettings()
    mode.value = s.themeMode ?? 'dark'
    applyDom()
  }

  async function setMode(m: 'light' | 'dark' | 'system') {
    mode.value = m
    const unions = (window as Window & { unions?: typeof window.unions }).unions
    if (typeof unions?.setSettings === 'function') {
      await unions.setSettings({ themeMode: m })
    }
    applyDom()
  }

  return { mode, resolved, hydrateFromMain, setMode }
})
