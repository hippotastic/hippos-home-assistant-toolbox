import { afterAll } from 'vitest'
import { closeBlueprintRuntimeClient } from './client.ts'

afterAll(async () => {
	await closeBlueprintRuntimeClient()
})
