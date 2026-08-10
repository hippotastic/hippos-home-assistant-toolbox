import { defineConfig } from 'vitest/config'

import { TEST_REPORTERS } from '../vitest.shared.ts'

export default defineConfig({
	test: {
		include: ['test/unit/**/*.test.ts'],
		reporters: [...TEST_REPORTERS],
	},
})
