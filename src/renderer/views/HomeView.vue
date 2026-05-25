<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePluginStore } from '@renderer/stores/plugins'

const router = useRouter()
const plugins = usePluginStore()

const cards = computed(() => plugins.items)

function goPlugin(id: string) {
  router.push(`/plugin/${id}`)
}

function staggerDelay(i: number) {
  return { transitionDelay: `${40 + i * 48}ms` }
}
</script>

<template>
  <div class="px-[var(--space-xl)] pb-[var(--space-2xl)] pt-[calc(var(--space-2xl)+3rem)]">
    <header class="mb-[var(--space-2xl)] max-w-[75ch]">
      <h1 class="um-display text-3xl font-semibold tracking-tight text-[var(--um-text)] md:text-4xl">
        协议模拟工作台
      </h1>
      <p class="mt-[var(--space-md)] text-sm leading-relaxed text-[var(--um-text-muted)]">
        通过插件扩展 HTTP / TCP 等模拟能力；从左上方菜单导入功能包或进入配置。
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
            <h2 class="um-display text-lg font-semibold text-[var(--um-text)]">
              {{ c.plugin?.homeCard.title ?? c.record.name }}
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

        <div class="mt-6 flex items-center gap-2">
          <button
            type="button"
            class="rounded-lg bg-[var(--um-brand)] px-4 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!c.plugin"
            @click="goPlugin(c.record.id)"
          >
            进入模拟器
          </button>
          <button
            type="button"
            class="rounded-lg border border-[var(--um-border)] px-3 py-2 text-sm text-[var(--um-text-muted)] hover:border-[var(--um-brand-muted)] hover:text-[var(--um-text)]"
            @click="router.push('/settings/import')"
          >
            导入更多
          </button>
        </div>
      </article>

      <article
        v-if="!plugins.loading && cards.length === 0 && !plugins.loadError"
        class="rounded-[var(--um-radius)] border border-dashed border-[var(--um-border)] bg-[var(--um-surface)]/60 p-[var(--space-xl)] text-[var(--um-text-muted)]"
      >
        <p class="text-sm">尚未安装插件。打开左上角菜单 → 工具配置 → 导入功能。</p>
      </article>
    </div>
  </div>
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
