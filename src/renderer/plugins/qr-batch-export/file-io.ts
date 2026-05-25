/** 通过宿主 IPC 选择并读取 Excel */
export async function pickAndReadExcel(): Promise<ArrayBuffer | null> {
  const path = await window.unions.openExcelFileDialog()
  if (!path) return null
  const res = await window.unions.readBinaryFile(path)
  if (!res.ok) throw new Error(res.error)
  const raw = atob(res.base64)
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  return buf.buffer
}

/** 保存二进制 Excel */
export async function saveExcelBuffer(
  defaultFilename: string,
  buffer: ArrayBuffer,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  const base64 = btoa(binary)
  return window.unions.saveBinaryFile({ defaultFilename, base64 })
}
