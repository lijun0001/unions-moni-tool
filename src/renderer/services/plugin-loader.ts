import { markRaw } from 'vue'
import type { Component } from 'vue'
import type { InstalledPluginRecord, ProtocolSimulatorPlugin } from '@shared/plugin-contract'
import * as CecInnerLink from '@renderer/plugins/cec-inner-link/index'
import * as JxPileSimulator from '@renderer/plugins/jx-pile-simulator/index'
import * as QrBatchExport from '@renderer/plugins/qr-batch-export/index'

function joinPluginPath(rootPath: string, relative: string): string {
  const root = rootPath.replace(/[\\/]+$/, '')
  const rel = relative.replace(/^[/\\]+/, '')
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root}${sep}${rel.replace(/\//g, sep)}`
}

async function readIntroFromDisk(record: InstalledPluginRecord): Promise<string | undefined> {
  if (!record.rootPath) return undefined
  const candidates = [
    record.introDoc,
    'docs/user-manual.md',
    'docs/intro.md',
    'intro.md',
  ].filter((x): x is string => Boolean(String(x ?? '').trim()))

  for (const rel of candidates) {
    const abs = joinPluginPath(record.rootPath, rel)
    const r = await window.unions.readTextFile(abs)
    if (r.ok && r.content.trim()) return r.content
  }
  return undefined
}

async function resolveIntroMarkdown(
  record: InstalledPluginRecord,
  mod: Record<string, unknown>,
): Promise<string | undefined> {
  const exported = mod.introMarkdown
  if (typeof exported === 'string' && exported.trim()) return exported
  return readIntroFromDisk(record)
}

/** 从 file:// 入口加载 ESM；插件应使用 globalThis.__UNIONS_VUE__ 引用 Vue */
export async function loadPluginModule(
  record: InstalledPluginRecord,
): Promise<ProtocolSimulatorPlugin> {
  /** 内置插件必须静态导入，避免生产包内动态 import 分块路径在 Electron file 协议下解析失败 */
  if (record.id === 'cec-inner-link') {
    return {
      meta: CecInnerLink.meta,
      homeCard: CecInnerLink.homeCard,
      MainView: CecInnerLink.MainView,
    }
  }
  if (record.id === 'jx-pile-simulator') {
    return {
      meta: JxPileSimulator.meta,
      homeCard: JxPileSimulator.homeCard,
      MainView: JxPileSimulator.MainView,
      introMarkdown: JxPileSimulator.introMarkdown,
    }
  }
  if (record.id === 'qr-batch-export') {
    return {
      meta: QrBatchExport.meta,
      homeCard: QrBatchExport.homeCard,
      MainView: QrBatchExport.MainView,
    }
  }
  const href = window.unions.resolvePluginEntryUrl(record)
  const mod = (await import(/* @vite-ignore */ href)) as Record<string, unknown>
  const meta = mod.meta
  const homeCard = mod.homeCard
  const MainView = mod.MainView
  if (!meta || !homeCard || !MainView) {
    throw new Error(`插件 ${record.id} 缺少 meta / homeCard / MainView 导出`)
  }
  const introMarkdown = await resolveIntroMarkdown(record, mod)
  return {
    meta: meta as ProtocolSimulatorPlugin['meta'],
    homeCard: homeCard as ProtocolSimulatorPlugin['homeCard'],
    MainView: markRaw(MainView as Component) as ProtocolSimulatorPlugin['MainView'],
    SettingsView: mod.SettingsView as ProtocolSimulatorPlugin['SettingsView'],
    introMarkdown,
  }
}
