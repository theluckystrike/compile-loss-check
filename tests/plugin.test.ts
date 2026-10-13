import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import CompileLossCheckPlugin from '../src/main';
import { PRO_UI, SPONSORS, bindPro, isPro, onProChange, resetPro } from '../src/pro';
import { DEFAULT_SETTINGS, HISTORY_MAX, normalizeSettings } from '../src/settings';
import { MAX_CHARS, MAX_SCENES, STRICT_RULE, checkCompile, renderReport } from '../src/check';
import manifest from '../manifest.json';

afterEach(() => {
	resetPro();
	vi.useRealTimers();
});

/** A stand-in for the SponsorsManager: only isPro and onChange, which the facade uses. */
function fakeManager(start: boolean) {
	let pro = start;
	const fns = new Set<() => void>();
	return {
		isPro: () => pro,
		onChange: (fn: () => void) => {
			fns.add(fn);
			return () => fns.delete(fn);
		},
		set(v: boolean) {
			pro = v;
			for (const fn of fns) fn();
		},
		listeners: () => fns.size,
	};
}

const INDEX = '---\nlongform:\n  format: scenes\n  title: Novel\n  sceneFolder: Scenes\n  scenes:\n    - A\n    - - B\n    - C\n---\n';
const VAULT = {
	'Novel/Index.md': INDEX,
	'Novel/Scenes/A.md': 'Alpha.\n\nMiddle.\n',
	'Novel/Scenes/B.md': 'Beta.\n',
	'Novel/Scenes/C.md': 'Omega.\n',
	'Novel/Manuscript.md': 'Alpha.\n\nBeta.\n\nOmega.\n',
	'Novel/Second.md': 'Alpha.\n\nMiddle.\n\nBeta.\n\nOmega.\n',
};

async function makePlugin(files: Record<string, string> = VAULT) {
	const app = App.createConfigured__({ files });
	const plugin = new CompileLossCheckPlugin(app as never, manifest as never);
	await plugin.loadSettings();
	return { app, plugin };
}

describe('settings', () => {
	it('loads with default settings against an in-memory vault', async () => {
		const { plugin } = await makePlugin();
		expect(plugin.settings).toEqual(DEFAULT_SETTINGS);
		expect(isPro()).toBe(false);
	});

	it('repairs bad saved settings', () => {
		expect(normalizeSettings({ reportFolder: 5 as never, profiles: 'x' as never, history: null as never })).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(normalizeSettings({ reportFolder: '/Checks/' }).reportFolder).toBe('Checks');
		const s = normalizeSettings({
			profiles: [{ name: 'Draft', indexPath: 'I.md', outputPaths: ['O.md', 3], excludeTexts: ['x'], excludePaths: [] } as never, { name: '', indexPath: 'I.md', outputPaths: ['O.md'] } as never],
			history: [{ date: 'd', reportPath: 'r.md', indexPath: 'I.md', status: 'odd' } as never],
		});
		expect(s.profiles).toEqual([{ name: 'Draft', indexPath: 'I.md', outputPaths: ['O.md'], excludeTexts: ['x'], excludePaths: [] }]);
		expect(s.history[0]).toMatchObject({ status: 'incomplete', unmatched: 0, outputPaths: [] });
	});

	it('keeps the newest history entries only', () => {
		const history = Array.from({ length: HISTORY_MAX + 5 }, (_, i) => ({ date: String(i), reportPath: `${i}.md`, indexPath: 'I.md', profile: '', outputPaths: [], status: 'pass' as const, unmatched: 0 }));
		const s = normalizeSettings({ history });
		expect(s.history.length).toBe(HISTORY_MAX);
		expect(s.history[0]!.date).toBe('5');
	});
});

describe('runCheck in a vault', () => {
	it('reads nested scenes, reports the lost paragraph and saves a new report next to the compiled note', async () => {
		const { app, plugin } = await makePlugin();
		const out = await plugin.runCheck('Novel/Index.md', ['Novel/Manuscript.md']);
		const r = out.runs[0]!.result;
		expect(r.status).toBe('mismatch');
		expect(r.scenes).toEqual(['Novel/Scenes/A.md', 'Novel/Scenes/B.md', 'Novel/Scenes/C.md']);
		expect(r.unmatched.map((u) => [u.text, u.places])).toEqual([['Middle.', [{ path: 'Novel/Scenes/A.md', line: 3 }]]]);
		expect(out.reportPath).toMatch(/^Novel\/Compile check Manuscript \d{4}-\d\d-\d\d \d{4}\.md$/);
		const text = await app.vault.read(app.vault.getFileByPath(out.reportPath!)!);
		expect(text).toContain('> Middle.');
		expect(text).toContain('[[Novel/Scenes/A|Novel/Scenes/A.md]] line 3');
		expect(text).toContain(STRICT_RULE);
		expect(plugin.last).toEqual({ indexPath: 'Novel/Index.md', outputPaths: ['Novel/Manuscript.md'] });
	});

	it('never overwrites: a second report in the same minute gets a new name', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date(2026, 9, 13, 9, 30));
		const { app, plugin } = await makePlugin();
		const a = await plugin.runCheck('Novel/Index.md', ['Novel/Manuscript.md']);
		const before = await app.vault.read(app.vault.getFileByPath(a.reportPath!)!);
		const b = await plugin.runCheck('Novel/Index.md', ['Novel/Manuscript.md']);
		expect(a.reportPath).toBe('Novel/Compile check Manuscript 2026-10-13 0930.md');
		expect(b.reportPath).toBe('Novel/Compile check Manuscript 2026-10-13 0930 2.md');
		expect(await app.vault.read(app.vault.getFileByPath(a.reportPath!)!)).toBe(before);
	});

	it('uses the report folder setting and makes the folder', async () => {
		const { app, plugin } = await makePlugin();
		plugin.settings.reportFolder = 'Checks/Compile';
		const out = await plugin.runCheck('Novel/Index.md', ['Novel/Second.md']);
		expect(out.runs[0]!.result.status).toBe('pass');
		expect(out.reportPath!.startsWith('Checks/Compile/')).toBe(true);
		expect(app.vault.getFileByPath(out.reportPath!)).not.toBeNull();
	});

	it('a missing compiled note or index is incomplete, not a pass', async () => {
		const { plugin } = await makePlugin();
		const a = await plugin.runCheck('Novel/Index.md', ['Novel/Nope.md']);
		expect(a.runs[0]!.result.status).toBe('incomplete');
		expect(a.runs[0]!.result.errors[0]).toBe('The compiled note "Novel/Nope.md" does not exist.');
		const b = await plugin.runCheck('Novel/Gone.md', ['Novel/Manuscript.md']);
		expect(b.runs[0]!.result.status).toBe('incomplete');
		expect(b.runs[0]!.result.errors).toContain('The index note "Novel/Gone.md" does not exist.');
	});

	it('a scene that changes during the scan stops the check', async () => {
		const { app, plugin } = await makePlugin();
		const vault = app.vault;
		const read = vault.read.bind(vault);
		let done = false;
		vi.spyOn(vault, 'read').mockImplementation(async (f) => {
			const t = await read(f);
			if (!done && f.path === 'Novel/Scenes/B.md') {
				done = true;
				await vault.modify(f, 'Beta changed.\n');
			}
			return t;
		});
		const out = await plugin.runCheck('Novel/Index.md', ['Novel/Manuscript.md']);
		expect(out.runs[0]!.result.status).toBe('incomplete');
		expect(out.runs[0]!.result.errors).toEqual(['"Novel/Scenes/B.md" changed during the scan. Run a new scan.']);
		expect(out.runs[0]!.result.unmatched).toEqual([]);
	});

	it('lists only notes with a longform property as index notes', async () => {
		const { plugin } = await makePlugin();
		expect(plugin.indexNotes().map((f) => f.path)).toEqual(['Novel/Index.md']);
	});
});

describe('pro features', () => {
	it('profiles and history need Pro', async () => {
		const { plugin } = await makePlugin();
		const out = await plugin.runProfile({ name: 'P', indexPath: 'Novel/Index.md', outputPaths: ['Novel/Manuscript.md'], excludeTexts: [], excludePaths: [] }, false);
		expect(out).toBeNull();
		await plugin.runCheck('Novel/Index.md', ['Novel/Manuscript.md']);
		expect(plugin.settings.history).toEqual([]);
	});

	it('a profile checks several compiled notes with its exclusions, in one report, and saves history', async () => {
		const m = fakeManager(true);
		bindPro(m as never);
		const { app, plugin } = await makePlugin();
		await plugin.saveProfile({ name: 'Draft two', indexPath: 'Novel/Index.md', outputPaths: ['Novel/Manuscript.md', 'Novel/Second.md'], excludeTexts: [], excludePaths: [] });
		await plugin.saveProfile({ name: 'Draft two', indexPath: 'Novel/Index.md', outputPaths: ['Novel/Manuscript.md', 'Novel/Second.md'], excludeTexts: ['Middle.'], excludePaths: [] });
		expect(plugin.settings.profiles.length).toBe(1);
		const out = await plugin.runProfile(plugin.settings.profiles[0]!, false);
		expect(out!.runs.map((r) => [r.outputPath, r.result.status, r.result.excluded])).toEqual([
			['Novel/Manuscript.md', 'pass', 1],
			['Novel/Second.md', 'pass', 1],
		]);
		expect(out!.reportPath).toMatch(/^Novel\/Compile check Draft two /);
		const text = await app.vault.read(app.vault.getFileByPath(out!.reportPath!)!);
		expect(text).toContain('## Novel/Manuscript.md');
		expect(text).toContain('## Novel/Second.md');
		expect(plugin.settings.history).toEqual([expect.objectContaining({ profile: 'Draft two', status: 'pass', unmatched: 0, reportPath: out!.reportPath })]);
	});
});

describe('check limits and report', () => {
	it('accepts the scene limit and marks one extra scene as incomplete', () => {
		for (const count of [MAX_SCENES, MAX_SCENES + 1]) {
			const names = Array.from({ length: count }, (_, i) => `Scene ${i}`);
			const files = Object.fromEntries(names.map((name) => [`${name}.md`, 'Alpha.\n']));
			const result = checkCompile({
				indexPath: 'I.md',
				indexText: `---\nlongform:\n  format: scenes\n  scenes: ${JSON.stringify(names)}\n---\n`,
				outputPath: 'O.md',
				outputText: 'Alpha.\n\n'.repeat(count),
				files,
			});
			expect(result.status).toBe(count === MAX_SCENES ? 'pass' : 'incomplete');
			expect(result.errors).toEqual(count === MAX_SCENES ? [] : [`The scene list has ${count} scenes. The limit is ${MAX_SCENES}.`]);
		}
	});

	it('a manuscript over the size limit is incomplete', () => {
		const big = 'x'.repeat(MAX_CHARS + 1);
		const r = checkCompile({ indexPath: 'I.md', indexText: '---\nlongform:\n  format: scenes\n  scenes: [A]\n---\n', outputPath: 'O.md', outputText: '', files: { 'A.md': big } });
		expect(r.status).toBe('incomplete');
		expect(r.errors[0]).toMatch(/The limit is 20000000\.$/);
	});

	it('the report marks repeated text as uncertain and names each possible line', () => {
		const r = checkCompile({ indexPath: 'I.md', indexText: '---\nlongform:\n  format: scenes\n  scenes: [A]\n---\n', outputPath: 'O.md', outputText: 'Echo.\n', files: { 'A.md': 'Echo.\n\nEcho.\n' } });
		const text = renderReport('Compile check: O', 'I.md', [{ outputPath: 'O.md', result: r }], 'now');
		expect(text).toContain('Repeated text. The source copy that was lost is not certain. Possible source lines:');
		expect(text).toContain('[[A|A.md]] line 1');
		expect(text).toContain('[[A|A.md]] line 3');
		expect(text).toContain('Missing: 1 occurrence (source 2, compiled 1).');
	});
});

describe('pro facade', () => {
	it('is off with no manager', () => {
		expect(isPro()).toBe(false);
	});

	it('follows the GitHub Sponsors manager and tells listeners on each change', () => {
		const m = fakeManager(false);
		bindPro(m as never);
		const cb = vi.fn();
		const off = onProChange(cb);
		m.set(true);
		expect(isPro()).toBe(true);
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		m.set(false);
		expect(cb).toHaveBeenCalledTimes(1);
		expect(isPro()).toBe(false);
	});

	it('reset unbinds the manager', () => {
		const m = fakeManager(true);
		bindPro(m as never);
		expect(m.listeners()).toBe(1);
		resetPro();
		expect(m.listeners()).toBe(0);
		expect(isPro()).toBe(false);
	});

	it('the sponsor terms match product.yaml', () => {
		expect(SPONSORS).toMatchObject({ clientId: 'Ov23lic5UPGPZqhBlBGg', sponsorLogin: 'theluckystrike', minMonthlyUsd: 5, oneTimeUsd: 15, scope: 'read:user' });
		expect(PRO_UI.priceText).toBe('Sponsor $5 a month, or $15 once. When you have paid $15 in total, Pro stays on.');
	});
});
