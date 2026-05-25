import QRCode from 'qrcode'

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? ''
  const raw = atob(base64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  const chars = [...trimmed]
  const lines: string[] = []
  let line = ''
  for (const ch of chars) {
    const next = line + ch
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line)
      line = ch
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

/** 生成带可选底部说明的二维码 PNG（data URL + 二进制） */
export async function renderQrWithCaption(
  content: string,
  caption: string | undefined,
  pixelSize: number,
): Promise<{ dataUrl: string; png: Uint8Array }> {
  const qrDataUrl = await QRCode.toDataURL(content, {
    width: pixelSize,
    margin: 2,
    errorCorrectionLevel: 'M',
  })

  const hasCaption = Boolean(caption?.trim())
  if (!hasCaption) {
    const png = dataUrlToUint8Array(qrDataUrl)
    return { dataUrl: qrDataUrl, png }
  }

  const qrImg = await loadImage(qrDataUrl)
  const fontSize = Math.max(10, Math.round(pixelSize * 0.047))
  const padX = Math.max(8, Math.round(pixelSize * 0.06))
  const padTop = Math.max(6, Math.round(pixelSize * 0.04))
  const lineGap = Math.round(fontSize * 0.35)

  const measureCanvas = document.createElement('canvas')
  const measureCtx = measureCanvas.getContext('2d')
  if (!measureCtx) throw new Error('无法创建 Canvas 上下文')
  measureCtx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`
  const maxTextWidth = pixelSize - padX * 2
  const lines = wrapLines(measureCtx, caption!.trim(), maxTextWidth)
  const textBlockHeight =
    lines.length > 0 ? lines.length * fontSize + (lines.length - 1) * lineGap : 0
  const textAreaHeight = textBlockHeight > 0 ? padTop + textBlockHeight + padTop : 0

  const canvas = document.createElement('canvas')
  canvas.width = pixelSize
  canvas.height = pixelSize + textAreaHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建 Canvas 上下文')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(qrImg, 0, 0, pixelSize, pixelSize)

  if (lines.length > 0) {
    ctx.fillStyle = '#111111'
    ctx.font = `${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    let y = pixelSize + padTop
    for (const line of lines) {
      ctx.fillText(line, pixelSize / 2, y)
      y += fontSize + lineGap
    }
  }

  const dataUrl = canvas.toDataURL('image/png')
  return { dataUrl, png: dataUrlToUint8Array(dataUrl) }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('二维码图片加载失败'))
    img.src = src
  })
}
