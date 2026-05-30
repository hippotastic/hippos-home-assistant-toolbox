import js from '@eslint/js'
import { fileURLToPath } from 'node:url'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import eslintConfigPrettier from 'eslint-config-prettier'
import noOnlyTests from 'eslint-plugin-no-only-tests'
import eslintPluginPrettier from 'eslint-plugin-prettier'
import globals from 'globals'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const tsTypeCheckedConfigs = tseslint.configs['flat/recommended-type-checked'].map((config) => ({
	...config,
	files: config.files ?? ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
}))

const baseRules = {
	'prettier/prettier': 'warn',
	'no-console': 'warn',
	'no-only-tests/no-only-tests': 'warn',
	'no-mixed-spaces-and-tabs': ['warn', 'smart-tabs'],
	'no-trailing-spaces': ['warn', { skipBlankLines: true, ignoreComments: true }],
	'no-empty': 'warn',
	'no-unused-vars': [
		'warn',
		{
			argsIgnorePattern: '^(_.*?|e)$',
		},
	],
	'no-unused-private-class-members': 'warn',
	'no-invalid-this': 'warn',
	'consistent-this': ['warn', 'thisObj'],
	semi: ['warn', 'never'],
	quotes: ['warn', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
	'space-before-function-paren': [
		'warn',
		{
			named: 'never',
			anonymous: 'always',
			asyncArrow: 'always',
		},
	],
	'func-call-spacing': ['warn', 'never'],
	'comma-spacing': ['warn', { before: false, after: true }],
	indent: ['warn', 'tab', { SwitchCase: 1 }],
	'brace-style': ['warn', '1tbs'],
	'space-before-blocks': ['warn', 'always'],
	'keyword-spacing': 'warn',
}

const tsRules = {
	'@typescript-eslint/no-unused-vars': [
		'warn',
		{
			argsIgnorePattern: '^_',
			caughtErrorsIgnorePattern: '^_',
			destructuredArrayIgnorePattern: '^_',
		},
	],
	'@typescript-eslint/no-deprecated': 'warn',
	'@typescript-eslint/no-empty-function': 'warn',
	'@typescript-eslint/no-empty-object-type': ['warn', { allowInterfaces: 'with-single-extends' }],
	'@typescript-eslint/no-non-null-assertion': 'off',
	'@typescript-eslint/no-redundant-type-constituents': 'off',
}

export default [
	{
		ignores: ['**/node_modules/**'],
	},
	js.configs.recommended,
	eslintConfigPrettier,
	{
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.es2021,
				...globals.node,
			},
		},
		plugins: {
			prettier: eslintPluginPrettier,
			'no-only-tests': noOnlyTests,
		},
		rules: baseRules,
	},
	{
		files: ['**/.*.js', '**/.*.cjs', '**/.*.mjs'],
		rules: {
			indent: ['warn', 2, { SwitchCase: 1 }],
		},
	},
	...tsTypeCheckedConfigs,
	{
		files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.eslint.json',
				tsconfigRootDir: __dirname,
			},
		},
		plugins: {
			'@typescript-eslint': tseslint,
		},
		rules: tsRules,
	},
]
