// The sample project in docs/sample-notes (also the end-to-end vault). The same numbers are pinned in test/e2e/check.e2e.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCompile } from '../src/check';

const ROOT = join(__dirname, '..', 'docs', 'sample-notes');
const DIR = 'Compile Loss Check';
const files: Record<string, string> = {};
for (const f of readdirSync(join(ROOT, 'Scenes'))) files[`${DIR}/Scenes/${f}`] = readFileSync(join(ROOT, 'Scenes', f), 'utf8');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const run = (index: string, output: string, paths: string[] = []) =>
	checkCompile({ indexPath: `${DIR}/${index}`, indexText: read(index), outputPath: `${DIR}/${output}`, outputText: read(output), files, exclusions: { paths } });
const S = (n: string) => `${DIR}/Scenes/${n}.md`;

describe('sample project', () => {
	it('Manuscript.md lost one paragraph, changed quotes, dropped one repeat and left out the research notes', () => {
		const r = run('Index.md', 'Manuscript.md');
		expect(r.status).toBe('mismatch');
		expect(r.scenes).toEqual(['Arrival', 'Storm', 'Keeper', 'Lamp', 'Morning', 'Research notes'].map(S));
		expect(r.checked).toBe(15);
		expect(r.unmatched.map((u) => [u.text.slice(0, 20), u.places.map((p) => `${p.path.split('/').pop()}:${p.line}`), u.uncertain, u.hint])).toEqual([
			['The light turned.', ['Storm.md:3', 'Morning.md:3'], true, null],
			['He did not ask why s', ['Keeper.md:3'], false, null],
			['"It never stops," th', ['Lamp.md:3'], false, 'quotes'],
			['Check the ferry time', ['Research notes.md:1'], false, null],
			['Find a real name for', ['Research notes.md:3'], false, null],
		]);
	});

	it('Manuscript ebook.md misses only the research notes', () => {
		const r = run('Index.md', 'Manuscript ebook.md');
		expect(r.unmatched.map((u) => u.places[0]!.path)).toEqual([S('Research notes'), S('Research notes')]);
	});

	it('a path exclusion of the research notes leaves 3 unmatched and 1 pass', () => {
		expect(run('Index.md', 'Manuscript.md', [S('Research notes')]).unmatched.length).toBe(3);
		expect(run('Index.md', 'Manuscript ebook.md', [S('Research notes')]).status).toBe('pass');
	});

	it('Broken index.md names a scene with no note', () => {
		const r = run('Broken index.md', 'Manuscript.md');
		expect(r.status).toBe('incomplete');
		expect(r.errors).toEqual([`The scene "Harbor" has no note at "${S('Harbor')}".`]);
	});
});
