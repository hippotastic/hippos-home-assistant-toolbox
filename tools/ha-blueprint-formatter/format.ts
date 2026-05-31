#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Mode = 'check' | 'write'

type Options = {
	mode: Mode
	watch: boolean
	failOnWarnings: boolean
	width: number
	paths: string[]
}

type FormatResult = {
	source: string
	warnings: Warning[]
}

type RunResult = {
	hasChanges: boolean
	hasWarnings: boolean
}

type Warning = {
	line: number
	message: string
	code: string
}

type MultilineCodeTag = {
	lines: string[]
	nextIndex: number
	collapsedLength?: number
}

const DEFAULT_WIDTH = 80
const JINJA_CODE_OPENERS = ['{%-', '{%']
const JINJA_COMMENT_OPENERS = ['{#-', '{#']
const JINJA_OUTPUT_OPENERS = ['{{']
const JINJA_OPENERS = [...JINJA_CODE_OPENERS, ...JINJA_COMMENT_OPENERS, ...JINJA_OUTPUT_OPENERS]

function usage(): string {
	return `Usage: pnpm format:blueprints [options] [paths...]

Options:
  --check         Check formatting without writing files.
  --write         Format files in-place. This is the default.
  --watch         Keep checking when blueprint files change.
  --fail-on-warnings
                  Exit with an error when formatter warnings are reported.
  --width WIDTH   Target width for Jinja tag contents. Defaults to ${DEFAULT_WIDTH}.
  -h, --help      Show this help.
`
}

function parseArgs(argv: string[]): Options {
	let mode: Mode = 'write'
	let watchMode = false
	let failOnWarnings = false
	let width = DEFAULT_WIDTH
	const paths: string[] = []

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]

		switch (arg) {
			case '--check':
				mode = 'check'
				break
			case '--write':
				mode = 'write'
				break
			case '--watch':
				mode = 'check'
				watchMode = true
				break
			case '--fail-on-warnings':
				failOnWarnings = true
				break
			case '--width': {
				const value = argv[index + 1]
				if (!value) {
					throw new Error('Missing value for --width')
				}
				width = Number(value)
				index += 1
				break
			}
			case '-h':
			case '--help':
				process.stdout.write(usage())
				process.exit(0)
				break
			default:
				paths.push(arg)
				break
		}
	}

	if (!Number.isInteger(width) || width < 40) {
		throw new Error(`Invalid --width value: ${width}`)
	}

	if (watchMode) {
		mode = 'check'
	}

	return {
		mode,
		watch: watchMode,
		failOnWarnings,
		width,
		paths,
	}
}

function blueprintFilesIn(directory: string): string[] {
	return readdirSync(directory)
		.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
		.sort()
		.map((file) => join(directory, file))
}

function defaultBlueprintFiles(): string[] {
	const toolDir = fileURLToPath(new URL('.', import.meta.url))
	const repoRoot = join(toolDir, '..', '..')
	return blueprintFilesIn(join(repoRoot, 'blueprints', 'automation'))
}

function leadingWhitespace(value: string): string {
	return value.match(/^\s*/)?.[0] ?? ''
}

function isBlockScalarHeader(line: string): boolean {
	return /^\s*[^#\s][^:]*:\s*>-?\s*(?:#.*)?$/.test(line)
}

function isJinjaLine(line: string): boolean {
	const trimmed = line.trimStart()
	return JINJA_OPENERS.some((opener) => trimmed.startsWith(opener))
}

function findBlockEnd(lines: string[], start: number): number {
	const headerIndent = leadingWhitespace(lines[start]).length
	let index = start + 1

	while (index < lines.length) {
		const line = lines[index]
		const trimmed = line.trim()

		if (trimmed !== '' && leadingWhitespace(line).length <= headerIndent) {
			break
		}

		index += 1
	}

	return index
}

function blockContentIndent(lines: string[], start: number, end: number): string | undefined {
	for (let index = start + 1; index < end; index += 1) {
		if (lines[index].trim() !== '') {
			return leadingWhitespace(lines[index])
		}
	}

	return undefined
}

function blockContainsFormattableJinja(lines: string[], start: number, end: number): boolean {
	for (let index = start + 1; index < end; index += 1) {
		const trimmed = lines[index].trimStart()

		if (JINJA_CODE_OPENERS.some((opener) => trimmed.startsWith(opener)) || JINJA_COMMENT_OPENERS.some((opener) => trimmed.startsWith(opener))) {
			return true
		}
	}

	return false
}

function wrapWords(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) {
		return [text]
	}

	const words = text.split(/\s+/)
	const lines: string[] = []
	let current = ''

	for (const word of words) {
		if (current === '') {
			current = word
			continue
		}

		if (`${current} ${word}`.length <= maxLength) {
			current = `${current} ${word}`
			continue
		}

		lines.push(current)
		current = word
	}

	if (current !== '') {
		lines.push(current)
	}

	return lines.length > 0 ? lines : ['']
}

function padTag(content: string, width: number, close: string): string {
	const body = content.slice(0, -close.length).trimEnd()
	const padding = Math.max(1, width - haDumpedLength(body) - close.length)
	return `${body}${' '.repeat(padding)}${close}`
}

function haDumpedLength(value: string): number {
	return value.length + [...value].filter((character) => character === "'").length
}

function formatLengthWarning(line: number, content: string, width: number): Warning {
	const dumpedLength = haDumpedLength(content)
	const singleQuoteCount = dumpedLength - content.length
	const quoteHint = singleQuoteCount > 0 ? `; single quotes add ${singleQuoteCount} characters after HA import` : ''

	return {
		line,
		message: `Jinja template content has HA-dumped length ${dumpedLength}, target is ${width}${quoteHint}`,
		code: 'ha-blueprint-format/line-length',
	}
}

function formatWarning(file: string, warning: Warning): string {
	return `${file}:${warning.line}: warning: ${warning.message} [${warning.code}]`
}

function notFormattedWarning(): Warning {
	return {
		line: 1,
		message: 'Blueprint formatting differs; run pnpm format:blueprints to update this file',
		code: 'ha-blueprint-format/not-formatted',
	}
}

function formatCode(content: string, contentIndent: string, width: number): string {
	return `${contentIndent}${padTag(content, width, '%}')}`
}

function formatComment(content: string, contentIndent: string, width: number): string[] {
	const opener = JINJA_COMMENT_OPENERS.find((candidate) => content.startsWith(candidate))
	if (!opener || !content.endsWith('#}')) {
		return [`${contentIndent}${content}`]
	}

	if (opener !== '{#-') {
		return [`${contentIndent}${padTag(content, width, '#}')}`]
	}

	const rawBody = content.slice(opener.length, -2).trimEnd()
	const internalIndent = leadingWhitespace(rawBody)
	const text = rawBody.trimStart().replace(/^\/\/\s?/, '')
	const prefix = `${opener}${internalIndent}// `
	const maxTextLength = Math.max(1, width - prefix.length - ' #}'.length)

	return wrapWords(text, maxTextLength).map((line) => `${contentIndent}${padTag(`${prefix}${line} #}`, width, '#}')}`)
}

function normalizeLeadingTrimOpener(content: string): string {
	if (content.startsWith('{%-') || content.startsWith('{#-')) {
		return content
	}

	if (content.startsWith('{%')) {
		return `{%-${content.slice('{%'.length)}`
	}

	if (content.startsWith('{#')) {
		return `{#-${content.slice('{#'.length)}`
	}

	return content
}

function shouldWrapImportedFirstLine(lines: string[], start: number, end: number): boolean {
	for (let index = start + 1; index < end; index += 1) {
		const trimmed = lines[index].trimStart()

		if (trimmed === '') {
			continue
		}

		return JINJA_CODE_OPENERS.some((opener) => trimmed.startsWith(opener)) || JINJA_COMMENT_OPENERS.some((opener) => trimmed.startsWith(opener))
	}

	return false
}

function firstNonEmptyBlockLine(lines: string[], start: number, end: number): number | undefined {
	for (let index = start + 1; index < end; index += 1) {
		if (lines[index].trim() !== '') {
			return index
		}
	}

	return undefined
}

function normalizeMultilineCodeTag(lines: string[], start: number, contentIndent: string, width: number, forceLeadingTrimOpener: boolean): MultilineCodeTag | undefined {
	const firstLine = lines[start]
	const firstTrimmed = firstLine.trimStart()
	const sourceOpener = JINJA_CODE_OPENERS.find((candidate) => firstTrimmed.startsWith(candidate))

	if (!sourceOpener || firstTrimmed.endsWith('%}')) {
		return undefined
	}

	const opener = forceLeadingTrimOpener ? '{%-' : sourceOpener
	const firstIndent = leadingWhitespace(firstLine)
	const internalIndent = firstIndent.startsWith(contentIndent) ? firstIndent.slice(contentIndent.length) : ''
	const parts = [`${opener}${internalIndent}${firstTrimmed.slice(sourceOpener.length).trimEnd()}`]
	let index = start + 1

	while (index < lines.length) {
		const trimmed = lines[index].trim()

		if (trimmed.endsWith('%}')) {
			const body = trimmed.slice(0, -'%}'.length).trim()
			if (body !== '') {
				parts.push(body)
			}

			const line = formatCode(`${parts.join(' ')} %}`, contentIndent, width)
			const content = line.startsWith(contentIndent) ? line.slice(contentIndent.length) : line
			const collapsedLength = haDumpedLength(content)

			if (collapsedLength > width) {
				return {
					lines: lines.slice(start, index + 1),
					nextIndex: index + 1,
					collapsedLength,
				}
			}

			return {
				lines: [line],
				nextIndex: index + 1,
			}
		}

		if (trimmed !== '') {
			parts.push(trimmed)
		}

		index += 1
	}

	return undefined
}

function normalizeTemplateLine(line: string, contentIndent: string, width: number, forceLeadingTrimOpener: boolean): string[] {
	if (line.trim() === '') {
		return [line]
	}

	const lineIndent = leadingWhitespace(line)
	const trimmed = line.trimStart()

	if (!isJinjaLine(line)) {
		return [`${contentIndent}${trimmed.trimEnd()}`]
	}

	const opener = JINJA_OPENERS.find((candidate) => trimmed.startsWith(candidate))
	if (!opener) {
		return [line]
	}

	const internalIndent = lineIndent.startsWith(contentIndent) ? lineIndent.slice(contentIndent.length) : ''
	const rawContent = `${opener}${internalIndent}${trimmed.slice(opener.length).trimEnd()}`
	const content = forceLeadingTrimOpener ? normalizeLeadingTrimOpener(rawContent) : rawContent

	if (JINJA_COMMENT_OPENERS.some((opener) => content.startsWith(opener))) {
		return formatComment(content, contentIndent, width)
	}

	if (JINJA_CODE_OPENERS.some((opener) => content.startsWith(opener)) && content.endsWith('%}')) {
		return [formatCode(content, contentIndent, width)]
	}

	if (JINJA_OUTPUT_OPENERS.some((opener) => content.startsWith(opener))) {
		return [`${contentIndent}${trimmed.trimEnd()}`]
	}

	return [`${contentIndent}${content}`]
}

function findMultilineOutputTagEnd(lines: string[], start: number, end: number): number | undefined {
	const firstTrimmed = lines[start].trimStart()

	if (!firstTrimmed.startsWith('{{') || firstTrimmed.endsWith('}}')) {
		return undefined
	}

	for (let index = start + 1; index < end; index += 1) {
		if (lines[index].trim().endsWith('}}')) {
			return index + 1
		}
	}

	return undefined
}

function formatBlueprintSource(source: string, width: number): FormatResult {
	const hasTrailingNewline = source.endsWith('\n')
	const lines = source.replace(/\n$/, '').split('\n')
	const output: string[] = []
	const warnings: Warning[] = []
	let index = 0

	while (index < lines.length) {
		const line = lines[index]

		if (!isBlockScalarHeader(line)) {
			output.push(line)
			index += 1
			continue
		}

		const blockEnd = findBlockEnd(lines, index)
		const contentIndent = blockContentIndent(lines, index, blockEnd)

		if (!contentIndent || !blockContainsFormattableJinja(lines, index, blockEnd)) {
			output.push(...lines.slice(index, blockEnd))
			index = blockEnd
			continue
		}

		output.push(line)
		// HA dumps folded templates as quoted scalars with the first content line
		// after the key; a trimmed leading blank keeps real template lines aligned.
		const shouldInsertImportWrapBlank = shouldWrapImportedFirstLine(lines, index, blockEnd) && lines[index + 1]?.trim() !== ''
		const firstNonEmptyLine = firstNonEmptyBlockLine(lines, index, blockEnd)

		if (shouldInsertImportWrapBlank) {
			output.push('')
		}

		let blockIndex = index + 1
		while (blockIndex < blockEnd) {
			const forceLeadingTrimOpener = shouldInsertImportWrapBlank && blockIndex === firstNonEmptyLine
			const multilineCodeTag = normalizeMultilineCodeTag(lines, blockIndex, contentIndent, width, forceLeadingTrimOpener)
			if (multilineCodeTag) {
				if (multilineCodeTag.collapsedLength) {
					warnings.push({
						line: blockIndex + 1,
						message: `multiline Jinja code tag is left unchanged because collapsed HA-dumped length ${multilineCodeTag.collapsedLength} exceeds target ${width}`,
						code: 'ha-blueprint-format/multiline-code',
					})
				}

				output.push(...multilineCodeTag.lines)
				blockIndex = multilineCodeTag.nextIndex
				continue
			}

			const multilineOutputEnd = findMultilineOutputTagEnd(lines, blockIndex, blockEnd)
			if (multilineOutputEnd) {
				warnings.push({
					line: blockIndex + 1,
					message: 'multiline Jinja output tag is left unchanged and may import with escaped newlines',
					code: 'ha-blueprint-format/multiline-output',
				})
				output.push(...lines.slice(blockIndex, multilineOutputEnd))
				blockIndex = multilineOutputEnd
				continue
			}

			for (const formattedLine of normalizeTemplateLine(lines[blockIndex], contentIndent, width, forceLeadingTrimOpener)) {
				const content = formattedLine.startsWith(contentIndent) ? formattedLine.slice(contentIndent.length) : formattedLine

				if (isJinjaLine(formattedLine) && haDumpedLength(content) > width) {
					warnings.push(formatLengthWarning(blockIndex + 1, content, width))
				}

				output.push(formattedLine)
			}

			blockIndex += 1
		}

		index = blockEnd
	}

	return {
		source: `${output.join('\n')}${hasTrailingNewline ? '\n' : ''}`,
		warnings,
	}
}

function selectedFiles(options: Options): string[] {
	return options.paths.length > 0 ? options.paths.map((path) => resolve(path)) : defaultBlueprintFiles()
}

function runFormatter(options: Options, files: string[]): RunResult {
	let hasChanges = false
	let hasWarnings = false

	for (const file of files) {
		if (!existsSync(file)) {
			throw new Error(`File not found: ${file}`)
		}

		const source = readFileSync(file, 'utf8')
		const result = formatBlueprintSource(source, options.width)

		for (const warning of result.warnings) {
			hasWarnings = true
			process.stdout.write(`${formatWarning(file, warning)}\n`)
		}

		if (result.source === source) {
			continue
		}

		hasChanges = true

		if (options.mode === 'write') {
			writeFileSync(file, result.source)
			process.stdout.write(`Formatted ${file}\n`)
		} else {
			process.stdout.write(`${formatWarning(file, notFormattedWarning())}\n`)
		}
	}

	return {
		hasChanges,
		hasWarnings,
	}
}

function runWatchCycle(options: Options): void {
	process.stdout.write('ha-blueprint-formatter: begin\n')

	try {
		runFormatter(options, selectedFiles(options))
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		process.stderr.write(`${message}\n`)
	} finally {
		process.stdout.write('ha-blueprint-formatter: end\n')
	}
}

function snapshotFiles(files: string[]): string {
	return files
		.map((file) => {
			try {
				const stat = statSync(file)
				return `${file}:${stat.mtimeMs}:${stat.size}`
			} catch {
				return `${file}:missing`
			}
		})
		.join('\n')
}

function watchFormatter(options: Options): void {
	const files = selectedFiles(options)
	const watchedDirectories = [...new Set(files.map((file) => dirname(file)))]
	let previousSnapshot = snapshotFiles(files)

	runWatchCycle(options)
	process.stdout.write(`ha-blueprint-formatter: watching ${watchedDirectories.join(', ')}\n`)

	setInterval(() => {
		const nextFiles = selectedFiles(options)
		const nextSnapshot = snapshotFiles(nextFiles)

		if (nextSnapshot === previousSnapshot) {
			return
		}

		previousSnapshot = nextSnapshot
		runWatchCycle(options)
	}, 1000)
}

function main(): void {
	const options = parseArgs(process.argv.slice(2))

	if (options.watch) {
		watchFormatter(options)
		return
	}

	const result = runFormatter(options, selectedFiles(options))

	if (options.mode === 'check' && result.hasChanges) {
		process.exit(1)
	}

	if (options.failOnWarnings && result.hasWarnings) {
		process.exit(1)
	}
}

try {
	main()
} catch (error) {
	const message = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${message}\n`)
	process.exit(1)
}
