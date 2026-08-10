import { resolve } from 'node:path'
import type { TestProject } from 'vitest/node'
import { setupRuntimeFixture } from './harness.ts'

export default function setup(project: TestProject): Promise<() => Promise<void>> {
	return setupRuntimeFixture(project, resolve(import.meta.dirname, '..'))
}
