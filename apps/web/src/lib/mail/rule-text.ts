// SPDX-License-Identifier: Apache-2.0
// Human rendering of the rules DSL — shared by the rules sheet and the
// "why is this here?" sheet. Read-only formatting, no validation (the rpc
// layer owns that).

export type RuleCondition = { field: string; operator: string; value: string | number | boolean };
export type RuleConditionGroup = { op: 'AND' | 'OR'; conditions: RuleCondition[] };
export type RuleActionLike = { type: string; labelId?: string; minutes?: number; to?: string };

const FIELDS: Record<string, string> = {
	from: 'from',
	to: 'to',
	cc: 'cc',
	subject: 'subject',
	listId: 'list',
	hasAttachment: 'attachment',
	size: 'size',
	body: 'body'
};

const OPERATORS: Record<string, string> = {
	contains: 'contains',
	equals: 'is',
	matches: 'matches',
	gt: 'over',
	lt: 'under'
};

export function describeCondition(condition: RuleCondition): string {
	return `${FIELDS[condition.field] ?? condition.field} ${OPERATORS[condition.operator] ?? condition.operator} ${condition.value}`;
}

export function describeConditions(group: RuleConditionGroup | null | undefined): string {
	if (!group?.conditions?.length) return 'any mail';
	return group.conditions.map(describeCondition).join(group.op === 'OR' ? ' or ' : ' and ');
}

export function describeAction(action: RuleActionLike, folderName: (labelId: string) => string): string {
	switch (action.type) {
		case 'moveTo':
			return `move to ${folderName(action.labelId ?? '')}`;
		case 'addLabel':
			return `label ${folderName(action.labelId ?? '')}`;
		case 'removeLabel':
			return `unlabel ${folderName(action.labelId ?? '')}`;
		case 'markRead':
			return 'mark read';
		case 'markFlagged':
			return 'star';
		case 'junk':
			return 'mark spam';
		case 'snooze':
			return `snooze ${action.minutes} min`;
		case 'forward':
			return `forward to ${action.to}`;
		case 'stopProcessing':
			return 'stop other rules';
		default:
			return action.type;
	}
}

/** "If from is billing@acme.com → move to Receipts" */
export function describeRule(
	rule: { conditions: RuleConditionGroup; actions: RuleActionLike[] },
	folderName: (labelId: string) => string
): string {
	const actions = rule.actions.map((action) => describeAction(action, folderName)).join(', ');
	return `If ${describeConditions(rule.conditions)} → ${actions}`;
}
