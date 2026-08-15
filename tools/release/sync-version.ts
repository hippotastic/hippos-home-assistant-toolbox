import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

function readJsonObject(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object`)
	}
	return value as Record<string, unknown>
}

export function syncIntegrationVersion(packagePath: string, manifestPath: string): void {
	const packageMetadata = readJsonObject(packagePath)
	const manifest = readJsonObject(manifestPath)

	if (typeof packageMetadata.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageMetadata.version)) {
		throw new Error(`package.json contains an invalid release version: ${String(packageMetadata.version)}`)
	}

	manifest.version = packageMetadata.version
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

if (import.meta.main) {
	const repositoryRoot = resolve(import.meta.dirname, '../..')
	syncIntegrationVersion(resolve(repositoryRoot, 'package.json'), resolve(repositoryRoot, 'custom_components/hippos_toolbox/manifest.json'))
}
