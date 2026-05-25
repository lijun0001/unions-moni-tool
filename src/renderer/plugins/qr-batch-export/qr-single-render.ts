import QRCode from 'qrcode'
import type { QrStylePreset, SingleQrSettings } from './qr-single-types'

const STYLE_COLORS: Record<QrStylePreset, { dark: string; light: string }> = {
  basic: { dark: '#111111', light: '#ffffff' },
  brand: { dark: 'oklch(0.45 0.12 195)', light: '#ffffff' },
  inverted: { dark: '#ffffff', light: 'oklch(0.2 0.025 250)' },
}

export interface RenderSingleQrInput {
  content: string
  settings: SingleQrSettings
  label?: string
  logoDataUrl?: string | null
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('\u4e8c\u7ef4\u7801\u56fe\u7247\u52a0\u8f7d\u5931\u8d25'))
    img.src = src
  })
}

export async function renderSingleQr(input: RenderSingleQrInput): Promise<string> {
  const { content, settings, label, logoDataUrl } = input
  if (!content) throw new Error('\u8bf7\u8f93\u5165\u5185\u5bb9')

  const colors = STYLE_COLORS[settings.style]
  const qrOpts: Record<string, unknown> = {
    width: settings.size,
    margin: settings.margin,
    errorCorrectionLevel: settings.errorLevel,
    color: colors,
  }
  if (settings.version > 0) qrOpts.version = settings.version

  let dataUrl = await QRCode.toDataURL(content, qrOpts)

  if (logoDataUrl) {
    dataUrl = await compositeLogo(dataUrl, logoDataUrl, settings.size)
  }

  const caption = label?.trim()
  if (caption) {
    dataUrl = await compositeLabel(dataUrl, caption, settings.size)
  }

  return dataUrl
}

async function compositeLogo(qrDataUrl: string, logoDataUrl: string, size: number): Promise<string> {
  const qrImg = await loadImage(qrDataUrl)
  const logoImg = await loadImage(logoDataUrl)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')

  ctx.drawImage(qrImg, 0, 0, size, size)
  const logoSize = Math.round(size * 0.22)
  const x = (size - logoSize) / 2
  const y = (size - logoSize) / 2
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x - 4, y - 4, logoSize + 8, logoSize + 8)
  ctx.drawImage(logoImg, x, y, logoSize, logoSize)
  return canvas.toDataURL('image/png')
}

async function compositeLabel(qrDataUrl: string, caption: string, qrSize: number): Promise<string> {
  const qrImg = await loadImage(qrDataUrl)
  const fontSize = Math.max(10, Math.round(qrSize * 0.05))
  const pad = Math.max(8, Math.round(qrSize * 0.04))

  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = `${fontSize}px system-ui, sans-serif`
  const textW = measure.measureText(caption).width
  const textBlockH = fontSize + pad * 2

  canvas.width = qrSize
  canvas.height = qrSize + textBlockH
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(qrImg, 0, 0, qrSize, qrSize)
  ctx.fillStyle = '#111111'
  ctx.font = `${fontSize}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(caption, qrSize / 2, qrSize + textBlockH / 2)
  return canvas.toDataURL('image/png')
}

export function downloadDataUrl(dataUrl: string, filename = 'qrcode.png') {
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = filename
  a.click()
}
