import { describe, expect, it } from 'vitest'
import {
  decryptDataBase64,
  encryptDataJson,
  signEnvelope,
  validateCecAesSecretPair,
  verifyEnvelopeSig,
} from './cec-crypto'

describe('cec-crypto', () => {
  it('roundtrips AES data', () => {
    const secret = '1234567890123456'
    const iv = 'abcdefghijklmnop'
    const plain = '{"a":1}'
    const enc = encryptDataJson(plain, secret, iv)
    expect(decryptDataBase64(enc, secret, iv)).toBe(plain)
  })

  it('signEnvelope is stable', () => {
    const s = signEnvelope('OP1', 'DATA', '20260101120000', '0001', 'sigsecret')
    expect(s).toMatch(/^[0-9A-F]{32}$/)
  })

  it('verifyEnvelopeSig accepts lowercase Sig', () => {
    const sig = signEnvelope('OP1', 'DATA', '20260101120000', '0001', 'sigsecret')
    expect(verifyEnvelopeSig('OP1', 'DATA', '20260101120000', '0001', sig.toLowerCase(), 'sigsecret')).toBe(
      true,
    )
  })

  it('throws when AES key/iv are not exactly 16 utf8 bytes', () => {
    expect(() => encryptDataJson('{"a":1}', 'short', 'abcdefghijklmnop')).toThrow(/16 bytes/)
    expect(() => encryptDataJson('{"a":1}', '1234567890123456', 'short')).toThrow(/16 bytes/)
  })

  it('validateCecAesSecretPair returns message instead of throwing', () => {
    expect(validateCecAesSecretPair('1234567890123456', 'abcdefghijklmnop')).toBeNull()
    expect(validateCecAesSecretPair('short', 'abcdefghijklmnop')).toMatch(/16 bytes/)
  })
})
