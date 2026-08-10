import { isScalar, parseDocument, visit } from 'yaml'

const TEST_VALUE_MARKER = '@blueprint-test-value'
const HOME_ASSISTANT_YAML_TAGS = ['!input'].map((tag) => ({
	resolve: (value: string) => value,
	tag,
}))

type Replacement = {
	end: number
	start: number
	value: string
}

export function applyBlueprintTestValueOverrides(source: string, path = 'blueprint.yaml'): string {
	const markerCount = source.split(TEST_VALUE_MARKER).length - 1
	if (markerCount === 0) {
		return source
	}

	const document = parseDocument(source, {
		customTags: HOME_ASSISTANT_YAML_TAGS,
		keepSourceTokens: true,
		prettyErrors: true,
	})
	if (document.errors.length > 0) {
		throw new Error(`${path}: ${document.errors.map((error) => error.message).join('\n')}`)
	}

	const replacements: Replacement[] = []
	visit(document, {
		Scalar(_key, node) {
			const comment = node.comment?.trim()
			if (!comment?.includes(TEST_VALUE_MARKER)) {
				return
			}

			const match = /^@blueprint-test-value\s+(.+)$/.exec(comment)
			if (!match || !node.range) {
				throw new Error(`${path}: invalid ${TEST_VALUE_MARKER} directive`)
			}

			const overrideSource = match[1].trim()
			const override = parseDocument(overrideSource, { prettyErrors: true })
			if (override.errors.length > 0 || !isScalar(override.contents)) {
				throw new Error(`${path}: ${TEST_VALUE_MARKER} must contain one YAML scalar`)
			}

			replacements.push({
				end: node.range[1],
				start: node.range[0],
				value: overrideSource,
			})
		},
	})

	if (replacements.length !== markerCount) {
		throw new Error(`${path}: every ${TEST_VALUE_MARKER} directive must annotate a YAML scalar`)
	}

	return replacements
		.sort((left, right) => right.start - left.start)
		.reduce((result, replacement) => `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`, source)
}
