/** 导入行（Excel 解析后） */
export interface QrImportRow {
  rowIndex: number
  content: string
  caption: string
}

/** 生成结果行 */
export interface QrResultRow {
  rowIndex: number
  content: string
  caption: string
  /** PNG data URL，用于表格预览 */
  imageDataUrl: string
  /** PNG 二进制，用于 Excel 导出 */
  imagePng: Uint8Array
}

export const QR_PIXEL_SIZE_OPTIONS = [
  { label: '小 (128px)', value: 128 },
  { label: '中 (256px)', value: 256 },
  { label: '大 (384px)', value: 384 },
  { label: '特大 (512px)', value: 512 },
] as const

export const DEFAULT_QR_PIXEL_SIZE = 256

export const COL_CONTENT = '二维码信息'
export const COL_CAPTION = '文字描述'
export const COL_IMAGE = '二维码'
