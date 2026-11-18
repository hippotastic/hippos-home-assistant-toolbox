#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { BLUEPRINT_DIRECTORY, parseCatalog, serializeCatalog, synchronizedCatalog, validateCatalogCompatibility } from './catalog.ts'

type Mode = 'check' | 'sync'

const catalogPathInRepo = `${BLUEPRINT_DIRECTORY}/catalog.json`

function usage(): string {
	return `Usage: node tools/blueprint-catalog/cli.ts <sync|check> [--base GIT_REF]\n`
}

function baseCatalog(repoRoot: string, reference: string): ReturnType<typeof parseCatalog> {
	let error = ''
	// Existing branches and releases store the same catalog at the repository root.
	for (const path of [catalogPathInRepo, 'blueprints/catalog.json']) {
		const result = spawnSync('git', ['show', `${reference}:${path}`], { cwd: repoRoot, encoding: 'utf8' })
		if (result.error) throw result.error
		if (result.status === 0) return parseCatalog(result.stdout, `${reference}:${path}`)
		error = result.stderr.trim()
	}

	throw new Error(`Unable to read blueprint catalog from ${reference}: ${error}`)
}

function main(): void {
	const mode = process.argv[2] as Mode | undefined
	if (mode !== 'sync' && mode !== 'check') {
		process.stderr.write(usage())
		process.exit(2)
	}

	let baseReference: string | undefined
	for (let index = 3; index < process.argv.length; index += 1) {
		if (process.argv[index] !== '--base' || !process.argv[index + 1]) {
			throw new Error(`Unknown or incomplete argument: ${process.argv[index]}`)
		}
		baseReference = process.argv[index + 1]
		index += 1
	}

	if (mode === 'sync' && baseReference) {
		throw new Error('--base is only supported in check mode')
	}

	const toolDirectory = dirname(fileURLToPath(import.meta.url))
	const repoRoot = join(toolDirectory, '..', '..')
	const catalogPath = join(repoRoot, catalogPathInRepo)
	const source = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : undefined
	const current = source === undefined ? undefined : parseCatalog(source, catalogPath)
	const expectedSource = serializeCatalog(synchronizedCatalog(repoRoot, current))

	if (mode === 'sync') {
		if (source === expectedSource) {
			process.stdout.write('Blueprint catalog is already up to date.\n')
			return
		}

		writeFileSync(catalogPath, expectedSource, 'utf8')
		process.stdout.write(`Updated ${catalogPath}\n`)
		return
	}

	if (source === undefined || current === undefined) {
		throw new Error(`${catalogPath}: catalog is missing; run pnpm catalog:sync`)
	}

	if (source !== expectedSource) {
		throw new Error(`${catalogPath}: catalog is stale or not deterministically formatted; run pnpm catalog:sync`)
	}

	if (baseReference) {
		validateCatalogCompatibility(baseCatalog(repoRoot, baseReference), current)
	}

	process.stdout.write('Blueprint catalog is up to date.\n')
}

try {
	main()
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${message}\n`)
	process.exit(1)
}
