<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import { ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import ShellMenu from '@renderer/components/ShellMenu.vue'
import { useLicenseGlobalGuard } from '@renderer/composables/useLicenseGuard'
import { useThemeStore } from '@renderer/stores/theme'
import { usePluginStore } from '@renderer/stores/plugins'
import { useLicenseStore } from '@renderer/stores/license'

const theme = useThemeStore()
const plugins = usePluginStore()
const license = useLicenseStore()

useLicenseGlobalGuard()

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
        <RouterView v-slot="{ Component }">
          <Transition name="um-fade" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
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
</style>
