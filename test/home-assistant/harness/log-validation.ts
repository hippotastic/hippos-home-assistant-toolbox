const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
const LOG_HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) \([^)]+\) \[([^\]]+)](?: (.*))?$/

export type HomeAssistantLogIssue = {
	level: 'CRITICAL' | 'ERROR' | 'WARNING'
	logger: string
	message: string
	timestamp: string
}

export function unexpectedHomeAssistantLogIssues(output: string, isAllowed: (issue: HomeAssistantLogIssue) => boolean = () => false): HomeAssistantLogIssue[] {
	const issues: HomeAssistantLogIssue[] = []
	let current: HomeAssistantLogIssue | undefined

	for (const line of output.replaceAll(ANSI_ESCAPE, '').split('\n')) {
		const match = LOG_HEADER.exec(line)
		if (match) {
			if (current) issues.push(current)
			current = undefined
			if (match[2] === 'WARNING' || match[2] === 'ERROR' || match[2] === 'CRITICAL') {
				current = {
					level: match[2],
					logger: match[3],
					message: match[4] ?? '',
					timestamp: match[1],
				}
			}
			continue
		}

		if (current) current.message += `\n${line}`
	}

	if (current) issues.push(current)
	return issues.filter((issue) => !isAllowed(issue))
}

export function formatHomeAssistantLogIssues(issues: HomeAssistantLogIssue[]): string {
	const groups = new Map<string, { count: number; issue: HomeAssistantLogIssue }>()
	for (const issue of issues) {
		const key = `${issue.level}\0${issue.logger}\0${issue.message}`
		const group = groups.get(key)
		if (group) group.count += 1
		else groups.set(key, { count: 1, issue })
	}

	return [...groups.values()]
		.map(({ count, issue }) => {
			const repeated = count === 1 ? '' : ` (repeated ${count} times)`
			return `${issue.timestamp} ${issue.level} [${issue.logger}]${repeated} ${issue.message}`.trimEnd()
		})
		.join('\n\n')
}
