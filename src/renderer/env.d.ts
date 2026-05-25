/// <reference types="vite/client" />

import type { InstalledPluginRecord } from '@shared/plugin-contract'
import type { CecLogEntry } from '@shared/cec-types'
import type { LicenseActivateResult, LicenseStatus } from '@shared/license-types'

declare global {
  interface Window {
    unions: {
      getSettings: () => Promise<{ themeMode: 'light' | 'dark' | 'system' }>
      setSettings: (patch: { themeMode?: 'light' | 'dark' | 'system' }) => Promise<{ ok: boolean }>
      getLicenseStatus: () => Promise<LicenseStatus>
      activateLicense: (key: string) => Promise<LicenseActivateResult>
      assertLicenseAllowed: () => Promise<{ ok: true } | { ok: false; status: LicenseStatus }>
      listPlugins: () => Promise<InstalledPluginRecord[]>
      installPluginFromPath: (
        sourcePath: string,
      ) => Promise<{ ok: true; record: InstalledPluginRecord } | { ok: false; error: string }>
      removePlugin: (id: string) => Promise<void>
      openPluginSourceDialog: (kind: 'zip' | 'dir') => Promise<string | null>
      openJsonFileDialog: () => Promise<string | null>
      openExcelFileDialog: () => Promise<string | null>
      readTextFile: (
        filePath: string,
      ) => Promise<{ ok: true; content: string } | { ok: false; error: string }>
      readBinaryFile: (
        filePath: string,
      ) => Promise<{ ok: true; base64: string } | { ok: false; error: string }>
      saveTextFile: (payload: {
        defaultFilename: string
        content: string
      }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
      saveBinaryFile: (payload: {
        defaultFilename: string
        base64: string
      }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
      resolvePluginEntryUrl: (record: InstalledPluginRecord) => string
      cecInvoke: (
        action:
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
          | 'syncOrderStatus',
        data?: unknown,
      ) => Promise<{ ok: boolean; error?: string }>
      jxTcpInvoke: (
        action: 'connect' | 'disconnect' | 'send' | 'status' | 'cancelPending',
        data?: unknown,
      ) => Promise<Record<string, unknown>>
      onJxTcpEvent: (cb: (event: Record<string, unknown>) => void) => () => void
      onCecPullStationsProgress: (
        cb: (p: { pageNo: number; totalPages: number; pagesFetched: number }) => void,
      ) => () => void
      onCecLog: (cb: (entry: CecLogEntry) => void) => () => void
    }
    __UNIONS_VUE__: typeof import('vue')
  }
}

export {}
