export function settle(milliseconds = 100): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
