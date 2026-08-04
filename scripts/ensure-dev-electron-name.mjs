/**
 * 开发态 Electron 默认为 electron.exe，本机安全助手常按进程名拦截。
 * 复制并切到与已安装版一致的「Unions Moni Tool.exe」，使 npm run dev* 与安装包同名启动。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 与本机安装目录下可启动的 exe 名一致（无版本号） */
export const DEV_ELECTRON_EXE_NAME = 'Unions Moni Tool.exe'

const require = createRequire(import.meta.url)

/**
 * @returns {string | undefined} 可供 spawn 的绝对路径；非 win32 或不需要时返回 undefined
 */
export function ensureDevElectronName() {
  if (process.platform !== 'win32') return undefined

  let electronPkgDir
  try {
    electronPkgDir = path.dirname(require.resolve('electron/package.json'))
  } catch {
    console.warn('[ensure-dev-electron-name] electron 未安装，跳过')
    return undefined
  }

  const distDir = path.join(electronPkgDir, 'dist')
  const pathFile = path.join(electronPkgDir, 'path.txt')
  const sourceExe = path.join(distDir, 'electron.exe')
  const targetExe = path.join(distDir, DEV_ELECTRON_EXE_NAME)

  if (!fs.existsSync(sourceExe)) {
    console.warn('[ensure-dev-electron-name] 未找到 electron.exe，跳过')
    return undefined
  }

  const needCopy =
    !fs.existsSync(targetExe) ||
    fs.statSync(sourceExe).size !== fs.statSync(targetExe).size ||
    fs.statSync(sourceExe).mtimeMs > fs.statSync(targetExe).mtimeMs

  if (needCopy) {
    fs.copyFileSync(sourceExe, targetExe)
    console.log(`[ensure-dev-electron-name] 已复制 -> ${DEV_ELECTRON_EXE_NAME}`)
  }

  const current = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, 'utf8').trim() : ''
  if (current !== DEV_ELECTRON_EXE_NAME) {
    fs.writeFileSync(pathFile, DEV_ELECTRON_EXE_NAME, 'utf8')
    console.log(`[ensure-dev-electron-name] path.txt -> ${DEV_ELECTRON_EXE_NAME}`)
  }

  return targetExe
}

const isDirectRun =
  process.argv[1] != null &&
  pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href

if (isDirectRun) {
  ensureDevElectronName()
}
