import ExcelJS from 'exceljs'
import {
  COL_CAPTION,
  COL_CONTENT,
  COL_IMAGE,
  type QrImportRow,
  type QrResultRow,
} from './types'

const MAX_ROWS = 2000

function pngToBase64(png: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < png.length; i += chunk) {
    binary += String.fromCharCode(...png.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return ''
  if (typeof v === 'object' && v !== null && 'text' in v) {
    return String((v as { text?: string }).text ?? '').trim()
  }
  if (v instanceof Date) return v.toISOString()
  return String(v).trim()
}

function findHeaderRow(sheet: ExcelJS.Worksheet): { headerRow: number; colContent: number; colCaption: number } {
  const maxScan = Math.min(5, sheet.rowCount || 5)
  for (let r = 1; r <= maxScan; r++) {
    const row = sheet.getRow(r)
    let colContent = 0
    let colCaption = 0
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value)
      if (t === COL_CONTENT) colContent = col
      if (t === COL_CAPTION) colCaption = col
    })
    if (colContent > 0) {
      if (colCaption === 0) throw new Error(`第 ${r} 行缺少「${COL_CAPTION}」列`)
      return { headerRow: r, colContent, colCaption }
    }
  }
  throw new Error(`未找到表头「${COL_CONTENT}」，请使用导出模板填写`)
}

export interface ParseImportResult {
  rows: QrImportRow[]
  skippedEmpty: number
  truncated: boolean
}

/** 从 xlsx 二进制解析导入数据 */
export async function parseImportWorkbook(buffer: ArrayBuffer): Promise<ParseImportResult> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer)
  const sheet = wb.worksheets[0]
  if (!sheet) throw new Error('Excel 中没有工作表')

  const { headerRow, colContent, colCaption } = findHeaderRow(sheet)
  const rows: QrImportRow[] = []
  let skippedEmpty = 0
  let truncated = false

  const lastRow = sheet.rowCount || headerRow
  for (let r = headerRow + 1; r <= lastRow; r++) {
    const row = sheet.getRow(r)
    const content = cellText(row.getCell(colContent).value)
    const caption = cellText(row.getCell(colCaption).value)
    if (!content && !caption) continue
    if (!content) {
      skippedEmpty++
      continue
    }
    if (rows.length >= MAX_ROWS) {
      truncated = true
      break
    }
    rows.push({ rowIndex: r, content, caption })
  }

  if (rows.length === 0 && skippedEmpty === 0) {
    throw new Error('未解析到有效数据行，请检查 Excel 内容')
  }

  return { rows, skippedEmpty, truncated }
}

/** 生成空白导入模板 */
export async function buildTemplateWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('导入数据')
  sheet.columns = [
    { header: COL_CONTENT, key: 'content', width: 40 },
    { header: COL_CAPTION, key: 'caption', width: 24 },
  ]
  sheet.addRow({
    content: 'https://example.com/charge?code=ABC123',
    caption: '示例：1号枪',
  })
  const header = sheet.getRow(1)
  header.font = { bold: true }
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>
}

/** 导出含图片的结果表 */
export async function buildResultWorkbook(results: QrResultRow[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('生成结果')
  sheet.columns = [
    { header: COL_CONTENT, key: 'content', width: 42 },
    { header: COL_CAPTION, key: 'caption', width: 22 },
    { header: COL_IMAGE, key: 'image', width: 18 },
  ]
  const header = sheet.getRow(1)
  header.font = { bold: true }

  for (let i = 0; i < results.length; i++) {
    const item = results[i]!
    const excelRow = sheet.addRow({
      content: item.content,
      caption: item.caption,
    })
    const rowNumber = excelRow.number
    excelRow.height = 100

    const imageId = wb.addImage({
      base64: pngToBase64(item.imagePng),
      extension: 'png',
    })
    sheet.addImage(imageId, {
      tl: { col: 2.15, row: rowNumber - 1 + 0.08 },
      ext: { width: 96, height: 96 },
    })
  }

  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>
}
