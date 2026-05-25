import { createCipheriv, createDecipheriv, createHmac, createHash } from 'node:crypto'

/**
 * 与附件 AESUtil.java 对齐：直接使用 UTF-8 原始字节作为 AES-128-CBC 的 Key/IV。
 * Java 侧要求 key 与 iv 均为 16 字节；这里显式校验，避免“截断/补零”导致双方报文不一致。
 */
function utf8Exact16(input: string, field: 'DataSecret' | 'DataSecretIV'): Buffer {
  const bytes = Buffer.from(String(input ?? ''), 'utf8')
  if (bytes.length !== 16) {
    throw new Error(`${field} must be exactly 16 bytes in UTF-8 for AES-128-CBC`)
  }
  return bytes
}

export function encryptDataJson(data: string, dataSecret: string, dataSecretIV: string): string {
  const key = utf8Exact16(dataSecret, 'DataSecret')
  const iv = utf8Exact16(dataSecretIV, 'DataSecretIV')
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  const enc = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()])
  return enc.toString('base64')
}

export function decryptDataBase64(b64: string, dataSecret: string, dataSecretIV: string): string {
  const key = utf8Exact16(dataSecret, 'DataSecret')
  const iv = utf8Exact16(dataSecretIV, 'DataSecretIV')
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const dec = Buffer.concat([decipher.update(Buffer.from(b64, 'base64')), decipher.final()])
  return dec.toString('utf8')
}

/** 签名：HMAC-MD5(SigSecret, M)，M = OperatorID + Data + TimeStamp + Seq（《充电部分接口文档》§4.4～4.6），输出大写十六进制 */
export function signEnvelope(
  operatorId: string,
  dataStr: string,
  timeStamp: string,
  seq: string,
  sigSecret: string,
): string {
  const msg = `${operatorId}${dataStr}${timeStamp}${seq}`
  return createHmac('md5', Buffer.from(sigSecret, 'utf8')).update(msg, 'utf8').digest('hex').toUpperCase()
}

/** 与对端返回的 Sig 比对（兼容大小写与首尾空白） */
export function normalizeSigHex(sig: string): string {
  return String(sig ?? '').trim().toUpperCase()
}

/**
 * 校验请求/响应 Sig：拼接顺序与 signEnvelope 一致；兼容 OperatorID 与信封字段细微差异。
 */
export function verifyEnvelopeSig(
  operatorId: string,
  dataStr: string,
  timeStamp: string,
  seq: string,
  sig: string,
  sigSecret: string,
): boolean {
  const norm = normalizeSigHex(sig)
  if (!norm || !/^[0-9A-F]{32}$/.test(norm)) return false
  const oid = String(operatorId ?? '').trim()
  const variants = oid ? [operatorId, oid] : [operatorId]
  const seen = new Set<string>()
  for (const o of variants) {
    if (seen.has(o)) continue
    seen.add(o)
    if (signEnvelope(o, dataStr, timeStamp, seq, sigSecret) === norm) return true
  }
  return false
}

export function md5HexUpper(s: string): string {
  return createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()
}
