import { afterAll } from 'vitest'
import { closeBlueprintRuntimeClient } from './api.ts'

afterAll(async () => {
	await closeBlueprintRuntimeClient()
})
