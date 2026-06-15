import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { contextBridge, ipcRenderer } from 'electron'
import type { InstalledPluginRecord } from '../../src/shared/plugin-contract'
import type { CecLogEntry } from '../../src/shared/cec-types'
import type { LicenseActivateResult, LicenseStatus } from '../../src/shared/license-types'

export type ThemeMode = 'light' | 'dark' | 'system'
type CecInvokeAction =
  | 'pushSnapshot'
  | 'getSnapshot'
  | 'clearLogs'
  | 'deleteOrder'
  | 'httpStart'
  | 'httpStop'
  | 'httpStatus'
  | 'pullStations'
  | 'queryEquipBusinessPolicy'
  | 'queryStationStatus'
  | 'clientStartCharge'
  | 'clientStopCharge'
  | 'clientQueryTerminalCode'
  | 'syncOrderStatus'
  | 'clearInboundToken'
  | 'clearThirdPartyToken'

const unions = {
  getSettings: (): Promise<{ themeMode: ThemeMode }> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: { themeMode?: ThemeMode }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('settings:set', patch),

  getLicenseStatus: (): Promise<LicenseStatus> => ipcRenderer.invoke('license:getStatus'),

  activateLicense: (key: string): Promise<LicenseActivateResult> =>
    ipcRenderer.invoke('license:activate', key),

  assertLicenseAllowed: (): Promise<{ ok: true } | { ok: false; status: LicenseStatus }> =>
    ipcRenderer.invoke('license:assertAllowed'),

  listPlugins: (): Promise<InstalledPluginRecord[]> => ipcRenderer.invoke('plugins:list'),

  installPluginFromPath: (
    sourcePath: string,
  ): Promise<
    { ok: true; record: InstalledPluginRecord } | { ok: false; error: string }
  > => ipcRenderer.invoke('plugins:installFromPath', sourcePath),

  removePlugin: (id: string): Promise<void> => ipcRenderer.invoke('plugins:remove', id),

  openPluginSourceDialog: (kind: 'zip' | 'dir'): Promise<string | null> =>
    ipcRenderer.invoke('dialog:openPluginSource', kind),

  openJsonFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openJsonFile'),

  openExcelFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openExcelFile'),

  readTextFile: (
    filePath: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:readTextFile', filePath),

  readBinaryFile: (
    filePath: string,
  ): Promise<{ ok: true; base64: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('fs:readBinaryFile', filePath),

  saveTextFile: (payload: { defaultFilename: string; content: string }) =>
    ipcRenderer.invoke(
      'dialog:saveTextFile',
      payload,
    ) as Promise<{ ok: true; path: string } | { ok: false; error: string }>,

  saveBinaryFile: (payload: { defaultFilename: string; base64: string }) =>
    ipcRenderer.invoke(
      'dialog:saveBinaryFile',
      payload,
    ) as Promise<{ ok: true; path: string } | { ok: false; error: string }>,

  /** 将插件入口解析为可用于动态 import 的 file URL */
  resolvePluginEntryUrl: (record: InstalledPluginRecord): string => {
    const abs = path.join(record.rootPath, record.entryRelative)
    return pathToFileURL(abs).href
  },

  cecInvoke: (
    action: CecInvokeAction,
    data?: unknown,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('cec:invoke', { action, data }),

  jxTcpInvoke: (
    action: 'connect' | 'disconnect' | 'send' | 'status' | 'cancelPending',
    data?: unknown,
  ): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('jx:tcpInvoke', { action, data }),

  onJxTcpEvent: (cb: (event: Record<string, unknown>) => void): (() => void) => {
    const fn = (_e: Electron.IpcRendererEvent, event: Record<string, unknown>) => cb(event)
    ipcRenderer.on('jx:tcpEvent', fn)
    return () => {
      ipcRenderer.removeListener('jx:tcpEvent', fn)
    }
  },

  onCecPullStationsProgress: (
    cb: (p: { pageNo: number; totalPages: number; pagesFetched: number }) => void,
  ): (() => void) => {
    const fn = (
      _e: Electron.IpcRendererEvent,
      p: { pageNo: number; totalPages: number; pagesFetched: number },
    ) => cb(p)
    ipcRenderer.on('cec:pullStations:progress', fn)
    return () => {
      ipcRenderer.removeListener('cec:pullStations:progress', fn)
    }
  },

  onCecLog: (cb: (entry: CecLogEntry) => void): (() => void) => {
    const fn = (_e: Electron.IpcRendererEvent, entry: CecLogEntry) => cb(entry)
    ipcRenderer.on('cec:log', fn)
    return () => {
      ipcRenderer.removeListener('cec:log', fn)
    }
  },
}

contextBridge.exposeInMainWorld('unions', unions)

export type UnionsAPI = typeof unions
