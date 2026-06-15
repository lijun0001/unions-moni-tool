## 1. 文档与设计对齐

- [x] 1.1 将 `docs/玖行桩拓扑图多枪布局优化设计.md` 升级为 v0.2（含列表视图 §12、切换交互、验收项）
- [x] 1.2 确认 `docs/assets/jx-topology-*.png` 示意图与文案一致

## 2. 拓扑布局 P0（jx-topology-layout）

- [x] 2.1 实现 `pileColumnWidth(pile)` 计算函数，替换 `topologyColumns` 等分 `1fr` 逻辑
- [x] 2.2 `jx-board` / `jx-topology` / `jx-car-strip` 支持 `overflow-x: auto` 与 `width: max-content; min-width: 100%`
- [x] 2.3 枪数 ≥3 时 `jx-gun-list` 改为 2 列 CSS Grid（2×2），并设置 `--jx-gun-node-width: 80px`
- [x] 2.4 调整 `jx-pile-left-info` 为列内相对定位，避免侵入邻列
- [x] 2.5 多枪分线样式：桩下短竖线 → 横总线 → 各枪竖线（更新 `jx-car-bus-line` 等）
- [x] 2.6 手动验收：4 桩 × 4 枪、3 桩 × 4 枪 + 2 枪混合场景无重叠

## 3. 枪簇组件抽取（可选但推荐）

- [x] 3.1 新建 `JxGunCluster.vue`，迁移枪列表、车辆、HUD、VIN 气泡、启动入口
- [x] 3.2 拓扑 `jx-car-strip` 改用 `JxGunCluster`（`layout=grid|row`）
- [x] 3.3 确认所有 `handleCarClick` / `openStartControlDialog` 等回调行为不变

## 4. 列表视图（jx-board-list-view）

- [x] 4.1 新增 `boardViewMode: 'topology' | 'list'` 与 localStorage 读写（`jx-board-view-mode`）
- [x] 4.2 工具栏增加「拓扑 | 列表」分段切换控件
- [x] 4.3 实现 `jx-board-list`：左栏桩卡片列表（ID、状态、枪数、充电摘要、选中高亮）
- [x] 4.4 实现右栏详区：桩头摘要 + `JxGunCluster`（grid 布局，宽松间距）
- [x] 4.5 列表模式添加桩入口（与拓扑 `+` 等价）
- [x] 4.6 列表模式侧栏 `jx-panel` 使用固定贴右样式（`jx-panel--list-mode`）
- [x] 4.7 视图切换 `v-show` 保留 DOM；切换时保持 `activePileId`

## 5. 交互与空状态

- [x] 5.1 列表卡片单击选中桩并打开侧栏；双击离线桩触发登录
- [x] 5.2 列表卡片/详区支持费率 ¥ 气泡与链接登录（与拓扑一致）
- [x] 5.3 无桩 / 筛选为空 / 未选中桩的空状态文案
- [x] 5.4 侧栏打开时右详区不被完全遮挡（预留宽度或自适应）

## 6. 验证

- [x] 6.1 拓扑模式：充电 HUD 实时刷新、VIN 气泡、启动控制/充电信息弹窗正常
- [x] 6.2 列表模式：同上交互路径全部可用
- [x] 6.3 视图偏好刷新页面后仍保留
- [x] 6.4 运行 `npm test` 与 `vue-tsc --noEmit` 通过
- [x] 6.5 （可选）为 `pileColumnWidth` 添加单元测试

## 7. 收尾

- [x] 7.1 更新 OpenSpec change 状态并准备 `/opsx:apply` 实施
- [x] 7.2 PR 描述引用 `openspec/changes/jx-topology-layout-list-view/` 与更新后的设计文档
