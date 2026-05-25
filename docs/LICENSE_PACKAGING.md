# 许可与打包说明

## 体验版有效期规格

支持 **动态数量 + 年/月/日**（默认 `1y`）：

| 写法示例 | 含义 |
|----------|------|
| `2y` / `2 y` / `2 year` / `2 年` | 2 年 |
| `3m` / `3 月` / `3 months` | 3 个自然月 |
| `7d` / `7 日` / `7 day` | 7 天 |
| `1h` | 1 小时（可选） |

截止时间 = **打包时刻** + 上述时长，写入安装包；**重装不能延长**。

## 打包命令

```bash
# 默认 1 年
npm run build:win:experience

# npm 在命令后传参（注意 --）
npm run build:win:experience -- 2y
npm run build:win:experience -- 3 月
npm run build:win:experience -- 7 日
npm run build:win:experience -- 2 year
npm run build:linux:experience -- 6m linux

# 或直接 node
node scripts/build-with-edition.mjs experience 2y
node scripts/build-with-edition.mjs experience 3 月 win
```

| 命令 | 说明 |
|------|------|
| `npm run build:win:official` | Windows 正式版 |
| `npm run build:win:experience` | Windows 体验版（1y） |
| `npm run build:linux:experience` | Linux 体验版（1y） |
| `npm run build:mac:official` | macOS 正式版（Apple Silicon arm64，`.dmg`） |
| `npm run build:mac:experience` | macOS 体验版（arm64） |

构建时写入 `UNIONS_EDITION`、`UNIONS_BUILD_TIME_MS`、`UNIONS_EXPERIENCE_VALID`（许可逻辑与 Windows/Linux 一致）。

### macOS（Apple Silicon）

- 产物：**`.dmg` 安装镜像**，架构 **arm64**（M 系列芯片）。
- **本地打包必须在 macOS 上**；Windows 无法直接生成 `.dmg`（Electron 限制）。

#### 在 Windows 上打 mac 测试包（远程 CI）

需将仓库 push 到 GitHub，并安装 [GitHub CLI](https://cli.github.com/)（`gh auth login`）：

```bash
# 体验版测试包，有效期 1 小时（默认关闭混淆，构建更快）
npm run build:mac:experience:test

# 自定义有效期
npm run build:mac:experience:remote -- 1h
npm run build:mac:experience:remote -- 7d
npm run build:mac:experience:remote -- 1y

# 正式版
npm run build:mac:official:remote
```

触发后在 GitHub **Actions** 页下载 artifact，或：

```bash
gh run watch
gh run download --name mac-experience-1h
```

许可参数（`UNIONS_EDITION` / `UNIONS_EXPERIENCE_VALID` / `UNIONS_BUILD_TIME_MS`）在 CI 中与本地 mac 打包一致。

#### 在 Mac 上本地打包

```bash
npm run build:mac:official
npm run build:mac:experience -- 2y
node scripts/build-with-edition.mjs experience 1m mac
```

> 说明：本项目为 Electron **桌面端**，对应 **macOS** `.dmg`；**iOS（iPhone/iPad）** 不在支持范围内。

## 本地调试

环境变量（推荐）：

```bash
cross-env UNIONS_EDITION=experience UNIONS_EXPERIENCE_VALID=1h npm run dev
npm run dev:experience:1h
npm run dev:experience:1d
```

启动参数（主进程，优先级高于环境变量）：

```bash
npm run dev -- --experience-valid=1d
# 或
electron . --experience-valid=1h
```

也可使用环境变量 `UNIONS_EXPERIENCE_VALID=1m`。

## 激活码（仅正式版）

```bash
npm run license:gen-key -- 2026-12-31
npm run license:gen-key -- +365
```

## 行为摘要

- **体验版**：不可激活；到期无法启动；运行中到期后任意点击弹框并退出。
- **正式版**：首次启动 7 天体验；可激活；过期后提示「请重新激活」。

## 玖行桩模拟

协议下拉 **V2.25 禁用**，默认 **V2.24**。
