import type { Plugin } from 'vite'
import JavaScriptObfuscator from 'javascript-obfuscator'
import type { ObfuscatorOptions } from 'javascript-obfuscator'

type ObfuscateTarget = 'renderer' | 'main' | 'preload'

function optionsFor(target: ObfuscateTarget): ObfuscatorOptions {
  const base: ObfuscatorOptions = {
    compact: true,
    log: false,
    renameGlobals: false,
    /** 禁止改写对象字面量键名，避免破坏 Vue、preload 的 contextBridge 等 */
    transformObjectKeys: false,
    identifierNamesGenerator: 'hexadecimal',
    numbersToExpressions: true,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 8,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayShuffle: true,
    stringArrayThreshold: 0.75,
    stringArrayWrappersCount: 2,
    stringArrayWrappersChainedCalls: true,
    stringArrayWrappersParametersMaxCount: 4,
    unicodeEscapeSequence: false,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    selfDefending: false,
    debugProtection: false,
  }

  if (target === 'main') {
    return { ...base, target: 'node' }
  }
  if (target === 'preload') {
    return { ...base, target: 'browser-no-eval' }
  }
  return { ...base, target: 'browser' }
}

/** 屏蔽 javascript-obfuscator 免费版构建时的 Pro 广告输出 */
function obfuscateChunkQuiet(code: string, options: ObfuscatorOptions): string {
  const log = console.log
  console.log = (...args: unknown[]) => {
    const msg = String(args[0] ?? '')
    if (msg.includes('JavaScript Obfuscator Pro') || msg.includes('obfuscator.io')) return
    log.apply(console, args)
  }
  try {
    return JavaScriptObfuscator.obfuscate(code, options).getObfuscatedCode()
  } finally {
    console.log = log
  }
}

/**
 * 生产构建时对 Rollup 产物做 javascript-obfuscator 处理。
 * 说明：无法做到绝对「不可反编译」，只能提高阅读与还原成本；勿开启会破坏 Electron 的选项。
 */
export function createObfuscatePlugin(target: ObfuscateTarget, enabled: boolean): Plugin {
  const name = `cec-obfuscate:${target}`
  if (!enabled) {
    return { name }
  }

  return {
    name,
    enforce: 'post',
    renderChunk(code, chunk) {
      if (!chunk.fileName.endsWith('.js') && !chunk.fileName.endsWith('.mjs')) return null
      if (!code.trim()) return null
      /** 第三方依赖不做混淆，避免破坏 html5-qrcode / zxing 等解码逻辑 */
      const moduleIds = chunk.moduleIds ?? []
      const isVendorChunk = moduleIds.some((id) => id.replace(/\\/g, '/').includes('node_modules'))
      const isVendorFile = /html5-qrcode|jsqr|zxing|exceljs|echarts|qrcode/i.test(chunk.fileName)
      if (isVendorChunk || isVendorFile) return null
      try {
        const result = obfuscateChunkQuiet(code, optionsFor(target))
        return {
          code: result,
          map: null,
        }
      } catch (e) {
        console.error(`[${name}] 混淆失败: ${chunk.fileName}`, e)
        throw e
      }
    },
  }
}
