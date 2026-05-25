import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import fs from 'fs-extra'
import extractZip from 'extract-zip'
import Store from 'electron-store'
import type { InstalledPluginRecord, PluginManifest } from '../../src/shared/plugin-contract'
import {
  cecHttpRunning,
  getCecLinkByUuid,
  postLocalQueryStartCharge,
  postLocalQueryStopCharge,
  pullStationsFromThirdParty,
  queryEquipBusinessPolicyFromThirdParty,
  syncOrderChargeStatusById,
  queryStationStatusFromThirdParty,
  setCecLogNotifier,
  startCecHttp,
  stopCecHttp,
  tickCecOrders,
} from './cec-http-server'
import {
  mergeInboundAuthTokenByLink,
  mergeCecLogs,
  mergeCecOrders,
  mergeEquipBusinessPolicy,
  mergeStationStatusByKey,
  mergeThirdPartyTokenByLink,
} from './cec-snapshot-merge'
import { getCecSnapshot, setCecSnapshot } from './cec-state'
import { normalizeCecLink, type CecSnapshot } from '../../src/shared/cec-types'
import { BUILD_META } from './build-meta'
import {
  activateLicense,
  experienceExpiredMessage,
  getLicenseStatus,
  officialBlockedMessage,
} from './license'
import type { LicenseStatus } from '../../src/shared/license-types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '../..')

export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const store = new Store<{
  themeMode: 'light' | 'dark' | 'system'
  plugins: InstalledPluginRecord[]
  license?: {
    activationKey?: string
    activationExpiresAt?: number
    activatedAt?: number
  }
  runtime?: {
    firstLaunchAt?: number
  }
}>({
  name: 'unions-config',
  defaults: {
    themeMode: 'dark',
    plugins: [],
  },
})

function currentLicenseStatus(): LicenseStatus {
  return getLicenseStatus(store)
}

async function blockIfLicenseExpired(interactive: boolean): Promise<{ ok: true } | { ok: false; status: LicenseStatus }> {
  const status = currentLicenseStatus()
  if (status.allowed) return { ok: true }
  const title = status.edition === 'experience' ? '体验版已过期' : '请重新激活'
  const message =
    status.edition === 'experience' ? experienceExpiredMessage(status) : officialBlockedMessage(status)
  if (interactive) {
    await dialog.showMessageBox({
      type: 'warning',
      title,
      message,
      buttons: status.quitOnBlock ? ['退出'] : ['确定'],
      defaultId: 0,
      noLink: true,
    })
    if (status.quitOnBlock) app.quit()
  }
  return { ok: false, status }
}

function getPluginsRoot(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

function validateManifest(m: Partial<PluginManifest>): m is PluginManifest {
  return !!(m.id && m.name && m.version && m.entry)
}

async function installPluginFromPath(sourcePath: string): Promise<InstalledPluginRecord> {
  const stat = await fs.stat(sourcePath)
  let workDir = sourcePath

  if (stat.isFile() && sourcePath.toLowerCase().endsWith('.zip')) {
    const tmp = path.join(app.getPath('temp'), `unions-plugin-${Date.now()}`)
    await fs.mkdir(tmp, { recursive: true })
    await extractZip(sourcePath, { dir: tmp })
    workDir = tmp
  } else if (!stat.isDirectory()) {
    throw new Error('请选择插件目录或 .zip 包')
  }

  const manifestPath = path.join(workDir, 'manifest.json')
  if (!(await fs.pathExists(manifestPath))) {
    throw new Error('未找到 manifest.json')
  }

  const raw = await fs.readJson(manifestPath)
  if (!validateManifest(raw)) {
    throw new Error('manifest.json 缺少 id / name / version / entry 字段')
  }
  const manifest = raw

  const dest = path.join(getPluginsRoot(), manifest.id)
  await fs.remove(dest)
  await fs.copy(workDir, dest, {
    overwrite: true,
    filter: (src) => !src.split(path.sep).includes('node_modules'),
  })

  const entryRel = manifest.entry.replace(/^\.\//, '')

  const record: InstalledPluginRecord = {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    rootPath: dest,
    entryRelative: entryRel,
  }

  const list = store.get('plugins').filter((p) => p.id !== record.id)
  list.push(record)
  store.set('plugins', list)

  return record
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')
const appIconPng = path.join(process.env.APP_ROOT, 'build/icons/app-icon.png')

type JxTcpSession = {
  pileId: string
  socket: net.Socket
  connected: boolean
  buffer: Buffer
  pending?: {
    expectCmds?: number[]
    resolve: (v: { ok: true; frameHex: string; cmd: string; dataHex: string }) => void
    reject: (e: Error) => void
    timer?: NodeJS.Timeout
  }
}

const jxTcpSessions = new Map<string, JxTcpSession>()

/** 协议校验码：从命令字节开始，逐字节异或到校验码前一字节（1字节） */
function xorChecksum8(data: Buffer): number {
  let checksum = 0x00
  for (let i = 0; i < data.length; i += 1) {
    checksum ^= data[i]
  }
  return checksum & 0xff
}

function pileToBcd8(pileId: string): Buffer {
  const digits = pileId.replace(/\D/g, '').padStart(16, '0').slice(-16)
  const out = Buffer.alloc(8)
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function buildJxFrame(cmd: number, pileId: string, payload: Buffer, dataEncryptMode = 0x01): Buffer {
  const fixed = Buffer.alloc(12)
  fixed[0] = 0x4a
  fixed[1] = 0x58
  fixed[2] = cmd & 0xff
  pileToBcd8(pileId).copy(fixed, 3)
  fixed[11] = dataEncryptMode & 0xff
  const len = Buffer.alloc(2)
  len.writeUInt16LE(payload.length, 0)
  const checksumData = Buffer.concat([fixed.subarray(2), len, payload])
  const checksum = xorChecksum8(checksumData)
  const tail = Buffer.from([checksum])
  return Buffer.concat([fixed, len, payload, tail])
}

function tryReadJxFrame(buffer: Buffer): { frame?: Buffer; remain: Buffer } {
  const start = buffer.indexOf(Buffer.from([0x4a, 0x58]))
  if (start < 0) return { remain: Buffer.alloc(0) }
  if (buffer.length < start + 15) return { remain: buffer.subarray(start) }
  const len = buffer.readUInt16LE(start + 12)
  const total = 14 + len + 1
  if (buffer.length < start + total) return { remain: buffer.subarray(start) }
  const frame = buffer.subarray(start, start + total)
  const remain = buffer.subarray(start + total)
  const checksumRecv = frame[frame.length - 1]
  const checksumCalc = xorChecksum8(frame.subarray(2, frame.length - 1))
  if (checksumRecv !== checksumCalc) return { remain }
  return { frame, remain }
}

function emitJxTcpEvent(event: Record<string, unknown>) {
  if (win && !win.isDestroyed()) win.webContents.send('jx:tcpEvent', event)
}

function closeJxSession(pileId: string, expectedSocket?: net.Socket) {
  const session = jxTcpSessions.get(pileId)
  if (!session) return
  if (expectedSocket && session.socket !== expectedSocket) return
  session.pending?.timer && clearTimeout(session.pending.timer)
  session.pending?.reject(new Error('tcp closed'))
  session.pending = undefined
  try {
    session.socket.destroy()
  } catch {
    // ignore
  }
  jxTcpSessions.delete(pileId)
}

function closeAllJxSessions() {
  for (const pileId of Array.from(jxTcpSessions.keys())) {
    closeJxSession(pileId)
  }
}

async function jxTcpInvoke(
  action: 'connect' | 'disconnect' | 'send' | 'status' | 'cancelPending',
  data?: unknown,
): Promise<Record<string, unknown>> {
  if (action === 'connect') {
    const p = data as { pileId: string; host: string; port: number; timeoutMs?: number }
    closeJxSession(p.pileId)
    return await new Promise((resolve) => {
      const socket = net.createConnection({ host: p.host, port: p.port })
      const session: JxTcpSession = { pileId: p.pileId, socket, connected: false, buffer: Buffer.alloc(0) }
      jxTcpSessions.set(p.pileId, session)
      const timeout = setTimeout(() => {
        closeJxSession(p.pileId)
        resolve({ ok: false, error: 'connect timeout' })
      }, p.timeoutMs ?? 5000)
      socket.once('connect', () => {
        clearTimeout(timeout)
        session.connected = true
        resolve({ ok: true })
      })
      socket.on('data', (chunk) => {
        session.buffer = Buffer.concat([session.buffer, chunk])
        while (true) {
          const parsed = tryReadJxFrame(session.buffer)
          session.buffer = parsed.remain
          if (!parsed.frame) break
          const cmd = parsed.frame[2]
          const dataHex = parsed.frame.subarray(14, parsed.frame.length - 1).toString('hex')
          const expects = session.pending?.expectCmds
          const cmdMatched = !expects || expects.length === 0 || expects.includes(cmd)
          if (session.pending && cmdMatched) {
            session.pending.timer && clearTimeout(session.pending.timer)
            session.pending.resolve({
              ok: true,
              frameHex: parsed.frame.toString('hex'),
              cmd: `0x${cmd.toString(16).padStart(2, '0')}`,
              dataHex,
            })
            session.pending = undefined
          } else {
            emitJxTcpEvent({
              type: 'frame',
              pileId: p.pileId,
              cmd: `0x${cmd.toString(16).padStart(2, '0')}`,
              dataHex,
              frameHex: parsed.frame.toString('hex'),
            })
          }
        }
      })
      socket.on('close', () => {
        emitJxTcpEvent({ type: 'disconnected', pileId: p.pileId })
        closeJxSession(p.pileId, socket)
      })
      socket.on('error', (err) => {
        emitJxTcpEvent({ type: 'error', pileId: p.pileId, error: err.message })
      })
    })
  }
  if (action === 'disconnect') {
    const p = data as { pileId: string }
    closeJxSession(p.pileId)
    return { ok: true }
  }
  if (action === 'status') {
    const p = data as { pileId: string }
    const s = jxTcpSessions.get(p.pileId)
    return { ok: true, connected: !!s?.connected }
  }
  if (action === 'cancelPending') {
    const p = data as { pileId: string }
    const s = jxTcpSessions.get(p.pileId)
    if (!s || !s.pending) return { ok: true, cancelled: false }
    s.pending.timer && clearTimeout(s.pending.timer)
    s.pending.reject(new Error('pending cancelled'))
    s.pending = undefined
    return { ok: true, cancelled: true }
  }
  if (action === 'send') {
    const p = data as {
      pileId: string
      cmd: string
      pileNo: string
      dataEncryptMode?: number
      dataHex?: string
      expectCmd?: string
      expectCmds?: string[]
      timeoutMs?: number
    }
    const s = jxTcpSessions.get(p.pileId)
    if (!s || !s.connected) return { ok: false, error: 'tcp not connected' }
    const cmd = Number.parseInt(p.cmd.replace(/^0x/i, ''), 16)
    const payload = Buffer.from((p.dataHex ?? '').replace(/\s+/g, ''), 'hex')
    const frame = buildJxFrame(cmd, p.pileNo, payload, Number.isFinite(p.dataEncryptMode) ? Number(p.dataEncryptMode) : 0x01)
    const requestFrameHex = frame.toString('hex')
    const expectCmdList = (Array.isArray(p.expectCmds) && p.expectCmds.length > 0
      ? p.expectCmds
      : p.expectCmd
        ? [p.expectCmd]
        : []
    )
      .map((x) => Number.parseInt(String(x).replace(/^0x/i, ''), 16))
      .filter((x) => Number.isFinite(x))
    // 未声明应答期望时，按“即发即返回”处理，避免日志受等待超时影响
    if (expectCmdList.length === 0) {
      s.socket.write(frame)
      return { ok: true, requestFrameHex }
    }
    if (s.pending) return { ok: false, error: 'previous request pending', requestFrameHex }
    return await new Promise((resolve) => {
      s.pending = {
        expectCmds: expectCmdList,
        resolve: (resp) => resolve({ ...resp, requestFrameHex }),
        reject: (e) => resolve({ ok: false, error: e.message, requestFrameHex }),
      }
      s.pending.timer = setTimeout(() => {
        s.pending = undefined
        resolve({ ok: false, error: 'recv timeout', requestFrameHex })
      }, p.timeoutMs ?? 5000)
      s.socket.write(frame)
    })
  }
  return { ok: false, error: 'unsupported action' }
}

async function createWindow() {
  win = new BrowserWindow({
    title: 'Unions Moni Tool',
    icon: appIconPng,
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.setMenuBarVisibility(false)
  win.removeMenu()

  if (VITE_DEV_SERVER_URL) {
    await win.loadURL(VITE_DEV_SERVER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    await win.loadFile(indexHtml)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url)
    return { action: 'deny' }
  })

  setCecLogNotifier((entry) => {
    try {
      win?.webContents.send('cec:log', entry)
    } catch {
      /* ignore */
    }
  })

  setInterval(() => {
    void tickCecOrders()
  }, 10_000)
}

const BUILTIN_CEC: InstalledPluginRecord = {
  id: 'cec-inner-link',
  name: '充电互联互通（内互联）模拟',
  version: '1.0.0',
  rootPath: '',
  entryRelative: '',
}

const BUILTIN_JX: InstalledPluginRecord = {
  id: 'jx-pile-simulator',
  name: '玖行电桩模拟',
  version: '1.0.0',
  rootPath: '',
  entryRelative: '',
}

/** 已移除的示例插件 id（从列表中剔除并不再安装） */
const REMOVED_PLUGIN_IDS = new Set(['demo-tcp'])

/** 去重并确保内置 CEC 插件存在于列表；有变更则写回 store */
function mergePluginsListWithBuiltin(raw: InstalledPluginRecord[]): InstalledPluginRecord[] {
  const withoutRemoved = raw.filter((p) => !REMOVED_PLUGIN_IDS.has(p.id))
  const deduped = withoutRemoved.filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i)
  if (!deduped.some((p) => p.id === BUILTIN_CEC.id)) {
    deduped.push({ ...BUILTIN_CEC })
  }
  if (!deduped.some((p) => p.id === BUILTIN_JX.id)) {
    deduped.push({ ...BUILTIN_JX })
  }
  return deduped
}

function ensureBuiltinCecPlugin() {
  const next = mergePluginsListWithBuiltin(store.get('plugins'))
  store.set('plugins', next)
}

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
  | 'syncOrderStatus'

function registerIpc() {
  const cecInvoke = async (
    action: CecInvokeAction,
    data: unknown,
    sender?: Electron.WebContents,
  ): Promise<unknown> => {
    if (action === 'pushSnapshot') {
      const snapshot = data as CecSnapshot
      const cur = getCecSnapshot()
      const maxLog = snapshot.settings?.logMaxEntries ?? 5000
      setCecSnapshot({
        ...snapshot,
        links: (snapshot.links ?? []).map((l) => normalizeCecLink(l)),
        orders: mergeCecOrders(cur.orders, snapshot.orders ?? []),
        logs: mergeCecLogs(cur.logs, snapshot.logs ?? [], maxLog),
        thirdPartyTokenByLink: mergeThirdPartyTokenByLink(
          cur.thirdPartyTokenByLink ?? {},
          snapshot.thirdPartyTokenByLink,
        ),
        inboundAuthTokenByLink: mergeInboundAuthTokenByLink(
          cur.inboundAuthTokenByLink ?? {},
          snapshot.inboundAuthTokenByLink,
        ),
        equipBusinessPolicyByKey: mergeEquipBusinessPolicy(
          cur.equipBusinessPolicyByKey ?? {},
          snapshot.equipBusinessPolicyByKey,
        ),
        stationStatusByKey: mergeStationStatusByKey(
          cur.stationStatusByKey ?? {},
          snapshot.stationStatusByKey,
        ),
      })
      return { ok: true as const }
    }
    if (action === 'getSnapshot') return getCecSnapshot()
    if (action === 'clearLogs') {
      const cur = getCecSnapshot()
      setCecSnapshot({ ...cur, logs: [] })
      return { ok: true as const }
    }
    if (action === 'deleteOrder') {
      const id = String((data as { orderId?: unknown } | undefined)?.orderId ?? '').trim()
      if (!id) return { ok: false as const, error: 'order id 为空' }
      const cur = getCecSnapshot()
      setCecSnapshot({
        ...cur,
        orders: (cur.orders ?? []).filter((o) => o.id !== id),
      })
      return { ok: true as const }
    }
    if (action === 'httpStart') {
      const opts = data as { port: number; host?: string }
      const host = opts.host ?? '0.0.0.0'
      return startCecHttp(opts.port, host)
    }
    if (action === 'httpStop') {
      await stopCecHttp()
      return { ok: true as const }
    }
    if (action === 'httpStatus') return { running: cecHttpRunning() }
    if (action === 'pullStations') {
      const payload = data as { linkUuid: string; pageSize?: number }
      const wc = sender ?? win?.webContents
      return pullStationsFromThirdParty(payload.linkUuid, {
        pageSize: payload.pageSize,
        onProgress: (p) => {
          wc?.send('cec:pullStations:progress', p)
        },
      })
    }
    if (action === 'queryEquipBusinessPolicy') {
      const payload = data as { linkUuid: string; connectorId: string }
      return queryEquipBusinessPolicyFromThirdParty(payload.linkUuid, payload.connectorId)
    }
    if (action === 'queryStationStatus') {
      const payload = data as { linkUuid: string; stationIds: string[] }
      return queryStationStatusFromThirdParty(payload.linkUuid, payload.stationIds ?? [])
    }
    if (action === 'clientStartCharge') {
      const payload = data as {
        linkUuid: string
        connectorId: string
        qr: string
        money?: number
      }
      const link = getCecLinkByUuid(payload.linkUuid)
      if (!link) return { ok: false as const, error: '未找到配置' }
      return postLocalQueryStartCharge(link, payload.connectorId, payload.qr, payload.money)
    }
    if (action === 'clientStopCharge') {
      const payload = data as { linkUuid: string; startChargeSeq: string; connectorId: string }
      const link = getCecLinkByUuid(payload.linkUuid)
      if (!link) return { ok: false as const, error: '未找到配置' }
      return postLocalQueryStopCharge(link, payload.startChargeSeq, payload.connectorId)
    }
    if (action === 'syncOrderStatus') {
      const payload = data as { orderId?: string }
      return syncOrderChargeStatusById(String(payload.orderId ?? ''))
    }
    return { ok: false as const, error: 'unsupported cec action' }
  }

  ipcMain.handle('settings:get', () => ({
    themeMode: store.get('themeMode'),
  }))

  ipcMain.handle('settings:set', (_, patch: { themeMode?: 'light' | 'dark' | 'system' }) => {
    if (patch.themeMode) store.set('themeMode', patch.themeMode)
    return { ok: true }
  })

  ipcMain.handle('license:getStatus', () => currentLicenseStatus())

  ipcMain.handle('license:activate', async (_, key: string) => {
    const blocked = await blockIfLicenseExpired(false)
    if (!blocked.ok && blocked.status.edition === 'experience') {
      return { ok: false, error: blocked.status.message }
    }
    return activateLicense(store, String(key ?? ''))
  })

  ipcMain.handle('license:assertAllowed', async () => {
    return blockIfLicenseExpired(true)
  })

  ipcMain.handle('plugins:list', (): InstalledPluginRecord[] => {
    const next = mergePluginsListWithBuiltin(store.get('plugins'))
    store.set('plugins', next)
    return next
  })

  ipcMain.handle('plugins:installFromPath', async (_, sourcePath: string) => {
    try {
      const record = await installPluginFromPath(sourcePath)
      return { ok: true as const, record }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false as const, error: msg }
    }
  })

  ipcMain.handle('plugins:remove', async (_, id: string) => {
    const list = store.get('plugins').filter((p) => p.id !== id)
    store.set('plugins', list)
    const dir = path.join(getPluginsRoot(), id)
    if (await fs.pathExists(dir)) await fs.remove(dir)
  })

  ipcMain.handle('dialog:openPluginSource', async (_, kind: 'zip' | 'dir') => {
    const parent = BrowserWindow.getFocusedWindow() ?? win
    if (!parent) return null
    const res = await dialog.showOpenDialog(parent, {
      properties: kind === 'zip' ? ['openFile'] : ['openDirectory'],
      filters: kind === 'zip' ? [{ name: 'ZIP', extensions: ['zip'] }] : [],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('dialog:openJsonFile', async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? win
    if (!parent) return null
    const res = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle('dialog:openExcelFile', async () => {
    const parent = BrowserWindow.getFocusedWindow() ?? win
    if (!parent) return null
    const res = await dialog.showOpenDialog(parent, {
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    })
    if (res.canceled || !res.filePaths[0]) return null
    return res.filePaths[0]
  })

  ipcMain.handle(
    'fs:readTextFile',
    async (
      _evt,
      filePath: string,
    ): Promise<{ ok: true; content: string } | { ok: false; error: string }> => {
      try {
        const content = await fs.readFile(filePath, 'utf8')
        return { ok: true, content }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'fs:readBinaryFile',
    async (
      _evt,
      filePath: string,
    ): Promise<{ ok: true; base64: string } | { ok: false; error: string }> => {
      try {
        const buf = await fs.readFile(filePath)
        return { ok: true, base64: buf.toString('base64') }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle(
    'dialog:saveTextFile',
    async (
      _evt,
      payload: { defaultFilename: string; content: string },
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      const parent = BrowserWindow.getFocusedWindow() ?? win
      if (!parent) return { ok: false, error: 'no window' }
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        defaultPath: payload.defaultFilename,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (canceled || !filePath) return { ok: false, error: 'cancelled' }
      await fs.writeFile(filePath, payload.content, 'utf8')
      return { ok: true, path: filePath }
    },
  )

  ipcMain.handle(
    'dialog:saveBinaryFile',
    async (
      _evt,
      payload: { defaultFilename: string; base64: string },
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      const parent = BrowserWindow.getFocusedWindow() ?? win
      if (!parent) return { ok: false, error: 'no window' }
      const { canceled, filePath } = await dialog.showSaveDialog(parent, {
        defaultPath: payload.defaultFilename,
        filters: [{ name: 'Excel', extensions: ['xlsx'] }],
      })
      if (canceled || !filePath) return { ok: false, error: 'cancelled' }
      const buf = Buffer.from(payload.base64, 'base64')
      await fs.writeFile(filePath, buf)
      return { ok: true, path: filePath }
    },
  )

  ipcMain.handle(
    'cec:invoke',
    (evt, payload: { action: CecInvokeAction; data?: unknown }) => {
      const action = payload?.action as CecInvokeAction
      return cecInvoke(action, payload?.data, evt.sender)
    },
  )
  ipcMain.handle(
    'jx:tcpInvoke',
    (_evt, payload: { action: 'connect' | 'disconnect' | 'send' | 'status' | 'cancelPending'; data?: unknown }) => {
      return jxTcpInvoke(payload.action, payload.data)
    },
  )
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  fs.ensureDirSync(getPluginsRoot())
  const legacyDemo = path.join(getPluginsRoot(), 'demo-tcp')
  if (await fs.pathExists(legacyDemo)) {
    await fs.remove(legacyDemo).catch(() => {})
  }
  registerIpc()
  ensureBuiltinCecPlugin()

  const license = currentLicenseStatus()
  if (license.edition === 'experience' && !license.allowed) {
    await dialog.showMessageBox({
      type: 'error',
      title: '体验版已过期',
      message: experienceExpiredMessage(license),
      buttons: ['退出'],
      defaultId: 0,
      noLink: true,
    })
    app.quit()
    return
  }

  await createWindow()

  if (BUILD_META.edition === 'experience') {
    setInterval(() => {
      const s = currentLicenseStatus()
      if (!s.allowed && win && !win.isDestroyed()) {
        void dialog
          .showMessageBox({
            type: 'warning',
            title: '体验版已过期',
            message: experienceExpiredMessage(s),
            buttons: ['退出'],
            defaultId: 0,
            noLink: true,
          })
          .then(() => app.quit())
      }
    }, 60_000)
  }
})

app.on('window-all-closed', () => {
  closeAllJxSessions()
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('before-quit', () => {
  closeAllJxSessions()
})
