import { markRaw } from 'vue'
import type { ProtocolSimulatorPlugin } from '@shared/plugin-contract'
import QrBatchMainView from './QrBatchMainView.vue'

export const meta = {
  id: 'qr-batch-export',
  name: '二维码批量生成导出',
  version: '1.0.0',
  description: 'Excel 批量生码导出、图片二维码解析',
}

export const homeCard = {
  title: '二维码批量生成导出',
  subtitle: 'Excel 批量生码、图片解析、含图导出',
  badge: 'QR',
}

export const MainView = markRaw(QrBatchMainView)

const plugin: ProtocolSimulatorPlugin = {
  meta,
  homeCard,
  MainView,
}

export default plugin
