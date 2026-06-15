import jsQR from 'jsqr'

/** 与 html5-qrcode 默认扫描区一致，避免 1px 容器导致缩放异常 */
export const QR_DECODE_HOST_ID = 'qr-batch-decode-host'

type DecodeVariant = { pad: number; scale: number; binarize: boolean }

/** 窄静区 / 低分辨率 / 边缘发虚的码图，按多种画布策略重试 */
const JSQR_VARIANTS: DecodeVariant[] = [
  { pad: 0, scale: 1, binarize: false },
  { pad: 24, scale: 1, binarize: false },
  { pad: 40, scale: 2, binarize: false },
  { pad: 48, scale: 3, binarize: true },
  { pad: 60, scale: 4, binarize: true },
]

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片加载失败'))
    }
    img.src = url
  })
}

function buildVariantCanvas(img: HTMLImageElement, variant: DecodeVariant): HTMLCanvasElement {
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const sw = Math.max(1, Math.round(w * variant.scale))
  const sh = Math.max(1, Math.round(h * variant.scale))
  const pad = variant.pad

  const canvas = document.createElement('canvas')
  canvas.width = sw + pad * 2
  canvas.height = sh + pad * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 Canvas 上下文')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingEnabled = variant.scale > 1
  if (variant.scale > 1) ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, pad, pad, sw, sh)

  if (variant.binarize) {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const d = imageData.data
    for (let i = 0; i < d.length; i += 4) {
      const gray = (d[i] + d[i + 1] + d[i + 2]) / 3
      const px = gray < 128 ? 0 : 255
      d[i] = px
      d[i + 1] = px
      d[i + 2] = px
      d[i + 3] = 255
    }
    ctx.putImageData(imageData, 0, 0)
  }

  return canvas
}

function decodeCanvasWithJsQR(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const { width, height } = canvas
  const imageData = ctx.getImageData(0, 0, width, height)
  const code = jsQR(imageData.data, width, height, { inversionAttempts: 'attemptBoth' })
  const text = code?.data?.trim()
  return text || null
}

/** jsQR：对窄静区、边缘发虚的实拍/截图二维码更稳 */
async function decodeWithJsQr(file: File): Promise<string | null> {
  const img = await loadImageFromFile(file)
  for (const variant of JSQR_VARIANTS) {
    const canvas = buildVariantCanvas(img, variant)
    const text = decodeCanvasWithJsQR(canvas)
    if (text) return text
  }
  return null
}

/** Chromium 原生 API（Electron 可用时作为补充） */
async function decodeWithBarcodeDetector(file: File): Promise<string | null> {
  type BarcodeDetectorCtor = new (options?: { formats: string[] }) => {
    detect(source: ImageBitmap): Promise<Array<{ rawValue?: string }>>
  }
  const BarcodeDetectorApi = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!BarcodeDetectorApi) return null

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    const detector = new BarcodeDetectorApi({ formats: ['qr_code'] })
    const codes = await detector.detect(bitmap)
    const text = codes[0]?.rawValue?.trim()
    return text || null
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

/** html5-qrcode 文件扫描（兜底） */
async function decodeWithHtml5Qrcode(file: File): Promise<string> {
  const host = document.getElementById(QR_DECODE_HOST_ID)
  if (!host) {
    throw new Error('解码容器未就绪，请刷新页面后重试')
  }

  const { Html5Qrcode } = await import('html5-qrcode')
  const scanner = new Html5Qrcode(QR_DECODE_HOST_ID)
  try {
    const text = await scanner.scanFile(file, true)
    if (!text?.trim()) throw new Error('未识别到二维码内容')
    return text.trim()
  } finally {
    try {
      scanner.clear()
    } catch {
      /* clear 在部分状态下可能抛错，忽略 */
    }
  }
}

/** 从图片文件解析二维码字符串 */
export async function decodeQrFromFile(file: File): Promise<string> {
  if (!(file instanceof File) || file.size <= 0) {
    throw new Error('无效的图片文件')
  }

  const jsQrText = await decodeWithJsQr(file)
  if (jsQrText) return jsQrText

  const nativeText = await decodeWithBarcodeDetector(file)
  if (nativeText) return nativeText

  return decodeWithHtml5Qrcode(file)
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
}
