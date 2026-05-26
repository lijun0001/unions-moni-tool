<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import ShellMenu from '@renderer/components/ShellMenu.vue'
import PluginView from '@renderer/views/PluginView.vue'
import { useLicenseGlobalGuard } from '@renderer/composables/useLicenseGuard'
import { useThemeStore } from '@renderer/stores/theme'
import { usePluginStore } from '@renderer/stores/plugins'
import { useLicenseStore } from '@renderer/stores/license'
import { usePluginWindowStore } from '@renderer/stores/pluginWindow'

const theme = useThemeStore()
const plugins = usePluginStore()
const license = useLicenseStore()
const pluginWindow = usePluginWindowStore()
const route = useRoute()

useLicenseGlobalGuard()

const showStandardRoute = computed(() => route.name !== 'plugin')

onMounted(async () => {
  await theme.hydrateFromMain()
  await license.hydrate()
  await plugins.loadAll()
})
</script>

<template>
  <ElConfigProvider :locale="zhCn">
    <div class="um-app min-h-screen bg-[var(--um-bg)] text-[var(--um-text)] transition-colors duration-200">
      <ShellMenu />
      <main class="relative min-h-screen pl-0 pt-0">
        <RouterView v-if="showStandardRoute" v-slot="{ Component }">
          <Transition name="um-fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
        <KeepAlive>
          <PluginView
            v-for="id in pluginWindow.openedIds"
            v-show="route.name === 'plugin' && String(route.params.pluginId) === id"
            :key="id"
            :plugin-id="id"
            class="plugin-cache-pane"
          />
        </KeepAlive>
      </main>
    </div>
  </ElConfigProvider>
</template>

<style scoped>
.um-fade-enter-active,
.um-fade-leave-active {
  transition: opacity 0.18s ease-out;
}
.um-fade-enter-from,
.um-fade-leave-to {
  opacity: 0;
}
.plugin-cache-pane {
  min-height: 100vh;
}
</style>
