/**
 * 按版本打包：
 *   node scripts/build-with-edition.mjs experience [有效期] [win|linux|mac]
 *   node scripts/build-with-edition.mjs official [win|linux|mac]
 *
 * npm 示例：
 *   npm run build:mac:experience -- 1y
 *   npm run build:win:experience -- 2y
 */
import { spawnSync } from 'node:child_process'
import { parseExperienceValidFromTokens } from './experience-valid-parse.mjs'

const PLATFORM = new Set(['win', 'linux', 'mac'])

function collectDurationTokens(argv, startPos) {
  const tokens = []
  let pos = startPos
  while (pos < argv.length) {
    const a = argv[pos]
    if (PLATFORM.has(a)) break
    tokens.push(a)
    pos++
  }
  return { tokens, nextPos: pos }
}

function resolvePlatform(arg) {
  if (arg === 'linux') return 'linux'
  if (arg === 'mac') return 'mac'
  return 'win'
}

function npmScriptFor(platform) {
  if (platform === 'linux') return 'build:linux'
  if (platform === 'mac') return 'build:mac'
  return 'build:win'
}

const editionArg = process.argv[2] === 'experience' ? 'experience' : 'official'
let pos = 3
let experienceValid = '1y'

// 先识别平台（如 build:mac:experience 固定传入 mac），再解析其后或之前的有效期
let platform = 'win'
if (PLATFORM.has(process.argv[pos])) {
  platform = resolvePlatform(process.argv[pos])
  pos++
}

if (editionArg === 'experience') {
  const { tokens, nextPos } = collectDurationTokens(process.argv, pos)
  if (tokens.length) {
    const parsed = parseExperienceValidFromTokens(tokens)
    if (!parsed) {
      console.error(
        `[build] Invalid experience validity: ${tokens.join(' ')}\n` +
          'Use: 2y | 3m | 7d | 2 year | 3 月 | 7 日\n' +
          'Example: npm run build:mac:experience -- 2y',
      )
      process.exit(1)
    }
    experienceValid = parsed
  }
  pos = nextPos
}

if (PLATFORM.has(process.argv[pos])) {
  platform = resolvePlatform(process.argv[pos])
  pos++
}

const npmScript = npmScriptFor(platform)

if (platform === 'mac' && process.platform !== 'darwin') {
  console.error(
    `[build] macOS 安装包无法在 Windows 上本地构建（当前系统: ${process.platform}）。\n` +
      '可选方案：\n' +
      '  • 远程测试包（GitHub Actions）: npm run build:mac:experience:remote -- 1h\n' +
      '  • 快捷测试包（默认 1h）: npm run build:mac:experience:test\n' +
      '  • 在 Mac 上本地打包: npm run build:mac:experience -- 1y',
  )
  process.exit(1)
}

const env = {
  ...process.env,
  UNIONS_EDITION: editionArg,
  UNIONS_BUILD_TIME_MS: String(Date.now()),
  UNIONS_EXPERIENCE_VALID: editionArg === 'experience' ? experienceValid : '',
}

console.log(`[build] UNIONS_EDITION=${editionArg}`)
console.log(`[build] UNIONS_BUILD_TIME_MS=${env.UNIONS_BUILD_TIME_MS}`)
if (editionArg === 'experience') {
  console.log(`[build] UNIONS_EXPERIENCE_VALID=${experienceValid}`)
}
console.log(`[build] target=${platform} arm64 (${npmScript})`)

const r = spawnSync('npm', ['run', npmScript], {
  env,
  stdio: 'inherit',
  shell: true,
})

process.exit(r.status ?? 1)
