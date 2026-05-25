import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import pkg from './package.json'
import { createObfuscatePlugin } from './vite/plugins/obfuscate'
import { normalizeExperienceValid } from './src/shared/experience-validity'
const root = path.resolve(__dirname)

export default defineConfig(({ command }) => {
  fs.rmSync('dist-electron', { recursive: true, force: true })

  const isServe = command === 'serve'
  const isBuild = command === 'build'
  const sourcemap = isServe || !!process.env.VSCODE_DEBUG
  /** 生产构建默认混淆；排查问题时设 DISABLE_OBFUSCATION=1 */
  const obfuscateEnabled = isBuild && process.env.DISABLE_OBFUSCATION !== '1'

  /** UNIONS_EDITION=experience|official；UNIONS_BUILD_TIME_MS=打包时间戳；UNIONS_EXPERIENCE_VALID=1h|1d|1m|1y */
  const unionsEdition =
    process.env.UNIONS_EDITION === 'experience' ? 'experience' : 'official'
  const unionsBuildTimeMs = process.env.UNIONS_BUILD_TIME_MS || String(Date.now())
  const unionsExperienceValid =
    unionsEdition === 'experience'
      ? normalizeExperienceValid(process.env.UNIONS_EXPERIENCE_VALID)
      : ''
  const unionsBuildDefine = {
    __UNIONS_EDITION__: JSON.stringify(unionsEdition),
    __UNIONS_BUILD_TIME_MS__: JSON.stringify(unionsBuildTimeMs),
    __UNIONS_EXPERIENCE_VALID__: JSON.stringify(unionsExperienceValid),
  }

  return {
    define: unionsBuildDefine,
    root,
    resolve: {
      alias: {
        '@renderer': path.join(root, 'src/renderer'),
        '@shared': path.join(root, 'src/shared'),
      },
    },
    plugins: [
      vue(),
      createObfuscatePlugin('renderer', obfuscateEnabled),
      electron({
        main: {
          entry: 'electron/main/index.ts',
          onstart({ startup }) {
            startup()
          },
          vite: {
            define: unionsBuildDefine,
            plugins: [createObfuscatePlugin('main', obfuscateEnabled)],
            build: {
              sourcemap,
              minify: isBuild,
              outDir: 'dist-electron/main',
              rollupOptions: {
                external: Object.keys('dependencies' in pkg ? pkg.dependencies : {}),
              },
            },
          },
        },
        preload: {
          input: 'electron/preload/index.ts',
          vite: {
            plugins: [createObfuscatePlugin('preload', obfuscateEnabled)],
            build: {
              sourcemap: sourcemap ? 'inline' : undefined,
              minify: isBuild,
              outDir: 'dist-electron/preload',
              /** 必须输出 ESM：Electron 以 .mjs 按 ESModule 加载 preload，CJS 的 require 会报 require is not defined */
              rollupOptions: {
                external: ['electron', 'node:path', 'node:url'],
                output: {
                  format: 'es',
                },
              },
            },
          },
        },
        renderer: {},
      }),
    ],
    build: {
      sourcemap,
      minify: isBuild,
    },
    server: {
      port: 5173,
    },
    clearScreen: false,
  }
})
