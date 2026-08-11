import { homeAssistantTestConfig } from '../vitest.shared.ts'

export default homeAssistantTestConfig([
	'test/home-assistant/blueprint-loading/**/*.test.ts',
	'test/home-assistant/hippos-toolbox-integration/**/*.test.ts',
	'test/home-assistant/runtime/**/*.test.ts',
])
