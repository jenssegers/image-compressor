#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import bytes from 'bytes'
import { Command, Option } from 'commander'
import pc from 'picocolors'
import { glob } from 'tinyglobby'
import { type CompressFormat, compress } from './index.ts'

const EXTENSION: Record<CompressFormat, string> = {
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  png: 'png',
}

interface CliOptions {
  target: string
  format: CompressFormat
  out?: string
}

function formatBytes(byteCount: number): string {
  return bytes.format(byteCount, { unitSeparator: '', decimalPlaces: 1 }) ?? `${byteCount}b`
}

const RESET = '\x1b[0m'
const TRUECOLOR = /truecolor|24bit/.test(process.env.COLORTERM ?? '')
const GRADIENT_START = [168, 85, 247] as const // #a855f7
const GRADIENT_END = [124, 58, 237] as const // #7c3aed
const SHIMMER = [233, 221, 255] as const // bright lavender highlight

type Rgb = readonly [number, number, number]

function mix(a: Rgb, b: Rgb, t: number): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ]
}

const fg = (r: number, g: number, b: number): string => `\x1b[38;2;${r};${g};${b}m`

// A live purple progress bar with a blank spacer line pinned directly above it
// (a two-line footer). Finished-file result lines scroll above the footer; a
// shimmer highlight travels across the filled portion. When stdout is not a TTY
// (pipe/CI) everything degrades to plain println output.
function createProgress(total: number) {
  const tty = Boolean(process.stdout.isTTY) && total > 0
  const FOOTER_HEIGHT = 2 // blank spacer line + bar line
  let current = 0
  let label = ''
  let phase = 0
  let rendered = false
  let timer: ReturnType<typeof setInterval> | undefined

  const barLine = (final: boolean): string => {
    const columns = process.stdout.columns ?? 80
    const width = Math.max(10, Math.min(30, columns - 52))
    const filled = Math.round((total === 0 ? 1 : current / total) * width)
    const head = final ? -1 : phase % (width + 8)

    let bar = ''
    for (let i = 0; i < width; i++) {
      if (i >= filled) {
        bar += `\x1b[38;5;238m░`
        continue
      }
      if (TRUECOLOR) {
        const base = mix(GRADIENT_START, GRADIENT_END, width <= 1 ? 0 : i / (width - 1))
        const distance = Math.abs(i - head)
        const color: Rgb =
          distance === 0 ? SHIMMER : distance === 1 ? mix(base, SHIMMER, 0.45) : base
        bar += `${fg(color[0], color[1], color[2])}█`
      } else {
        bar += `${i === head ? '\x1b[97m' : '\x1b[95m'}█`
      }
    }

    const statusText = final ? 'compressed ' : 'compressing'
    const percent = String(Math.round((total === 0 ? 1 : current / total) * 100)).padStart(3)
    const count = `${current}/${total}`
    // Keep the bar line within one terminal row so the cursor math stays correct.
    const fixed = 2 + statusText.length + 1 + width + 1 + 4 + 2 + count.length
    const room = columns - fixed - 3
    let name = final ? '' : label
    if (name.length > room) name = room > 1 ? `…${name.slice(-(room - 1))}` : ''
    const trailer = name === '' ? '' : `  ${pc.dim(name)}`
    return `  ${pc.dim(statusText)} ${bar}${RESET} ${percent}%  ${pc.dim(count)}${trailer}`
  }

  // Move the cursor to the top line of the footer (the blank spacer).
  const toFooterTop = (): void => {
    process.stdout.write(rendered ? `\x1b[${FOOTER_HEIGHT - 1}A\r` : '\r')
    rendered = true
  }

  // Paint the footer (blank spacer line, then the bar) from the current line down.
  const paintFooter = (final: boolean): void => {
    process.stdout.write(`\x1b[2K\n\x1b[2K${barLine(final)}`)
  }

  const draw = (final = false): void => {
    if (!tty) return
    toFooterTop()
    paintFooter(final)
  }

  const onSigint = (): void => {
    if (timer) clearInterval(timer)
    if (rendered) process.stdout.write('\r\x1b[2K\x1b[1A\r\x1b[2K')
    process.stdout.write('\x1b[?25h')
    process.exit(130)
  }

  return {
    start(): void {
      if (!tty) return
      process.stdout.write('\x1b[?25l') // hide cursor
      process.on('SIGINT', onSigint)
      timer = setInterval(() => {
        phase += 1
        draw()
      }, 90)
      draw()
    },
    setLabel(text: string): void {
      label = text
      draw()
    },
    tick(): void {
      current += 1
      draw()
    },
    // Print a finished-file line above the footer (or plainly when not a TTY).
    log(text: string): void {
      if (!tty) {
        console.log(text)
        return
      }
      toFooterTop()
      process.stdout.write(`\x1b[2K${text}\n`)
      paintFooter(false)
    },
    // Persist the completed 100% bar (no shimmer) with its spacer line.
    finish(): void {
      if (!tty) return
      if (timer) clearInterval(timer)
      process.off('SIGINT', onSigint)
      draw(true)
      process.stdout.write('\n\x1b[?25h') // move below the bar, show cursor
    },
  }
}

async function run(patterns: string[], options: CliOptions): Promise<void> {
  const files = await glob(patterns, { expandDirectories: false })
  if (files.length === 0) {
    throw new Error(`No files matched: ${patterns.join(', ')}`)
  }

  let failures = 0
  let totalInput = 0
  let totalOutput = 0

  const progress = createProgress(files.length)
  progress.start()
  try {
    for (const file of files) {
      progress.setLabel(file)
      try {
        const input = await readFile(file)
        const result = await compress(input, options.target, { format: options.format })

        const name = basename(file, extname(file))
        const outputPath = options.out
          ? join(options.out, `${name}.${EXTENSION[options.format]}`)
          : join(dirname(file), `${name}.compressed.${EXTENSION[options.format]}`)
        await mkdir(dirname(outputPath), { recursive: true })
        await writeFile(outputPath, result.data)

        totalInput += input.length
        totalOutput += result.size
        const saved = Math.round((1 - result.size / input.length) * 100)
        progress.log(
          `${pc.cyan(file)}  ${formatBytes(input.length)} ${pc.dim('->')} ${pc.green(formatBytes(result.size))}  ${pc.dim(`(-${saved}%)`)}  ${pc.magenta(`q${result.quality}`)}`,
        )
      } catch (error) {
        failures += 1
        progress.log(`${pc.red('failed')} ${file}: ${(error as Error).message}`)
      }
      progress.tick()
    }
  } finally {
    progress.finish()
  }

  const done = files.length - failures
  if (done > 0) {
    const saved = Math.round((1 - totalOutput / totalInput) * 100)
    console.log(
      pc.bold(
        `\n${done} image${done === 1 ? '' : 's'}  ${formatBytes(totalInput)} -> ${formatBytes(totalOutput)}  (-${saved}%)`,
      ),
    )
  }
  if (failures > 0) {
    process.exitCode = 1
  }
}

const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

const program = new Command()
program
  .name('image-compressor')
  .description('Compress images toward a target file size.')
  .version(version, '-v, --version')
  .argument('<files...>', 'image files or globs to compress')
  .requiredOption('-t, --target <size>', 'target size, e.g. 200kb, 1.5mb')
  .addOption(
    new Option('-f, --format <format>', 'output format')
      .choices(['jpeg', 'webp', 'avif', 'png'])
      .default('jpeg'),
  )
  .option(
    '-o, --out <dir>',
    'output directory (default: alongside each source as <name>.compressed.<ext>)',
  )
  .action(run)

program.parseAsync().catch((error: unknown) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)))
  process.exit(1)
})
