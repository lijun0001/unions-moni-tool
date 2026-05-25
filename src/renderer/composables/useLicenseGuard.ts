import { onMounted, onUnmounted } from 'vue'
import { useLicenseStore } from '@renderer/stores/license'

/** 正式版过期后拦截全局点击；体验版由主进程定时检测并退出 */
export function useLicenseGlobalGuard() {
  const license = useLicenseStore()

  async function onCaptureClick(e: MouseEvent) {
    const s = license.status
    if (!s || s.allowed) return
    if (s.edition === 'experience' && s.quitOnBlock) {
      e.preventDefault()
      e.stopImmediatePropagation()
      await license.guardAction()
      return
    }
    if (s.edition === 'official') {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-license-exempt]')) return
      e.preventDefault()
      e.stopImmediatePropagation()
      await license.guardAction()
    }
  }

  onMounted(() => {
    document.addEventListener('click', onCaptureClick, true)
  })

  onUnmounted(() => {
    document.removeEventListener('click', onCaptureClick, true)
  })
}
