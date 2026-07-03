import bytes from 'bytes'
import sharp from 'sharp'

type SharpInstance = ReturnType<typeof sharp>

/** Accepts the same input as the `sharp()` constructor: a file path, Buffer, or typed array. */
export type CompressInput = Parameters<typeof sharp>[0]

/** Options forwarded verbatim to the `sharp()` constructor (density, pages, failOn, ...). */
export type SharpConstructorOptions = NonNullable<Parameters<typeof sharp>[1]>

/** A byte count, or a human-readable size such as `"2mb"` or `"200kb"` (`"kb"` is binary, 1024). */
export type Target = number | string

export type CompressFormat = 'jpeg' | 'webp' | 'avif' | 'png'

export interface CompressOptions {
  /** Output format. Defaults to `'jpeg'`. */
  format?: CompressFormat
  /** Lowest quality the search may use (1-100). Defaults to 40. */
  minQuality?: number
  /** Highest quality the search may use (1-100). Defaults to 95. */
  maxQuality?: number
  /** Maximum number of encode probes before returning the closest result. Defaults to 6. */
  maxAttempts?: number
  /** Accept a result within this fraction of the target size. Defaults to 0.1 (10%). */
  tolerance?: number
  /** Options forwarded to the `sharp()` constructor. */
  sharp?: SharpConstructorOptions
}

export interface CompressResult {
  /** The encoded image bytes, ready to write to disk. */
  data: Buffer
  /** Size of `data` in bytes. */
  size: number
  /** The quality value used to produce `data`. */
  quality: number
}

const DEFAULTS = {
  format: 'jpeg',
  minQuality: 40,
  maxQuality: 95,
  maxAttempts: 6,
  tolerance: 0.1,
} as const

function encode(image: SharpInstance, format: CompressFormat, quality: number): SharpInstance {
  switch (format) {
    case 'jpeg':
      return image.jpeg({ quality, mozjpeg: true })
    case 'webp':
      return image.webp({ quality, effort: 4 })
    case 'avif':
      return image.avif({ quality, effort: 4 })
    case 'png':
      return image.png({ quality, palette: true })
  }
}

/**
 * Encode an image toward a target file size by binary-searching the output quality.
 *
 * The search stops as soon as an encode lands within `tolerance` of the target; if the
 * target cannot be reached within the quality range, the closest result is returned.
 *
 * @param input  Anything the `sharp()` constructor accepts (path, Buffer, typed array).
 * @param target Desired size in bytes, or a string like `"2mb"` or `"200kb"` (`"kb"` is binary, 1024).
 */
export async function compress(
  input: CompressInput,
  target: Target,
  options: CompressOptions = {},
): Promise<CompressResult> {
  // A byte count, or a human-readable size ("2mb", "200kb"); "kb" is binary (1024).
  const parsed = bytes.parse(target)
  if (parsed === null || !Number.isFinite(parsed) || parsed <= 0) {
    throw new TypeError(`Invalid target size: ${JSON.stringify(target)}`)
  }
  const targetBytes = Math.floor(parsed)

  const format = options.format ?? DEFAULTS.format
  const minQuality = options.minQuality ?? DEFAULTS.minQuality
  const maxQuality = options.maxQuality ?? DEFAULTS.maxQuality
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts
  const tolerance = options.tolerance ?? DEFAULTS.tolerance

  const lowerBound = targetBytes * (1 - tolerance)
  const upperBound = targetBytes * (1 + tolerance)

  // A sharp pipeline is single-use once executed, so re-open the input for each probe.
  const open = (): SharpInstance => sharp(input, options.sharp)

  // If the input is already in the target format and comfortably under the target,
  // keep the highest quality rather than re-compressing needlessly.
  const metadata = await open().metadata()
  if (
    metadata.format === format &&
    typeof metadata.size === 'number' &&
    metadata.size <= upperBound
  ) {
    const data = await encode(open(), format, maxQuality).toBuffer()
    return { data, size: data.length, quality: maxQuality }
  }

  let low = minQuality
  let high = maxQuality
  let quality = Math.round((low + high) / 2)
  let attempts = 0
  let best: CompressResult | undefined

  while (low <= high && attempts < maxAttempts) {
    const data = await encode(open(), format, quality).toBuffer()
    const size = data.length

    if (best === undefined || Math.abs(size - targetBytes) < Math.abs(best.size - targetBytes)) {
      best = { data, size, quality }
    }

    if (size >= lowerBound && size <= upperBound) {
      return { data, size, quality }
    }

    if (size > upperBound) {
      high = quality - 1
    } else {
      low = quality + 1
    }

    quality = Math.round((low + high) / 2)
    attempts += 1
  }

  if (best === undefined) {
    const data = await encode(open(), format, minQuality).toBuffer()
    best = { data, size: data.length, quality: minQuality }
  }

  return best
}
