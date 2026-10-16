import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

const originalArguments = process.argv
const originalExitCode = process.exitCode
const success = { pid: 1, output: [], stdout: '', stderr: '', status: 0, signal: null }

beforeEach(() => {
	vi.resetModules()
	vi.stubEnv('GH_TOKEN', 'fixture-token')
	vi.stubEnv('GITHUB_TOKEN', '')
	vi.mocked(spawnSync).mockReturnValue(success)
	vi.mocked(existsSync).mockReturnValue(true)
})

afterEach(() => {
	process.argv = originalArguments
	process.exitCode = originalExitCode
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	vi.clearAllMocks()
})

test('propagates a hassfest failure and runs against the read-only checkout without network', async () => {
	process.argv = ['node', 'cli.ts', 'hassfest']
	vi.mocked(spawnSync).mockReturnValue({ ...success, status: 7 })

	await import('../../tools/validation/cli.ts')

	expect(process.exitCode).toBe(7)
	const [command, args] = vi.mocked(spawnSync).mock.calls[0]
	expect(command).toBe('docker')
	expect(args).toContain('ghcr.io/home-assistant/hassfest:latest')
	expect(args).toContain('none')
	expect(args).toContain('/github/workspace')
	expect(args).toContainEqual(expect.stringMatching(/:\/github\/workspace:ro$/))
})

test('passes local additions and deletions to HACS, keeping credentials out of command arguments', async () => {
	process.argv = ['node', 'cli.ts', 'hacs']
	vi.mocked(spawnSync)
		.mockReturnValueOnce({ ...success, stdout: 'README.md\0new file.json\0deleted.json\0README.md\0' })
		.mockReturnValueOnce({ ...success, status: 3 })
	vi.mocked(existsSync).mockImplementation((path) => !String(path).endsWith('/deleted.json'))

	await import('../../tools/validation/cli.ts')

	expect(process.exitCode).toBe(3)
	expect(spawnSync).toHaveBeenNthCalledWith(1, 'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], expect.anything())
	const [command, args, options] = vi.mocked(spawnSync).mock.calls[1]
	expect(command).toBe('docker')
	expect(args).toContain('INPUT_GITHUB_TOKEN')
	expect(args).not.toContain('fixture-token')
	expect(options).toMatchObject({ input: JSON.stringify(['README.md', 'new file.json']) })
	expect(options).toHaveProperty('env.INPUT_GITHUB_TOKEN', 'fixture-token')
})

test('uses the existing gh login when no token environment variable is set', async () => {
	process.argv = ['node', 'cli.ts', 'hacs']
	vi.stubEnv('GH_TOKEN', '')
	vi.mocked(spawnSync)
		.mockReturnValueOnce({ ...success, stdout: 'login-token\n' })
		.mockReturnValueOnce({ ...success, stdout: 'README.md\0' })
		.mockReturnValueOnce(success)

	await import('../../tools/validation/cli.ts')

	expect(process.exitCode).toBe(0)
	expect(spawnSync).toHaveBeenNthCalledWith(1, 'gh', ['auth', 'token'], expect.anything())
	expect(vi.mocked(spawnSync).mock.calls[2][2]).toHaveProperty('env.INPUT_GITHUB_TOKEN', 'login-token')
})

test('fails without starting Docker when GitHub authentication is unavailable', async () => {
	process.argv = ['node', 'cli.ts', 'hacs']
	vi.stubEnv('GH_TOKEN', '')
	vi.mocked(spawnSync).mockReturnValue({ ...success, status: 1 })
	const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

	await import('../../tools/validation/cli.ts')

	expect(process.exitCode).toBe(1)
	expect(spawnSync).toHaveBeenCalledTimes(1)
	expect(stderr).toHaveBeenCalledWith(expect.stringContaining('HACS validation requires GitHub authentication'))
})
