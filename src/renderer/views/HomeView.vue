<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Plus } from '@element-plus/icons-vue'
import { usePluginStore } from '@renderer/stores/plugins'
import { usePluginWindowStore } from '@renderer/stores/pluginWindow'
import { usePluginImport } from '@renderer/composables/usePluginImport'
import { useProductIntro } from '@renderer/composables/useProductIntro'
import WorkspaceFrame from '@renderer/components/WorkspaceFrame.vue'
import IntroHelpIcon from '@renderer/components/IntroHelpIcon.vue'
import type { LoadedPlugin } from '@renderer/stores/plugins'

const router = useRouter()
const plugins = usePluginStore()
const pluginWindow = usePluginWindowStore()
const { busy: importBusy, pickAndInstall } = usePluginImport()
const { hasProductIntro, openProductIntro } = useProductIntro()

const cards = computed(() => plugins.items)

const importPickerOpen = ref(false)

function goPlugin(id: string) {
  pluginWindow.markOpened(id)
  router.push(`/plugin/${id}`)
}

function openIntro(c: LoadedPlugin, event: Event) {
  event.stopPropagation()
  openProductIntro(c.plugin?.homeCard.title ?? c.record.name, c.plugin?.introMarkdown)
}

async function onPickImport(kind: 'zip' | 'dir') {
  importPickerOpen.value = false
  await pickAndInstall(kind)
}

function staggerDelay(i: number) {
  return { transitionDelay: `${40 + i * 48}ms` }
}
</script>

<template>
  <WorkspaceFrame>
    <header class="mb-[var(--space-2xl)] max-w-[75ch]">
      <h1 class="um-display text-3xl font-semibold tracking-tight text-[var(--um-text)] md:text-4xl">
        协议模拟工作台
      </h1>
      <p class="mt-[var(--space-md)] text-sm leading-relaxed text-[var(--um-text-muted)]">
        通过插件扩展 HTTP / TCP 等模拟能力；从左上方菜单进入配置，或点击末尾卡片导入功能包。
      </p>
      <div
        v-if="plugins.loadError"
        class="mt-[var(--space-lg)] rounded-[var(--um-radius)] border border-[var(--el-color-danger)] bg-[var(--um-surface-2)] p-4 text-sm text-[var(--el-color-danger)]"
        role="alert"
      >
        {{ plugins.loadError }}
      </div>
    </header>

    <div
      class="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-[var(--space-lg)]"
      role="list"
    >
      <article
        v-for="(c, i) in cards"
        :key="c.record.id"
        role="listitem"
        class="um-card-enter group rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-[var(--space-lg)] shadow-sm will-change-transform"
        :style="staggerDelay(i)"
      >
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="um-display flex items-center gap-1.5 text-lg font-semibold text-[var(--um-text)]">
              <span>{{ c.plugin?.homeCard.title ?? c.record.name }}</span>
              <button
                v-if="hasProductIntro(c.plugin?.introMarkdown)"
                type="button"
                class="inline-flex shrink-0 items-center justify-center rounded-md p-0.5 text-[var(--um-text-muted)] transition hover:bg-[var(--um-surface-2)] hover:text-[var(--um-brand)]"
                title="产品介绍"
                aria-label="查看产品介绍"
                @click="openIntro(c, $event)"
              >
                <IntroHelpIcon />
              </button>
            </h2>
            <p class="mt-1 text-sm text-[var(--um-text-muted)]">
              {{ c.plugin?.homeCard.subtitle ?? c.record.id }} · v{{ c.record.version }}
            </p>
          </div>
          <span
            v-if="c.plugin?.homeCard.badge"
            class="rounded-full border border-[var(--um-border)] bg-[var(--um-bg)] px-2 py-0.5 text-xs text-[var(--um-text-muted)]"
          >
            {{ c.plugin.homeCard.badge }}
          </span>
        </div>

        <p v-if="c.error" class="mt-3 text-sm text-[var(--el-color-danger)]">
          {{ c.error }}
        </p>

        <div class="mt-6">
          <button
            type="button"
            class="rounded-lg bg-[var(--um-brand)] px-4 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!c.plugin"
            @click="goPlugin(c.record.id)"
          >
            进入模拟器
          </button>
        </div>
      </article>

      <!-- 末尾空卡片：点击导入功能包 -->
      <article
        v-if="!plugins.loading && !plugins.loadError"
        role="listitem"
        class="um-card-enter group flex min-h-[168px] flex-col items-center justify-center rounded-[var(--um-radius)] border border-dashed border-[var(--um-border)] bg-[var(--um-surface)]/60 p-[var(--space-lg)] text-[var(--um-text-muted)] transition hover:border-[var(--um-brand-muted)] hover:bg-[var(--um-surface)] hover:text-[var(--um-text)]"
        :style="staggerDelay(cards.length)"
      >
        <el-popover
          v-model:visible="importPickerOpen"
          placement="bottom"
          :width="220"
          trigger="click"
          popper-class="um-import-picker-popover"
        >
          <template #reference>
            <button
              type="button"
              class="flex flex-col items-center gap-2 outline-none disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="importBusy"
            >
              <span
                class="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--um-border)] bg-[var(--um-bg)] text-[var(--um-text-muted)] transition group-hover:border-[var(--um-brand-muted)] group-hover:text-[var(--um-brand)]"
              >
                <Plus class="h-5 w-5" />
              </span>
              <span class="text-sm font-medium">导入功能包</span>
              <span class="text-xs text-[var(--um-text-muted)]">.zip 或文件夹</span>
            </button>
          </template>
          <div class="flex flex-col gap-2">
            <button
              type="button"
              class="rounded-lg bg-[var(--um-brand)] px-3 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
              :disabled="importBusy"
              @click="onPickImport('zip')"
            >
              选择 .zip 包
            </button>
            <button
              type="button"
              class="rounded-lg border border-[var(--um-border)] px-3 py-2 text-sm text-[var(--um-text)] disabled:opacity-50"
              :disabled="importBusy"
              @click="onPickImport('dir')"
            >
              选择文件夹
            </button>
          </div>
        </el-popover>
      </article>
    </div>
  </WorkspaceFrame>
</template>

<style scoped>
.um-card-enter {
  animation: um-card-in 0.55s cubic-bezier(0.25, 1, 0.5, 1) both;
}

@keyframes um-card-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
