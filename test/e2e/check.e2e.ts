import { browser, expect } from '@wdio/globals';
import { pluginId } from './load';

// Real-app checks on the sample Longform project (test/e2e/vault/Compile Loss Check, a copy of docs/sample-notes).
// The same numbers are pinned in tests/sample.test.ts. No fixed waits: each step waits for a state.
const DIR = 'Compile Loss Check';

interface Summary {
	statuses: string[];
	unmatched: number[];
	reportPath: string | null;
	report: string;
}

/** Runs plugin.runCheck in the app, reads the report, deletes it, and returns a summary. */
async function runCheck(index: string, outputs: string[]): Promise<Summary> {
	return browser.executeObsidian(
		async ({ app }, id, index, outputs) => {
			interface Out {
				runs: { result: { status: string; unmatched: unknown[] } }[];
				reportPath: string | null;
			}
			const p = (app as unknown as { plugins: { plugins: Record<string, { runCheck(i: string, o: string[]): Promise<Out> }> } }).plugins.plugins[id]!;
			const out = await p.runCheck(index, outputs);
			const f = out.reportPath ? app.vault.getFileByPath(out.reportPath) : null;
			const report = f ? await app.vault.read(f) : '';
			if (f) await app.vault.delete(f);
			return { statuses: out.runs.map((r) => r.result.status), unmatched: out.runs.map((r) => r.result.unmatched.length), reportPath: out.reportPath, report };
		},
		pluginId,
		index,
		outputs,
	);
}

describe(`${pluginId} check in the app`, function () {
	it('finds the lost, changed and repeated paragraphs of the sample manuscript', async function () {
		const s = await runCheck(`${DIR}/Index.md`, [`${DIR}/Manuscript.md`]);
		expect(s.statuses).toEqual(['mismatch']);
		expect(s.unmatched).toEqual([5]);
		expect(s.reportPath).toMatch(/^Compile Loss Check\/Compile check Manuscript /);
		expect(s.report).toContain('> He did not ask why she had come. He put a kettle on the stove and waited.');
		expect(s.report).toContain('[[Compile Loss Check/Scenes/Keeper|Compile Loss Check/Scenes/Keeper.md]] line 3');
		expect(s.report).toContain('Repeated text. The source copy that was lost is not certain.');
		expect(s.report).toContain('The compiled note has this text with other quote marks.');
	});

	it('shows an incomplete check for an index with a missing scene', async function () {
		const s = await runCheck(`${DIR}/Broken index.md`, [`${DIR}/Manuscript.md`]);
		expect(s.statuses).toEqual(['incomplete']);
		expect(s.report).toContain('The scene "Harbor" has no note at "Compile Loss Check/Scenes/Harbor.md".');
		expect(s.report).toContain('Incomplete check. The result is not a pass.');
	});

	it('lists the sample index notes in the index picker', async function () {
		const paths = await browser.executeObsidian(({ app }, id) => {
			const p = (app as unknown as { plugins: { plugins: Record<string, { indexNotes(): { path: string }[] }> } }).plugins.plugins[id]!;
			return p.indexNotes().map((f) => f.path);
		}, pluginId);
		expect(paths).toEqual([`${DIR}/Broken index.md`, `${DIR}/Index.md`]);
	});

	it('selects both notes and opens the saved report from the result', async function () {
		await browser.executeObsidianCommand(`${pluginId}:check`);
		const indexInput = await browser.$('input[placeholder="Select the Longform index note"]');
		await indexInput.waitForDisplayed({ timeout: 20000 });
		await indexInput.setValue(`${DIR}/Index.md`);
		await browser.waitUntil(async () => {
			const texts = await browser.$$('.prompt .suggestion-item').map((n) => n.getText());
			return texts[0] === `${DIR}/Index.md`;
		}, { timeout: 20000 });
		await browser.keys(['Enter']);
		const outputInput = await browser.$('input[placeholder="Select the compiled manuscript note"]');
		await outputInput.waitForDisplayed({ timeout: 20000 });
		await outputInput.setValue(`${DIR}/Manuscript ebook.md`);
		await browser.waitUntil(async () => {
			const texts = await browser.$$('.prompt .suggestion-item').map((n) => n.getText());
			return texts[0] === `${DIR}/Manuscript ebook.md`;
		}, { timeout: 20000 });
		await browser.keys(['Enter']);
		const status = await browser.$('.clc-modal .clc-status');
		await status.waitForDisplayed({ timeout: 20000 });
		expect(await status.getText()).toBe('Mismatch. Some source paragraphs have no match in the compiled note.');
		await browser.$('.clc-modal button').click();
		await browser.waitUntil(async () => browser.executeObsidian(({ app }) => {
			const path = app.workspace.getMostRecentLeaf()?.getViewState().state?.file;
			return typeof path === 'string' && path.startsWith('Compile Loss Check/Compile check Manuscript ebook ');
		}), { timeout: 20000 });
		const report = await browser.executeObsidian(async ({ app }) => {
			const leaf = app.workspace.getMostRecentLeaf();
			const path = leaf?.getViewState().state?.file as string;
			const file = app.vault.getFileByPath(path);
			const text = file ? await app.vault.read(file) : '';
			leaf?.detach();
			if (file) await app.vault.delete(file);
			return text;
		});
		expect(report).toContain('> Check the ferry timetable for October.');
	});

	it('Pro commands show a notice without Pro', async function () {
		await browser.executeObsidianCommand(`${pluginId}:run-profile`);
		await browser.waitUntil(async () => {
			const texts = await browser.$$('.notice').map((n) => n.getText());
			return texts.some((t) => t.includes('Comparison profiles are a Pro feature.'));
		}, { timeout: 20000, timeoutMsg: 'The Pro notice did not appear.' });
	});
});
