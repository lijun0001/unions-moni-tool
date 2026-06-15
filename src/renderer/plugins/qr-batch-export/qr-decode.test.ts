import { describe, expect, it } from 'vitest'
import { isImageFile } from './qr-decode'

describe('qr-decode', () => {
  it('accepts image mime types and common extensions', () => {
    expect(isImageFile(new File(['x'], 'a.png', { type: 'image/png' }))).toBe(true)
    expect(isImageFile(new File(['x'], 'a.jpg', { type: '' }))).toBe(true)
    expect(isImageFile(new File(['x'], 'a.JPEG', { type: '' }))).toBe(true)
    expect(isImageFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).toBe(false)
  })
})
