#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

try {
	const mode = process.argv[2]
	if (mode !== 'hacs' && mode !== 'hassfest') {
		throw new Error('Usage: node tools/validation/cli.ts <hacs|hassfest>')
	}

	const args = ['run', '--rm', '--pull', 'always', '--platform', 'linux/amd64', '--volume', `${repoRoot}:/github/workspace:ro`, '--env', 'PYTHONDONTWRITEBYTECODE=1']
	const env = { ...process.env }
	let input: string | undefined

	if (mode === 'hacs') {
		let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
		if (!token) {
			const auth = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
			if (auth.error || auth.status !== 0 || !auth.stdout.trim()) {
				throw new Error('HACS validation requires GitHub authentication: run gh auth login or set GH_TOKEN / GITHUB_TOKEN.')
			}
			token = auth.stdout.trim()
		}
		env.INPUT_GITHUB_TOKEN = token

		const files = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8' })
		if (files.error) throw files.error
		if (files.status !== 0) throw new Error(`Cannot list repository files: ${files.stderr.trim()}`)
		// Include untracked additions and exclude tracked files deleted from the working tree
		input = JSON.stringify([...new Set(files.stdout.split('\0').filter((file) => file && existsSync(join(repoRoot, file))))])

		args.push(
			'--interactive',
			'--env',
			'INPUT_GITHUB_TOKEN',
			'--env',
			'INPUT_REPOSITORY=hippotastic/hippos-home-assistant-toolbox',
			'--env',
			'INPUT_CATEGORY=integration',
			'--env',
			'INPUT_COMMENT=false',
			'--env',
			'REPOSITORY_REF=local-working-tree',
			'--env',
			'PYTHONPATH=/hacs:/github/workspace',
			'--entrypoint',
			'sh',
			'ghcr.io/hacs/action:main',
			'-c',
			'python3 -m unittest discover -s /github/workspace/test/validation && python3 /github/workspace/tools/validation/hacs.py'
		)
	} else {
		args.push('--network', 'none', '--workdir', '/github/workspace', 'ghcr.io/home-assistant/hassfest:latest')
	}

	const result = spawnSync('docker', args, { cwd: repoRoot, env, input, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'] })
	if (result.error) throw result.error
	if (result.signal) throw new Error(`${mode} validation interrupted by ${result.signal}`)
	process.exitCode = result.status ?? 1
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
	process.exitCode = 1
}
