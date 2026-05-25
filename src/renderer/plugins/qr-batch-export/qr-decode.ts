const SCANNER_ID = 'qr-batch-decode-scanner'

type Html5QrcodeCtor = typeof import('html5-qrcode').Html5Qrcode
type Html5QrcodeInstance = InstanceType<Html5QrcodeCtor>

let scanner: Html5QrcodeInstance | null = null

async function getScanner(): Promise<Html5QrcodeInstance> {
  if (!scanner) {
    const { Html5Qrcode } = await import('html5-qrcode')
    let el = document.getElementById(SCANNER_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = SCANNER_ID
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      el.style.width = '1px'
      el.style.height = '1px'
      el.style.overflow = 'hidden'
      document.body.appendChild(el)
    }
    scanner = new Html5Qrcode(SCANNER_ID)
  }
  return scanner
}

/** 从图片文件解析二维码字符串 */
export async function decodeQrFromFile(file: File): Promise<string> {
  const s = await getScanner()
  const text = await s.scanFile(file, false)
  if (!text?.trim()) throw new Error('未识别到二维码内容')
  return text.trim()
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
}
