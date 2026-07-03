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

async function run(patterns: string[], options: CliOptions): Promise<void> {
  const files = await glob(patterns, { expandDirectories: false })
  if (files.length === 0) {
    throw new Error(`No files matched: ${patterns.join(', ')}`)
  }

  let failures = 0
  let totalInput = 0
  let totalOutput = 0

  for (const file of files) {
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
      console.log(
        `${pc.cyan(file)}  ${formatBytes(input.length)} ${pc.dim('->')} ${pc.green(formatBytes(result.size))}  ${pc.dim(`(-${saved}%)`)}  ${pc.magenta(`q${result.quality}`)}`,
      )
    } catch (error) {
      failures += 1
      console.error(`${pc.red('failed')} ${file}: ${(error as Error).message}`)
    }
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
