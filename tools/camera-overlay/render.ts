import { mkdir } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import process from 'node:process'
import sharp from 'sharp'

const defaultInput = 'assets/camera-overlay/connection_problem.svg'
const defaultOutput = 'custom_components/hippos_toolbox/assets/connection_problem.png'

const input = resolve(process.argv[2] ?? defaultInput)
const output = resolve(process.argv[3] ?? defaultOutput)
const size = Number.parseInt(process.argv[4] ?? '512', 10)

if (extname(input).toLowerCase() !== '.svg') {
	throw new Error(`Expected an SVG input file, received: ${input}`)
}
if (!Number.isSafeInteger(size) || size < 16 || size > 4096) {
	throw new Error(`PNG size must be an integer from 16 to 4096, received: ${process.argv[4] ?? '512'}`)
}

await mkdir(dirname(output), { recursive: true })
await sharp(input, { density: 384 })
	.resize(size, size, {
		fit: 'contain',
		background: { r: 0, g: 0, b: 0, alpha: 0 },
	})
	.png()
	.toFile(output)

process.stdout.write(`Rendered ${input} to ${output} (${size}x${size})\n`)
