import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { syncIntegrationVersion } from '../../tools/release/sync-version.ts'

describe('release version', () => {
	test('keeps the root package and Home Assistant integration versions synchronized', () => {
		const repositoryRoot = resolve(import.meta.dirname, '../..')
		const packageMetadata = readJson(resolve(repositoryRoot, 'package.json'))
		const manifest = readJson(resolve(repositoryRoot, 'custom_components/hippos_toolbox/manifest.json'))

		expect(manifest.version).toBe(packageMetadata.version)
	})

	test('copies a release version into the integration manifest', () => {
		const directory = mkdtempSync(join(tmpdir(), 'hippos-toolbox-release-version.'))
		const packagePath = join(directory, 'package.json')
		const manifestPath = join(directory, 'manifest.json')

		try {
			writeFileSync(packagePath, '{"version":"1.2.3"}\n', 'utf8')
			writeFileSync(manifestPath, '{"domain":"example","version":"1.2.2"}\n', 'utf8')

			syncIntegrationVersion(packagePath, manifestPath)

			expect(readJson(manifestPath)).toEqual({ domain: 'example', version: '1.2.3' })
		} finally {
			rmSync(directory, { force: true, recursive: true })
		}
	})
})

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}
