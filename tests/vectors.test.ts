import { describe, expect, it } from 'vitest';
import vectors from './vectors/compile-loss-check.json';
import * as check from '../src/check';
import type { CheckInput, CheckResult } from '../src/check';

interface Case {
	name: string;
	function?: 'parseSceneOrder' | 'reportPath' | 'splitParagraphs';
	args: unknown[];
	expected: unknown;
}

function project(r: CheckResult): Record<string, unknown> {
	return {
		status: r.status,
		errors: r.errors,
		scenes: r.scenes,
		checked: r.checked,
		outputParagraphs: r.outputParagraphs,
		excluded: r.excluded,
		unmatched: r.unmatched.map((u) => [u.text, u.missing, u.sourceCount, u.outputCount, u.places.map((p) => `${p.path}:${p.line}`), u.uncertain, u.hint]),
	};
}

describe('golden vectors (packages/spec/vectors/compile-loss-check.json)', () => {
	const cases = vectors.cases as Case[];
	it('has at least 20 checkCompile cases', () => {
		expect(cases.filter((c) => !c.function).length).toBeGreaterThanOrEqual(20);
	});
	for (const c of cases) {
		it(c.name, () => {
			if (c.function) {
				const fn = check[c.function] as (...a: unknown[]) => unknown;
				expect(fn(...c.args)).toEqual(c.expected);
				return;
			}
			const got = project(check.checkCompile(c.args[0] as CheckInput));
			const want = c.expected as Record<string, unknown>;
			expect(Object.fromEntries(Object.keys(want).map((k) => [k, got[k]]))).toEqual(want);
		});
	}
});
