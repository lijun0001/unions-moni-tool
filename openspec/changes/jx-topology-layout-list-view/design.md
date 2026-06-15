## Context

玖行桩模拟插件主界面 `JxMainView.vue` 使用双层 CSS Grid（`jx-topology` + `jx-car-strip`）展示协议→桩→枪→车拓扑。列定义 `repeat(N, minmax(92px, 1fr))` 与枪簇 `width: fit-content`（每枪 ~100px）冲突，3～4 枪时溢出邻列。侧栏 `jx-panel` 通过 `drawerLeftStyle` 按桩列索引定位。

参考：`docs/玖行桩拓扑图多枪布局优化设计.md`、`docs/assets/jx-topology-*.png`。

## Goals / Non-Goals

**Goals:**

- 消除拓扑模式 3～4 枪 P0 重叠
- 交付工具栏「拓扑 / 列表」切换及列表左右分栏 UI
- 复用现有 store、事件处理与侧栏，避免重复业务逻辑
- 列表模式侧栏定位正确；视图偏好可持久化

**Non-Goals:**

- 不引入 AntV G6 或 pan/zoom 画布
- 不重构侧栏四 Tab 内容
- 不改变 `visiblePiles` 10 桩上限与筛选规则
- 不做移动端专属布局（仅保证 <1024px 可横滑或切列表）

## Decisions

### D1: 一期拓扑修复采用 A+B 组合

**决定**：动态列宽 + 枪数≥3 时 2×2 网格 + `overflow-x: auto`。

**理由**：改动集中在 `topologyColumns` 计算与 CSS，保留现有 DOM 与交互；比纯缩放或折叠枪更贴合「全览」诉求。

**备选**：仅列表视图规避重叠——不解决默认拓扑体验。

### D2: 列宽计算公式

**决定**：

```text
base = gunCount <= 2 ? 220 : 200  // 双行时列宽上限更低
colWidth(pile) = base + (min(gunCount, 4) - 1) * compactNodeWidth + gaps
// 或简化：gunCount 2→220, 3→200(2col), 4→220(2x2)
```

实现时用 computed `topologyColumns` 返回 `repeat` 各列 `minmax(px, px)` 或显式 `grid-template-columns: 220px 220px 240px ...`。

### D3: 枪簇组件抽取（推荐）

**决定**：将 `jx-gun-list` 及其子树（枪行、车按钮、HUD、VIN pop）抽为 `JxGunCluster.vue`，props: `pile`, `layout: 'row' | 'grid'`, `density: 'normal' | 'compact'`。

**理由**：拓扑单列与列表右侧详区共用，避免双份模板漂移。

### D4: 列表视图结构

**决定**：`jx-board` 内 `v-show` 切换两套子树：

- `jx-board-topology` — 现有内容（修复后）
- `jx-board-list` — `jx-list-rail` + `jx-list-detail`

不销毁 DOM，切换时保留 HUD 刷新与选中态。

### D5: 视图切换控件位置

**决定**：置于 `jx-toolbar` 的 `jx-toolbar-actions` 左侧，使用 `el-segmented` 或两个 `el-radio-button`：拓扑 | 列表。

### D6: 侧栏定位策略

**决定**：

- `topology`：`drawerLeftStyle` 保持现有列比例算法
- `list`：`left: auto; right: 12px`（或 `class="jx-panel--list-mode"`）

### D7: 持久化

**决定**：`localStorage.setItem('jx-board-view-mode', mode)` 于切换时写入；`onMounted` 读取。不写入 `useJxTopologyStore` 持久化 JSON，避免与桩数据耦合。

### D8: 列表右侧是否显示桩大图

**决定**：右侧 **仅显示紧凑桩头**（ID、状态、TCP 摘要一行）+ 枪网格，**不**重复大桩 SVG，节省垂直空间。桩大图语义由左卡片选中态表达。

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| `JxMainView.vue` 继续膨胀 | 抽出 `JxGunCluster`、`JxBoardList` |
| 双行连线 CSS 复杂 | 先用简化分支线，迭代对齐示意图 |
| 列表+侧栏同时打开过窄 | 侧栏打开时右详区 `max-width: calc(100% - 560px - 260px)` 或允许详区换行 |
| localStorage 与多窗口 | 单实例 Electron，可接受 |

## Migration Plan

1. 先合并拓扑布局 CSS/计算（无列表），验证 4×4 场景
2. 再添加列表视图与切换，默认仍为 topology
3. 更新 `docs/玖行桩拓扑图多枪布局优化设计.md` v0.2
4. 无数据迁移；无 API 变更

## Open Questions

- 列表模式侧栏打开时，右详区是否自动收窄（已实现预留）还是侧栏覆盖详区（当前拓扑行为）— **建议预留最小宽度**
- 是否在枪数≥3 且仍为拓扑模式时显示顶部「紧凑布局」提示 — **可选，tasks 标为 P2**
