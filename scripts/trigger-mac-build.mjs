/**
 * 从 Windows 触发 macOS 远程打包（GitHub Actions），或在 macOS 上直接本地打包。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseExperienceValidFromTokens } from './experience-valid-parse.mjs'

const edition = process.argv[2] === 'official' ? 'official' : 'experience'
const validArg = process.argv.slice(3).join(' ').trim()
const experienceValid =
  edition === 'experience'
    ? parseExperienceValidFromTokens(validArg ? validArg.split(/\s+/) : ['1y']) ?? '1y'
    : '1y'

function refreshWindowsPath() {
  if (process.platform !== 'win32') return
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ],
    { encoding: 'utf8', shell: false },
  )
  if (ps.status === 0 && ps.stdout?.trim()) {
    process.env.Path = ps.stdout.trim()
    process.env.PATH = ps.stdout.trim()
  }
}

function resolveGhExe() {
  refreshWindowsPath()
  const candidates = [
    process.env.GH_PATH,
    'D:\\Program Files\\GitHub CLI\\gh.exe',
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'GitHub CLI', 'gh.exe'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'gh'
}

function ghRun(args, opts = {}) {
  const gh = resolveGhExe()
  return spawnSync(gh, args, { stdio: 'inherit', shell: gh === 'gh', ...opts })
}

function ghCapture(args) {
  const gh = resolveGhExe()
  return spawnSync(gh, args, { encoding: 'utf8', shell: gh === 'gh' })
}

function runLocalMacBuild() {
  console.log(`[mac] 本地打包 edition=${edition} valid=${experienceValid}`)
  const r = spawnSync(
    'node',
    ['scripts/build-with-edition.mjs', edition, ...(edition === 'experience' ? [experienceValid] : []), 'mac'],
    { stdio: 'inherit', shell: true },
  )
  process.exit(r.status ?? 1)
}

function resolveRepoArgs() {
  const repo = (process.env.UNIONS_GITHUB_REPO || process.env.GH_REPO || '').trim()
  if (repo) return ['-R', repo]
  const view = ghCapture(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
  if (view.status === 0 && view.stdout?.trim()) return ['-R', view.stdout.trim()]
  return []
}

if (process.platform === 'darwin') {
  runLocalMacBuild()
}

console.log('[mac] Windows/Linux 无法本地生成 .dmg，正在触发 GitHub Actions…')
console.log(`[mac] edition=${edition} experience_valid=${experienceValid}`)

if (ghCapture(['--version']).status !== 0) {
  console.error('[mac] 未找到 gh。请安装 GitHub CLI 并重新打开终端。')
  process.exit(1)
}

if (ghCapture(['auth', 'status']).status !== 0) {
  console.error(
    '[mac] GitHub CLI 未登录。请在本机终端执行：\n\n  gh auth login\n\n然后重试：\n  npm run build:mac:experience:remote -- 1y',
  )
  process.exit(1)
}

const repoArgs = resolveRepoArgs()
if (!repoArgs.length) {
  console.error(
    '[mac] 未关联 GitHub 仓库。请执行：\n\n' +
      '  git init\n' +
      '  git remote add origin https://github.com/<账号>/<仓库>.git\n' +
      '  git push -u origin main\n\n' +
      '或：set UNIONS_GITHUB_REPO=<账号>/<仓库> 后重试',
  )
  process.exit(1)
}

const trigger = ghRun([
  'workflow',
  'run',
  'build-mac.yml',
  ...repoArgs,
  '-f',
  `edition=${edition}`,
  '-f',
  `experience_valid=${experienceValid}`,
  '-f',
  'disable_obfuscation=1',
])

if (trigger.status !== 0) {
  console.error('[mac] 触发失败。请确认 .github/workflows/build-mac.yml 已 push 到 GitHub。')
  process.exit(trigger.status ?? 1)
}

const artifactName = `mac-${edition}-${experienceValid}`
console.log('\n[mac] 已触发远程构建。')
console.log(`  gh run watch ${repoArgs.join(' ')}`)
console.log(`  gh run download ${repoArgs.join(' ')} --name ${artifactName}`)
