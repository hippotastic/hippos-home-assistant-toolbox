import { defineConfig } from 'vitest/config'

export const TEST_REPORTERS = ['tree'] as const

export function homeAssistantTestConfig(include: string[]) {
	return defineConfig({
		test: {
			fileParallelism: false,
			globalSetup: ['test/global-setup.ts'],
			hookTimeout: 150_000,
			include,
			isolate: false,
			maxWorkers: 1,
			pool: 'forks',
			reporters: [...TEST_REPORTERS],
			setupFiles: ['test/setup.ts'],
			slowTestThreshold: 5_000,
			testTimeout: 150_000,
			teardownTimeout: 30_000,
		},
	})
}
