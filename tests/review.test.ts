import { describe, expect, it } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import CompileLossCheckPlugin from '../src/main';
import { MAX_SCENES, checkCompile, splitParagraphs } from '../src/check';
import manifest from '../manifest.json';

const INDEX_A = '---\nlongform:\n  format: scenes\n  scenes: [A]\n---\n';

describe('review regressions', () => {
	it('checks text between two rules at the start of a scene when it is not YAML properties', () => {
		const scene = '---\nThe keeper lit the lamp at dusk.\n---\n\nBody.\n';
		const r = checkCompile({ indexPath: 'I.md', indexText: INDEX_A, outputPath: 'O.md', outputText: 'Body.\n', files: { 'A.md': scene } });
		expect(r.status).toBe('mismatch');
		expect(r.unmatched.map((u) => u.text)).toEqual(['--- The keeper lit the lamp at dusk. ---']);
		expect(r.unmatched[0].places).toEqual([{ path: 'A.md', line: 1 }]);
	});

	it('still ignores YAML properties and an empty block at the start of a note', () => {
		expect(splitParagraphs('---\ntitle: One\ntags: [a]\n---\n\nBody.\n')).toEqual([{ text: 'Body.', line: 6 }]);
		expect(splitParagraphs('---\n---\nBody.\n')).toEqual([{ text: 'Body.', line: 3 }]);
	});

	it('skips each kind of thematic break that the README names', () => {
		expect(splitParagraphs('A.\n\n---\n\nB.\n\n***\n\nC.\n\n___\n\nD.\n\n* * *\n').map((p) => p.text)).toEqual(['A.', 'B.', 'C.', 'D.']);
	});

	it('does not read the scenes of a project over the scene limit', async () => {
		const names = Array.from({ length: MAX_SCENES + 1 }, (_, i) => `S${i}`);
		const files: Record<string, string> = { 'I.md': `---\nlongform:\n  format: scenes\n  scenes: ${JSON.stringify(names)}\n---\n`, 'O.md': 'Alpha.\n' };
		for (const n of names) files[`${n}.md`] = 'Alpha.\n';
		const app = App.createConfigured__({ files });
		const plugin = new CompileLossCheckPlugin(app as never, manifest as never);
		await plugin.loadSettings();
		const read = app.vault.read.bind(app.vault);
		let reads = 0;
		app.vault.read = ((f: never) => {
			reads++;
			return read(f);
		}) as never;
		const out = await plugin.runCheck('I.md', ['O.md']);
		expect(out.runs[0].result.status).toBe('incomplete');
		expect(out.runs[0].result.errors).toEqual([`The scene list has ${MAX_SCENES + 1} scenes. The limit is ${MAX_SCENES}.`]);
		expect(reads).toBe(2);
	});
});
