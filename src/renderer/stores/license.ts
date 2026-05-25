import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { LicenseActivateResult, LicenseStatus } from '@shared/license-types'
import { getAppRouter } from '@renderer/navigation'

export const useLicenseStore = defineStore('license', () => {
  const status = ref<LicenseStatus | null>(null)
  const hydrated = ref(false)
  let blocking = false

  async function hydrate() {
    if (typeof window.unions?.getLicenseStatus !== 'function') {
      hydrated.value = true
      return
    }
    status.value = await window.unions.getLicenseStatus()
    hydrated.value = true
  }

  async function refresh() {
    if (typeof window.unions?.getLicenseStatus !== 'function') return
    status.value = await window.unions.getLicenseStatus()
  }

  async function activate(key: string): Promise<LicenseActivateResult> {
    if (!window.unions?.activateLicense) {
      return { ok: false, error: '未检测到许可接口' }
    }
    const res = await window.unions.activateLicense(key)
    if (res.ok && res.status) status.value = res.status
    else await refresh()
    return res
  }

  /** 拦截未授权操作；返回 false 表示已阻断 */
  async function guardAction(): Promise<boolean> {
    if (!hydrated.value) await hydrate()
    const s = status.value
    if (!s || s.allowed) return true
    if (blocking) return false
    blocking = true
    try {
      if (window.unions?.assertLicenseAllowed) {
        const res = await window.unions.assertLicenseAllowed()
        if (res.ok) {
          await refresh()
          return true
        }
        if (res.status) status.value = res.status
        return false
      }
      const title = s.edition === 'experience' ? '体验版已过期' : '请重新激活'
      await ElMessageBox.alert(s.message, title, {
        type: 'warning',
        confirmButtonText: s.quitOnBlock ? '退出' : '确定',
        showClose: false,
      })
      if (!s.quitOnBlock) {
        const router = getAppRouter()
        if (router && router.currentRoute.value.name !== 'help-license') {
          await router.push('/help/license')
        }
      }
      return false
    } finally {
      blocking = false
    }
  }

  function formatExpires(ms: number | null | undefined): string {
    if (!ms) return '—'
    const d = new Date(ms)
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  return {
    status,
    hydrated,
    hydrate,
    refresh,
    activate,
    guardAction,
    formatExpires,
  }
})
