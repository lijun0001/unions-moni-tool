## Why

玖行桩模拟插件拓扑画布在桩配置 **3～4 把枪** 时出现枪位、车辆、标签横向侵入邻桩列的严重重叠，导致无法辨认枪归属与操作目标。根因是「桩列等分网格」与「枪簇按数量撑宽」的布局模型矛盾。与此同时，多桩运维场景需要一种不依赖横向密度的 **列表视图**，与现有拓扑视图互补。需在保留全部既有交互（点桩侧栏、点车 VIN/启动、充电 HUD、费率气泡）的前提下，修复拓扑 P0 并交付可切换的列表视图。

## What Changes

- **拓扑布局一期（P0）**：按枪数动态计算列宽；枪数 ≥3 时枪位改为 2×2 网格；画布支持横向滚动；桩侧信息改为列内相对定位；多枪时缩小枪节点宽度。
- **双行枪位连线**：枪数 >2 时，分线改为「桩下短竖线 → 横总线 → 每枪竖线」拓扑样式。
- **列表视图（方案 C）**：在拓扑页面工具栏增加「拓扑 / 列表」切换；列表模式为左桩卡片列表 + 右枪位详区；与拓扑共用 `activePileId` 与侧栏四 Tab。
- **侧栏定位适配**：列表模式下侧栏固定贴右，避免沿用拓扑列比例定位错位。
- **视图偏好持久化**：`boardViewMode` 写入 localStorage，下次进入插件恢复。
- **设计文档同步**：将 `docs/玖行桩拓扑图多枪布局优化设计.md` 扩展为含列表视图与切换的完整需求说明。

## Capabilities

### New Capabilities

- `jx-topology-layout`: 拓扑画布多枪布局修复（动态列宽、双行枪位、横滑、连线与侧栏信息定位）
- `jx-board-list-view`: 拓扑/列表双视图切换与列表模式左右分栏 UI

### Modified Capabilities

- （无）本项目 `openspec/specs/` 尚无既有 capability 基线

## Impact

- **主要文件**：`src/renderer/plugins/jx-pile-simulator/JxMainView.vue`（样式与模板，可能拆出 `JxBoardList.vue` / `JxGunCluster.vue`）
- **状态**：新增 `boardViewMode`；复用 `topologyStore.activePileId`、`visiblePiles` 筛选逻辑
- **持久化**：可选 `useJxTopologyStore` 或独立 localStorage 键 `jx-board-view-mode`
- **文档**：`docs/玖行桩拓扑图多枪布局优化设计.md`、`docs/assets/*.png`
- **依赖**：无新 npm 包；不引入 G6
- **测试**：建议补充列宽计算与视图切换相关的轻量单测（可选）
