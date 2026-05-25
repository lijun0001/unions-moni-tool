import { markRaw } from 'vue'
import type { ProtocolSimulatorPlugin } from '@shared/plugin-contract'
import JxMainView from './JxMainView.vue'

export const meta = {
  id: 'jx-pile-simulator',
  name: '玖行电桩模拟',
  version: '1.0.0',
  description: 'TCP 协议模拟、拓扑、流程编排与日志',
}

export const homeCard = {
  title: '玖行电桩模拟',
  subtitle: '协议导入、流程执行、拓扑与日志',
  badge: 'JX',
}

export const MainView = markRaw(JxMainView)

const plugin: ProtocolSimulatorPlugin = {
  meta,
  homeCard,
  MainView,
}

export default plugin

