import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildCameraFrontend } from './bundle.ts'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = `${root}custom_components/hippos_toolbox/frontend/cameras.js`
const content = await buildCameraFrontend()
if (process.argv.includes('--check')) {
	if ((await readFile(output, 'utf8').catch(() => '')) !== content) {
		throw new Error('Camera bundle is stale. Run pnpm frontend:build.')
	}
} else {
	await writeFile(output, content)
}
