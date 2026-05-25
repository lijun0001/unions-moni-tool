import type { Component } from 'vue'

export interface PluginMeta {
  id: string
  name: string
  version: string
  description?: string
}

export interface HomeCardDescriptor {
  title: string
  subtitle?: string
  badge?: string
}

/** 插件 manifest（磁盘上的 manifest.json） */
export interface PluginManifest {
  id: string
  name: string
  version: string
  entry: string
  permissions?: string[]
}

/** 插件必须提供的 API（由入口 ESM 导出） */
export interface ProtocolSimulatorPlugin {
  meta: PluginMeta
  homeCard: HomeCardDescriptor
  MainView: Component
  SettingsView?: Component
}

/** 已安装插件在注册表中的记录 */
export interface InstalledPluginRecord {
  id: string
  name: string
  version: string
  rootPath: string
  entryRelative: string
}
