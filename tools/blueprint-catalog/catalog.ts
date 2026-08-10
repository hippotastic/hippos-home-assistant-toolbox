import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { parseDocument } from 'yaml'

export const CATALOG_SCHEMA_VERSION = 1
export const SUPPORTED_BLUEPRINT_DOMAINS = ['automation', 'script', 'template'] as const

export type BlueprintDomain = (typeof SUPPORTED_BLUEPRINT_DOMAINS)[number]

export type ActiveCatalogEntry = {
	domain: BlueprintDomain
	id: string
	name: string
	path: string
	sha256: string
	status: 'active'
}

export type DeprecatedCatalogEntry = {
	deprecated_message?: string
	domain: BlueprintDomain
	id: string
	name: string
	path: string
	replacement?: string
	sha256: string
	status: 'deprecated'
}

export type CatalogEntry = ActiveCatalogEntry | DeprecatedCatalogEntry

export type BlueprintCatalog = {
	blueprints: CatalogEntry[]
	schema_version: number
}

type ScannedBlueprint = {
	domain: BlueprintDomain
	name: string
	path: string
	sha256: string
}

const HOME_ASSISTANT_YAML_TAGS = [
	'!env_var',
	'!include',
	'!include_dir_list',
	'!include_dir_merge_list',
	'!include_dir_merge_named',
	'!include_dir_named',
	'!input',
	'!secret',
].map((tag) => ({
	tag,
	resolve: (value: string) => value,
}))

export function canonicalizeBlueprintContent(content: string): string {
	return content.replace(/\r\n?/g, '\n').replace(/^[ \t\n\f\v]+|[ \t\n\f\v]+$/g, '')
}

export function blueprintHash(content: string): string {
	return createHash('sha256').update(canonicalizeBlueprintContent(content), 'utf8').digest('hex')
}

function posixPath(path: string): string {
	return path.split(sep).join('/')
}

function yamlFiles(directory: string): string[] {
	if (!existsSync(directory)) {
		return []
	}

	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) {
				return yamlFiles(path)
			}

			return entry.isFile() && ['.yaml', '.yml'].includes(extname(entry.name)) ? [path] : []
		})
		.sort()
}

function parseBlueprint(source: string, path: string): { domain: BlueprintDomain; name: string } {
	const document = parseDocument(source, {
		customTags: HOME_ASSISTANT_YAML_TAGS,
		prettyErrors: true,
	})

	if (document.errors.length > 0) {
		throw new Error(`${path}: ${document.errors.map((error) => error.message).join('\n')}`)
	}

	const value: unknown = document.toJS()
	if (typeof value !== 'object' || value === null || !('blueprint' in value)) {
		throw new Error(`${path}: missing blueprint metadata`)
	}

	const blueprint = value.blueprint
	if (typeof blueprint !== 'object' || blueprint === null || !('name' in blueprint) || !('domain' in blueprint)) {
		throw new Error(`${path}: blueprint metadata must contain name and domain`)
	}

	if (typeof blueprint.name !== 'string' || blueprint.name.trim() === '') {
		throw new Error(`${path}: blueprint name must be a non-empty string`)
	}

	if (typeof blueprint.domain !== 'string' || !SUPPORTED_BLUEPRINT_DOMAINS.includes(blueprint.domain as BlueprintDomain)) {
		throw new Error(`${path}: unsupported blueprint domain ${String(blueprint.domain)}`)
	}

	return {
		domain: blueprint.domain as BlueprintDomain,
		name: blueprint.name,
	}
}

function scanBlueprints(repoRoot: string): ScannedBlueprint[] {
	const blueprintRoot = join(repoRoot, 'blueprints')
	const result: ScannedBlueprint[] = []

	for (const domain of SUPPORTED_BLUEPRINT_DOMAINS) {
		const domainRoot = join(blueprintRoot, domain)

		for (const file of yamlFiles(domainRoot)) {
			const source = readFileSync(file, 'utf8')
			const metadata = parseBlueprint(source, file)
			if (metadata.domain !== domain) {
				throw new Error(`${file}: declares domain ${metadata.domain}, but is stored in blueprints/${domain}`)
			}

			result.push({
				domain,
				name: metadata.name,
				path: posixPath(relative(repoRoot, file)),
				sha256: blueprintHash(source),
			})
		}
	}

	return result.sort((left, right) => left.path.localeCompare(right.path))
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateCatalogEntry(value: unknown, index: number): asserts value is CatalogEntry {
	if (!isRecord(value)) {
		throw new Error(`Catalog entry ${index} must be an object`)
	}

	for (const key of ['id', 'name', 'domain', 'path', 'sha256', 'status']) {
		if (typeof value[key] !== 'string' || value[key] === '') {
			throw new Error(`Catalog entry ${index} has an invalid ${key}`)
		}
	}

	if (!/^[a-z0-9_]+$/.test(value.id as string)) {
		throw new Error(`Catalog entry ${index} has an invalid id: ${String(value.id)}`)
	}

	if (!SUPPORTED_BLUEPRINT_DOMAINS.includes(value.domain as BlueprintDomain)) {
		throw new Error(`Catalog entry ${index} has an unsupported domain: ${String(value.domain)}`)
	}

	if (value.status !== 'active' && value.status !== 'deprecated') {
		throw new Error(`Catalog entry ${index} has an invalid status: ${String(value.status)}`)
	}

	if (
		!(value.path as string).startsWith(`blueprints/${value.domain as string}/`) ||
		!/^blueprints\/(automation|script|template)\/.+\.ya?ml$/.test(value.path as string) ||
		(value.path as string).split('/').includes('..')
	) {
		throw new Error(`Catalog entry ${index} has an unsafe path: ${String(value.path)}`)
	}

	if (!/^[a-f0-9]{64}$/.test(value.sha256 as string)) {
		throw new Error(`Catalog entry ${index} has an invalid SHA-256 hash`)
	}

	for (const key of ['deprecated_message', 'replacement']) {
		if (value[key] !== undefined && typeof value[key] !== 'string') {
			throw new Error(`Catalog entry ${index} has an invalid ${key}`)
		}
	}
}

export function parseCatalog(source: string, path = 'catalog.json'): BlueprintCatalog {
	let value: unknown

	try {
		value = JSON.parse(source)
	} catch (error) {
		throw new Error(`${path}: invalid JSON`, { cause: error })
	}

	if (!isRecord(value) || value.schema_version !== CATALOG_SCHEMA_VERSION || !Array.isArray(value.blueprints)) {
		throw new Error(`${path}: expected schema_version ${CATALOG_SCHEMA_VERSION} and a blueprints array`)
	}

	const entries: CatalogEntry[] = []
	for (const [index, entry] of value.blueprints.entries()) {
		validateCatalogEntry(entry, index)
		entries.push(entry)
	}
	validateCatalogRelationships(entries)

	return {
		blueprints: entries,
		schema_version: CATALOG_SCHEMA_VERSION,
	}
}

function validateCatalogRelationships(entries: CatalogEntry[]): void {
	const ids = new Set<string>()
	const paths = new Set<string>()

	for (const entry of entries) {
		if (ids.has(entry.id)) {
			throw new Error(`Duplicate catalog id: ${entry.id}`)
		}
		if (paths.has(entry.path)) {
			throw new Error(`Duplicate catalog path: ${entry.path}`)
		}

		ids.add(entry.id)
		paths.add(entry.path)
	}

	for (const entry of entries) {
		if (entry.status === 'deprecated' && entry.replacement !== undefined) {
			const replacement = entries.find((candidate) => candidate.id === entry.replacement)
			if (!replacement || replacement.status !== 'active') {
				throw new Error(`Deprecated blueprint ${entry.id} references non-active replacement ${entry.replacement}`)
			}
		}
	}
}

function idFromBlueprint(blueprint: ScannedBlueprint, usedIds: Set<string>): string {
	const domainPrefix = `blueprints/${blueprint.domain}/`
	const stem = blueprint.path.slice(domainPrefix.length, -extname(blueprint.path).length)
	const baseId = stem
		.replace(/[^a-z0-9]+/gi, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase()
	let id = baseId || basename(blueprint.path, extname(blueprint.path)).toLowerCase()
	let suffix = 2

	while (usedIds.has(id)) {
		id = `${baseId}_${suffix}`
		suffix += 1
	}

	return id
}

export function synchronizedCatalog(repoRoot: string, current?: BlueprintCatalog): BlueprintCatalog {
	const scanned = scanBlueprints(repoRoot)
	const scannedByPath = new Map(scanned.map((blueprint) => [blueprint.path, blueprint]))
	const existingEntries = current?.blueprints ?? []
	const usedIds = new Set(existingEntries.map((entry) => entry.id))
	const claimedPaths = new Set<string>()
	const entries: CatalogEntry[] = []

	for (const entry of existingEntries) {
		const blueprint = scannedByPath.get(entry.path)

		if (entry.status === 'deprecated') {
			if (blueprint) {
				throw new Error(`Deprecated blueprint ${entry.id} still exists at ${entry.path}`)
			}
			entries.push(entry)
			continue
		}

		if (!blueprint) {
			throw new Error(`Active blueprint ${entry.id} is missing at ${entry.path}; mark it deprecated before removing its file`)
		}

		claimedPaths.add(entry.path)
		entries.push({
			domain: blueprint.domain,
			id: entry.id,
			name: blueprint.name,
			path: blueprint.path,
			sha256: blueprint.sha256,
			status: 'active',
		})
	}

	for (const blueprint of scanned) {
		if (claimedPaths.has(blueprint.path)) {
			continue
		}

		const id = idFromBlueprint(blueprint, usedIds)
		usedIds.add(id)
		entries.push({
			domain: blueprint.domain,
			id,
			name: blueprint.name,
			path: blueprint.path,
			sha256: blueprint.sha256,
			status: 'active',
		})
	}

	entries.sort((left, right) => left.id.localeCompare(right.id))
	validateCatalogRelationships(entries)

	return {
		blueprints: entries,
		schema_version: CATALOG_SCHEMA_VERSION,
	}
}

export function serializeCatalog(catalog: BlueprintCatalog): string {
	return `${JSON.stringify(catalog, null, 2)}\n`
}

export function validateCatalogCompatibility(base: BlueprintCatalog, current: BlueprintCatalog): void {
	const currentById = new Map(current.blueprints.map((entry) => [entry.id, entry]))

	for (const baseEntry of base.blueprints) {
		const currentEntry = currentById.get(baseEntry.id)
		if (!currentEntry) {
			throw new Error(`Catalog entry ${baseEntry.id} was removed; retain it as a deprecated tombstone`)
		}

		if (currentEntry.domain !== baseEntry.domain) {
			throw new Error(`Catalog entry ${baseEntry.id} changed domain from ${baseEntry.domain} to ${currentEntry.domain}`)
		}

		if (currentEntry.path !== baseEntry.path) {
			throw new Error(`Catalog entry ${baseEntry.id} changed path from ${baseEntry.path} to ${currentEntry.path}`)
		}

		if (baseEntry.status === 'deprecated' && currentEntry.status !== 'deprecated') {
			throw new Error(`Deprecated catalog entry ${baseEntry.id} cannot become active again`)
		}
	}
}
