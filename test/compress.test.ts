import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { compress } from '../src/index.ts'

// Deterministic high-entropy RGB noise (xorshift32) so the source is genuinely
// incompressible and encoded size varies with quality. No binary fixtures needed.
function noise(width: number, height: number): Buffer {
  const buffer = Buffer.allocUnsafe(width * height * 3)
  let state = 0x9e3779b9
  for (let i = 0; i < buffer.length; i++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    buffer[i] = state & 0xff
  }
  return buffer
}

async function makeImage(width = 512, height = 512): Promise<Buffer> {
  return sharp(noise(width, height), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

describe('compress', () => {
  it('encodes near the target size as jpeg by default', async () => {
    const image = await makeImage()
    const target = 100 * 1000

    const result = await compress(image, target, { maxAttempts: 12 })

    expect(result.size).toBeLessThan(image.length)
    expect(Math.abs(result.size - target)).toBeLessThan(target * 0.25)
    const meta = await sharp(result.data).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('honours the format option', async () => {
    const image = await makeImage()

    const result = await compress(image, 80 * 1000, { format: 'webp', maxAttempts: 12 })

    const meta = await sharp(result.data).metadata()
    expect(meta.format).toBe('webp')
  })

  it('treats a string target the same as the equivalent byte count', async () => {
    const image = await makeImage()

    // The `bytes` parser is binary: "100kb" == 100 * 1024.
    const fromString = await compress(image, '100kb', { maxAttempts: 12 })
    const fromNumber = await compress(image, 100 * 1024, { maxAttempts: 12 })

    expect(fromString.size).toBe(fromNumber.size)
    expect(fromString.quality).toBe(fromNumber.quality)
  })

  it('keeps top quality when the input already fits (early exit)', async () => {
    const image = await makeImage(64, 64)
    const smallJpeg = await sharp(image).jpeg({ quality: 80 }).toBuffer()

    const result = await compress(smallJpeg, smallJpeg.length * 10)

    expect(result.quality).toBe(95)
    const meta = await sharp(result.data).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('returns a best-effort result when the target is unreachable', async () => {
    const image = await makeImage()

    const result = await compress(image, 500, { maxAttempts: 6 })

    expect(result.size).toBeGreaterThan(0)
    expect(result.quality).toBeGreaterThanOrEqual(40)
    expect(result.quality).toBeLessThanOrEqual(95)
  })

  it('rejects an unparseable target', async () => {
    const image = await makeImage(32, 32)

    await expect(compress(image, 'not-a-size')).rejects.toThrow()
    await expect(compress(image, -100)).rejects.toThrow()
  })
})
