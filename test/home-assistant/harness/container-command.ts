import { spawnSync } from 'node:child_process'
import { inject } from 'vitest'

export function runInHomeAssistant(command: string[]) {
	return spawnSync('docker', ['exec', '-w', '/repo', inject('haBlueprintContainerName'), ...command], {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
	})
}

export function commandOutput(result: ReturnType<typeof runInHomeAssistant>): string {
	return `${result.stdout}${result.stderr}`.replace(
		/^\/usr\/local\/lib\/python3\.\d+\/site-packages\/rich\/segment\.py:547: SyntaxWarning: 'return' in a 'finally' block\n {2}return\n/gm,
		''
	)
}
