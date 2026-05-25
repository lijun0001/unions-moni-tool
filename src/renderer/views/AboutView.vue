<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="px-[var(--space-xl)] pb-[var(--space-2xl)] pt-[calc(var(--space-2xl)+3rem)]">
    <h1 class="um-display text-2xl font-semibold text-[var(--um-text)]">关于我们</h1>
    <div class="mt-6 max-w-[75ch] space-y-4 text-sm leading-relaxed text-[var(--um-text-muted)]">
      <p>
        <strong class="text-[var(--um-text)]">Unions Moni Tool</strong>
        是一款面向工程与测试场景的 HTTP / TCP 协议模拟桌面工具，支持插件式扩展能力。
      </p>
      <p>技术栈：Electron、Vue 3、TypeScript、Tailwind CSS、Element Plus。</p>
    </div>
    <button
      type="button"
      class="mt-8 rounded-lg border border-[var(--um-border)] px-4 py-2 text-sm text-[var(--um-text-muted)] hover:text-[var(--um-text)]"
      @click="router.push('/')"
    >
      返回首页
    </button>
  </div>
</template>
