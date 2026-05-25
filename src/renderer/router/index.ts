import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '@renderer/views/HomeView.vue'
import PluginView from '@renderer/views/PluginView.vue'
import ImportView from '@renderer/views/ImportView.vue'
import AboutView from '@renderer/views/AboutView.vue'
import LicenseView from '@renderer/views/LicenseView.vue'
import { useLicenseStore } from '@renderer/stores/license'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeView },
    {
      path: '/plugin/:pluginId',
      name: 'plugin',
      component: PluginView,
    },
    {
      path: '/settings/import',
      name: 'settings-import',
      component: ImportView,
    },
    {
      path: '/help/about',
      name: 'help-about',
      component: AboutView,
    },
    {
      path: '/help/license',
      name: 'help-license',
      component: LicenseView,
    },
  ],
})

router.beforeEach(async (to) => {
  const license = useLicenseStore()
  if (!license.hydrated) await license.hydrate()
  const s = license.status
  if (!s?.allowed) {
    if (s?.edition === 'experience') {
      await license.guardAction()
      return false
    }
    if (s?.edition === 'official' && to.name !== 'help-license') {
      await license.guardAction()
      return { name: 'help-license' }
    }
  }
  return true
})
