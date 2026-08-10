import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { blueprintHash, canonicalizeBlueprintContent, synchronizedCatalog, validateCatalogCompatibility } from '../../tools/blueprint-catalog/catalog.ts'

const temporaryDirectories: string[] = []

function temporaryRepo(): string {
	const directory = mkdtempSync(join(tmpdir(), 'blueprint-catalog.'))
	temporaryDirectories.push(directory)
	return directory
}

function writeBlueprint(repoRoot: string, domain: string, filename: string, name: string): string {
	const directory = join(repoRoot, 'blueprints', domain)
	mkdirSync(directory, { recursive: true })
	const path = join(directory, filename)
	writeFileSync(path, `blueprint:\n  name: ${name}\n  domain: ${domain}\n`, 'utf8')
	return path
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true })
	}
})

describe('canonicalizeBlueprintContent', () => {
	test('normalizes line endings and file boundary whitespace', () => {
		expect(canonicalizeBlueprintContent(' \t\r\nblueprint:\r\n  name: Test\r\n\r\n')).toBe('blueprint:\n  name: Test')
	})

	test('keeps whitespace inside the document significant', () => {
		expect(blueprintHash('value: one  \nnext: two')).not.toBe(blueprintHash('value: one\nnext: two'))
	})

	test('produces the same hash for equivalent file boundaries', () => {
		expect(blueprintHash('\nblueprint:\r\n  name: Test\r\n')).toBe(blueprintHash('blueprint:\n  name: Test'))
	})
})

describe('synchronizedCatalog', () => {
	test('adds discovered blueprints and refreshes their hashes', () => {
		const repoRoot = temporaryRepo()
		const path = writeBlueprint(repoRoot, 'automation', 'example.yaml', 'Example')
		const catalog = synchronizedCatalog(repoRoot)

		expect(catalog.blueprints).toEqual([
			expect.objectContaining({
				domain: 'automation',
				id: 'example',
				name: 'Example',
				path: 'blueprints/automation/example.yaml',
				sha256: blueprintHash(readFileSync(path, 'utf8')),
				status: 'active',
			}),
		])
	})

	test('requires an active entry to be deprecated before its file is removed', () => {
		const repoRoot = temporaryRepo()
		writeBlueprint(repoRoot, 'automation', 'example.yaml', 'Example')
		const catalog = synchronizedCatalog(repoRoot)
		rmSync(join(repoRoot, 'blueprints', 'automation', 'example.yaml'))

		expect(() => synchronizedCatalog(repoRoot, catalog)).toThrow(/mark it deprecated/)
	})

	test('retains a deprecated tombstone after its source file is removed', () => {
		const repoRoot = temporaryRepo()
		writeBlueprint(repoRoot, 'automation', 'example.yaml', 'Example')
		const catalog = synchronizedCatalog(repoRoot)
		const entry = catalog.blueprints[0]
		catalog.blueprints[0] = { ...entry, status: 'deprecated', deprecated_message: 'Use another blueprint.' }
		rmSync(join(repoRoot, 'blueprints', 'automation', 'example.yaml'))

		expect(synchronizedCatalog(repoRoot, catalog)).toEqual(catalog)
	})
})

describe('validateCatalogCompatibility', () => {
	test('allows an active entry to become a deprecated tombstone', () => {
		const repoRoot = temporaryRepo()
		writeBlueprint(repoRoot, 'automation', 'example.yaml', 'Example')
		const base = synchronizedCatalog(repoRoot)
		const current = structuredClone(base)
		current.blueprints[0] = { ...current.blueprints[0], status: 'deprecated' }

		expect(() => validateCatalogCompatibility(base, current)).not.toThrow()
	})

	test('rejects removal of a catalog tombstone', () => {
		const repoRoot = temporaryRepo()
		writeBlueprint(repoRoot, 'automation', 'example.yaml', 'Example')
		const base = synchronizedCatalog(repoRoot)

		expect(() => validateCatalogCompatibility(base, { ...base, blueprints: [] })).toThrow(/retain it as a deprecated tombstone/)
	})
})
