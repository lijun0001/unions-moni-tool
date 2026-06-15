# um-shell-layers v1 回滚说明

壳层/画布层次方案（顶栏托盘 + 工作区面板 + 统一顶距）的回滚步骤。

## 涉及文件

| 文件 | 作用 |
|------|------|
| `src/renderer/styles/um-shell-layers.css` | 层次令牌与样式（**删除即可去掉大部分效果**） |
| `src/renderer/main.ts` | 引入 `um-shell-layers.css` |
| `src/renderer/components/ShellMenu.vue` | `um-shell-chrome` 顶栏托盘 |
| `src/renderer/App.vue` | `um-canvas-main` |
| `src/renderer/views/*.vue` | `um-page-shell` + `um-workspace-panel` |

## 快速回滚（保留旧顶距）

1. 删除 `src/renderer/styles/um-shell-layers.css`
2. `main.ts` 去掉 `import './styles/um-shell-layers.css'`
3. `ShellMenu.vue`：将 `um-shell-chrome` 改回单层 `div` + `p-[var(--space-lg)]`（搜索 `um-layer-chrome`）
4. 各视图根节点改回：
   ```html
   <div class="px-[var(--space-xl)] pb-[var(--space-2xl)] pt-[calc(var(--space-2xl)+3rem)]">
   ```
5. `PluginView` 填充分支使用 `min-h-0 flex-1 overflow-hidden` 包裹插件即可

## 微调（不回滚）

在 `um-shell-layers.css` 的 `:root` 中修改：

- `--um-shell-content-gap`：顶栏与面板顶间距（默认 `12px`）
- `--um-shell-canvas-inset`：画布与窗口左/右/底边距（默认与顶栏下间距相同）
- `--um-workspace-inner-gap`：面板边框与内部内容间距（插件页默认 `12px`）
- `--um-workspace-bg`：工作区面板底色
- `--um-chrome-shadow` / `--um-workspace-shadow`：深浅色阴影强度

## 代码内标记

- HTML：`<!-- um-layer-chrome:START/END -->`、`data-um-layer="..."`
- CSS：`um-layer-*` 注释块
