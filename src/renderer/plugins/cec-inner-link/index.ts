import { markRaw } from 'vue'
import type { ProtocolSimulatorPlugin } from '@shared/plugin-contract'
import CecMainView from './CecMainView.vue'

export const meta = {
  id: 'cec-inner-link',
  name: '充电互联互通（内互联）模拟',
  version: '1.0.0',
  description: '中电联协议内互联 HTTP 模拟、站点与订单',
}

export const homeCard = {
  title: '充电互联互通（内互联）',
  subtitle: 'HTTP 服务平台、扫码模拟、站点与订单',
  badge: 'CEC',
}

/** 避免被 Pinia/reactive 代理成响应式组件对象 */
export const MainView = markRaw(CecMainView)

const plugin: ProtocolSimulatorPlugin = {
  meta,
  homeCard,
  MainView,
}

export default plugin
