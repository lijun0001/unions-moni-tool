<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { useLicenseStore } from '@renderer/stores/license'
import WorkspaceFrame from '@renderer/components/WorkspaceFrame.vue'

const T = {
  title: '\u6ce8\u518c\u6fc0\u6d3b',
  pkgPrefix: '\u5f53\u524d\u5b89\u88c5\u5305\u4e3a',
  pkgDot: '\u3002',
  expEdition: '\u4f53\u9a8c\u7248',
  offEdition: '\u6b63\u5f0f\u7248',
  buildExpiresPrefix: '\u6709\u6548\u671f\u81f3',
  trialExpires: '\u4f53\u9a8c\u5230\u671f',
  actExpires: '\u6fc0\u6d3b\u5230\u671f',
  statusLabel: '\u5f53\u524d\u72b6\u6001',
  statusOk: '\u53ef\u7528',
  statusExpired: '\u5df2\u8fc7\u671f',
  keyLabel: '\u8bb8\u53ef\u8bc1\u5bc6\u94a5',
  keyHint:
    '\u683c\u5f0f\u793a\u4f8b\uff1aUNIONS-20261231-A1B2\uff08\u65e5\u671f\u4e3a\u5230\u671f\u65e5\uff0c\u6821\u9a8c\u6bb5\u7531\u7cfb\u7edf\u751f\u6210\uff09',
  actBtn: '\u6fc0\u6d3b',
  actBusy: '\u6fc0\u6d3b\u4e2d\u2026',
  noActEntry: '\u4f53\u9a8c\u7248\u4e0d\u63d0\u4f9b\u6fc0\u6d3b\u5165\u53e3\u3002',
  backHome: '\u8fd4\u56de\u9996\u9875',
  warnNoActivate: '\u5f53\u524d\u7248\u672c\u4e0d\u652f\u6301\u6fc0\u6d3b',
  warnNeedKey: '\u8bf7\u8f93\u5165\u8bb8\u53ef\u8bc1\u5bc6\u94a5',
  okActivate: '\u6fc0\u6d3b\u6210\u529f',
  failActivate: '\u6fc0\u6d3b\u5931\u8d25',
} as const

const router = useRouter()
const license = useLicenseStore()
const key = ref('')
const busy = ref(false)

const editionLabel = computed(() =>
  license.status?.edition === 'experience' ? T.expEdition : T.offEdition,
)

onMounted(() => license.hydrate())

async function submit() {
  if (!license.status?.canActivate) {
    ElMessage.warning(T.warnNoActivate)
    return
  }
  if (!key.value.trim()) {
    ElMessage.warning(T.warnNeedKey)
    return
  }
  busy.value = true
  try {
    const res = await license.activate(key.value)
    if (res.ok) {
      ElMessage.success(T.okActivate)
      key.value = ''
    } else {
      ElMessage.error(res.error ?? T.failActivate)
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <WorkspaceFrame data-license-exempt>
    <h1 class="um-display text-2xl font-semibold text-[var(--um-text)]">{{ T.title }}</h1>
    <p class="mt-2 max-w-[75ch] text-sm text-[var(--um-text-muted)]">
      {{ T.pkgPrefix }}<strong class="text-[var(--um-text)]">{{ editionLabel }}</strong>{{ T.pkgDot }}
    </p>

    <section
      v-if="license.status"
      class="mt-6 max-w-lg rounded-[var(--um-radius)] border border-[var(--um-border)] bg-[var(--um-surface)] p-4 text-sm"
    >
      <p class="text-[var(--um-text)]">{{ license.status.message }}</p>
      <dl class="mt-4 space-y-2 text-[var(--um-text-muted)]">
        <div
          v-if="license.status.edition === 'experience' && license.status.buildExpiresAt"
          class="flex justify-between gap-4"
        >
          <dt>{{ T.buildExpiresPrefix }}</dt>
          <dd class="text-[var(--um-text)]">{{ license.formatExpires(license.status.buildExpiresAt) }}</dd>
        </div>
        <div
          v-if="license.status.edition === 'official' && !license.status.activated"
          class="flex justify-between gap-4"
        >
          <dt>{{ T.trialExpires }}</dt>
          <dd class="text-[var(--um-text)]">{{ license.formatExpires(license.status.trialExpiresAt) }}</dd>
        </div>
        <div v-if="license.status.activated" class="flex justify-between gap-4">
          <dt>{{ T.actExpires }}</dt>
          <dd class="text-[var(--um-text)]">
            {{ license.formatExpires(license.status.activationExpiresAt) }}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt>{{ T.statusLabel }}</dt>
          <dd :class="license.status.allowed ? 'text-[var(--um-brand)]' : 'text-[var(--el-color-danger)]'">
            {{ license.status.allowed ? T.statusOk : T.statusExpired }}
          </dd>
        </div>
      </dl>
    </section>

    <div v-if="license.status?.canActivate" class="mt-8 max-w-md space-y-3">
      <label class="block text-xs font-medium text-[var(--um-text-muted)]">{{ T.keyLabel }}</label>
      <input
        v-model="key"
        type="text"
        class="w-full rounded-lg border border-[var(--um-border)] bg-[var(--um-surface)] px-3 py-2 text-sm text-[var(--um-text)] outline-none focus:border-[var(--um-brand)]"
        placeholder="UNIONS-YYYYMMDD-XXXX"
        autocomplete="off"
        data-license-exempt
      />
      <p class="text-xs text-[var(--um-text-muted)]">{{ T.keyHint }}</p>
      <button
        type="button"
        class="rounded-lg bg-[var(--um-brand)] px-4 py-2 text-sm font-semibold text-[oklch(0.15_0.02_250)] disabled:opacity-50"
        :disabled="busy"
        data-license-exempt
        @click="submit"
      >
        {{ busy ? T.actBusy : T.actBtn }}
      </button>
    </div>

    <p v-else-if="license.status?.edition === 'experience'" class="mt-8 text-sm text-[var(--um-text-muted)]">
      {{ T.noActEntry }}
    </p>

    <button
      type="button"
      class="mt-10 rounded-lg border border-[var(--um-border)] px-4 py-2 text-sm text-[var(--um-text-muted)] hover:text-[var(--um-text)]"
      data-license-exempt
      @click="router.push('/')"
    >
      {{ T.backHome }}
    </button>
  </WorkspaceFrame>
</template>
