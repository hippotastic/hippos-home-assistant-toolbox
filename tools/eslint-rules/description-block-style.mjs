const descriptionBlockStyleRule = {
	meta: {
		type: 'suggestion',
		docs: {
			description: 'require folded YAML block scalars for multiline blueprint description prose',
		},
		fixable: 'code',
		schema: [],
		messages: {
			useFolded: 'Use a folded block scalar (`>`) for description prose. Disable this rule locally when hard line breaks are intentional.',
		},
	},
	create(context) {
		return {
			YAMLPair(node) {
				if (node.key?.type !== 'YAMLScalar' || node.key.value !== 'description') return
				if (node.value?.type !== 'YAMLScalar' || node.value.style !== 'literal') return
				if (!node.value.value.replace(/\n$/, '').includes('\n')) return

				context.report({
					node: node.value,
					messageId: 'useFolded',
					fix(fixer) {
						// Only the scalar indicator changes; chomping and indentation indicators stay intact.
						return fixer.replaceTextRange([node.value.range[0], node.value.range[0] + 1], '>')
					},
				})
			},
		}
	},
}

export default {
	rules: {
		'description-block-style': descriptionBlockStyleRule,
	},
}
