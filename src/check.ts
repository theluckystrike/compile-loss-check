// Core of Compile Loss Check: Longform scene order, paragraph split and the strict count comparison.
// No vault access here. main.ts reads the files and gives their text to checkCompile.
import { getFrontMatterInfo, parseYaml } from 'obsidian';

/** One scene from the scene list of a Longform index, in reading order. */
export interface Scene {
	name: string;
	/** Vault path of the scene note. */
	path: string;
	/** 0 for a top scene, 1 for a child of the scene before it, and so on. */
	depth: number;
}

export interface SceneOrder {
	scenes: Scene[];
	/** Exact errors. A non-empty list makes the check incomplete. */
	errors: string[];
}

/** One paragraph of a note, after whitespace normalization. */
export interface Paragraph {
	text: string;
	/** 1-based line of the first line of the paragraph in the note, frontmatter lines included. */
	line: number;
}

export interface Place {
	path: string;
	line: number;
}

/** A source paragraph that occurs more times in the sources than in the compiled note. */
export interface Unmatched {
	text: string;
	/** Source occurrences minus compiled occurrences. */
	missing: number;
	sourceCount: number;
	outputCount: number;
	/** Each source occurrence of the text. */
	places: Place[];
	/** True when some copies match: the check cannot tell which copy was lost. */
	uncertain: boolean;
	/** "quotes": the compiled note has the text with other quote marks. "inside": a longer compiled paragraph contains the text. */
	hint: 'quotes' | 'inside' | null;
}

export type Status = 'pass' | 'mismatch' | 'incomplete';

export interface CheckResult {
	status: Status;
	errors: string[];
	/** Paths of the scenes that the check read, in reading order. */
	scenes: string[];
	/** Number of source paragraphs compared. */
	checked: number;
	/** Number of paragraphs in the compiled note. */
	outputParagraphs: number;
	/** Number of source paragraphs that an exclusion removed. */
	excluded: number;
	unmatched: Unmatched[];
}

export interface Exclusions {
	/** Paragraph texts to skip. Whitespace is normalized before the comparison. */
	texts?: string[];
	/** Scene paths to skip. */
	paths?: string[];
}

export interface CheckInput {
	indexPath: string;
	indexText: string;
	outputPath: string;
	outputText: string;
	/** Text of each scene note that exists, by vault path. A path that is not here is a missing file. */
	files: Record<string, string>;
	/** Scene paths that changed while the scan read them. */
	changed?: string[];
	exclusions?: Exclusions;
}

/** Limits for one check. A larger manuscript gives an incomplete check, not a slow one. */
export const MAX_SCENES = 2000;
export const MAX_CHARS = 20_000_000;
/** Unmatched paragraphs that get a quote or containment hint. The rest get no hint. */
export const MAX_HINTS = 300;

export const STRICT_RULE =
	'The check is strict. Two paragraphs match only when their text is the same after whitespace normalization. A compile step that changes quotes, joins or splits paragraphs, or adds or removes text can cause a mismatch.';

/** Collapses each run of whitespace to one space and removes it at the two ends. */
export function normalizeText(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/** Lines that are only a thematic break (---, ***, ___). They hold no text, so the check skips them. */
function isRule(text: string): boolean {
	return /^(?:(?:- *){3,}|(?:\* *){3,}|(?:_ *){3,})$/.test(text);
}

/** True when an initial --- block is empty or holds YAML properties. Other text between two rules is body text. */
function isProperties(frontmatter: string): boolean {
	if (frontmatter.trim() === '') return true;
	try {
		const data: unknown = parseYaml(frontmatter);
		return data !== null && typeof data === 'object' && !Array.isArray(data);
	} catch {
		return false;
	}
}

/** Splits a note into paragraphs. Ignores only an initial frontmatter block of YAML properties. Blank lines separate paragraphs. */
export function splitParagraphs(content: string): Paragraph[] {
	const text = content.replace(/\r\n?/g, '\n');
	const fm = getFrontMatterInfo(text);
	const start = fm.exists && isProperties(fm.frontmatter) ? fm.contentStart : 0;
	const skipped = start > 0 ? text.slice(0, start).split('\n').length - 1 : 0;
	const lines = text.slice(start).split('\n');
	const out: Paragraph[] = [];
	let buf: string[] = [];
	let first = 0;
	const flush = () => {
		if (buf.length) {
			const t = normalizeText(buf.join(' '));
			if (t && !isRule(t)) out.push({ text: t, line: first + skipped + 1 });
		}
		buf = [];
	};
	lines.forEach((l, i) => {
		if (l.trim() === '') flush();
		else {
			if (!buf.length) first = i;
			buf.push(l);
		}
	});
	flush();
	return out;
}

/** Joins a folder and a relative path. Handles ".", ".." and "/". Returns null when the path leaves the vault. */
export function joinPath(dir: string, rel: string): string | null {
	const parts = dir.split('/').filter((p) => p !== '');
	for (const p of rel.split('/')) {
		if (p === '' || p === '.') continue;
		if (p === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(p);
	}
	return parts.join('/');
}

function dirOf(path: string): string {
	const i = path.lastIndexOf('/');
	return i < 0 ? '' : path.slice(0, i);
}

/** Reads the saved scene order of a Longform index note. */
export function parseSceneOrder(indexPath: string, indexText: string): SceneOrder {
	const fail = (e: string): SceneOrder => ({ scenes: [], errors: [e] });
	const fm = getFrontMatterInfo(indexText.replace(/\r\n?/g, '\n'));
	if (!fm.exists) return fail('The index note has no frontmatter.');
	let data: unknown;
	try {
		data = parseYaml(fm.frontmatter);
	} catch (e) {
		return fail(`The index frontmatter is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
	}
	const lf = data !== null && typeof data === 'object' ? (data as Record<string, unknown>).longform : undefined;
	if (lf === null || typeof lf !== 'object' || Array.isArray(lf)) return fail('The index frontmatter has no longform property.');
	const conf = lf as Record<string, unknown>;
	if (conf.format === 'single') return fail('This index is a single-note project. Only scenes projects are supported.');
	if (conf.format !== 'scenes') return fail(`The longform format is "${String(conf.format)}". Only "scenes" is supported.`);
	const sceneFolder = conf.sceneFolder === undefined || conf.sceneFolder === null ? '/' : conf.sceneFolder;
	if (typeof sceneFolder !== 'string') return fail('The longform sceneFolder is not text.');
	const folder = joinPath(dirOf(indexPath), sceneFolder);
	if (folder === null) return fail(`The sceneFolder "${sceneFolder}" is outside the vault.`);
	if (!Array.isArray(conf.scenes)) return fail('The longform property has no scenes list.');
	const scenes: Scene[] = [];
	const errors: string[] = [];
	const seen = new Set<string>();
	const walk = (list: unknown[], depth: number, where: string) => {
		let parent = depth > 0;
		list.forEach((item, i) => {
			const pos = `${where}${i + 1}`;
			if (Array.isArray(item)) {
				if (!parent) errors.push(`The scene list has a child list without a parent scene at position ${pos}.`);
				else walk(item, depth + 1, `${pos}.`);
				return;
			}
			if (typeof item !== 'string' || item.trim() === '') {
				errors.push(`The scene at position ${pos} is not a scene name.`);
				return;
			}
			parent = true;
			if (seen.has(item)) {
				errors.push(`The scene "${item}" is in the scene list two times.`);
				return;
			}
			seen.add(item);
			scenes.push({ name: item, path: folder ? `${folder}/${item}.md` : `${item}.md`, depth });
		});
	};
	walk(conf.scenes, 0, '');
	if (!scenes.length && !errors.length) errors.push('The scene list is empty.');
	if (scenes.length > MAX_SCENES) errors.push(`The scene list has ${scenes.length} scenes. The limit is ${MAX_SCENES}.`);
	return { scenes, errors };
}

/** Curly and other quote marks to straight quotes, for the quote hint only. The comparison stays strict. */
function straightQuotes(s: string): string {
	return s.replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″«»]/g, '"');
}

/** Compares source paragraphs with compiled paragraphs by occurrence count. */
export function compareParagraphs(sources: { path: string; paragraphs: Paragraph[] }[], output: Paragraph[], exclusions: Exclusions = {}): Pick<CheckResult, 'checked' | 'excluded' | 'unmatched'> {
	const skipText = new Set((exclusions.texts ?? []).map(normalizeText).filter((t) => t !== ''));
	const skipPath = new Set(exclusions.paths ?? []);
	const outCount = new Map<string, number>();
	for (const p of output) outCount.set(p.text, (outCount.get(p.text) ?? 0) + 1);
	const src = new Map<string, Place[]>();
	let checked = 0;
	let excluded = 0;
	for (const s of sources) {
		for (const p of s.paragraphs) {
			if (skipPath.has(s.path) || skipText.has(p.text)) {
				excluded++;
				continue;
			}
			checked++;
			const list = src.get(p.text);
			if (list) list.push({ path: s.path, line: p.line });
			else src.set(p.text, [{ path: s.path, line: p.line }]);
		}
	}
	const unmatched: Unmatched[] = [];
	for (const [text, places] of src) {
		const o = outCount.get(text) ?? 0;
		if (places.length <= o) continue;
		const missing = places.length - o;
		unmatched.push({ text, missing, sourceCount: places.length, outputCount: o, places, uncertain: missing < places.length, hint: null });
	}
	if (unmatched.length) {
		const straight = new Set(output.map((p) => straightQuotes(p.text)));
		for (const u of unmatched.slice(0, MAX_HINTS)) {
			if (u.outputCount === 0 && straight.has(straightQuotes(u.text))) {
				u.hint = 'quotes';
				continue;
			}
			if (output.some((p) => p.text.length > u.text.length && p.text.includes(u.text))) u.hint = 'inside';
		}
	}
	return { checked, excluded, unmatched };
}

/** The full check: scene order, missing files, changed files, size limit and the comparison. */
export function checkCompile(input: CheckInput): CheckResult {
	const order = parseSceneOrder(input.indexPath, input.indexText);
	const errors = [...order.errors];
	const changed = input.changed ?? [];
	const empty = (st: Status, errs: string[]): CheckResult => ({ status: st, errors: errs, scenes: [], checked: 0, outputParagraphs: 0, excluded: 0, unmatched: [] });
	if (changed.length) {
		return empty('incomplete', [...changed.map((p) => `"${p}" changed during the scan. Run a new scan.`)]);
	}
	if (order.scenes.length > MAX_SCENES) return empty('incomplete', errors);
	if (order.scenes.some((s) => s.path === input.outputPath)) errors.push(`The compiled note "${input.outputPath}" is also a scene.`);
	const read: string[] = [];
	const sources: { path: string; paragraphs: Paragraph[] }[] = [];
	let chars = input.outputText.length;
	for (const s of order.scenes) {
		const text = input.files[s.path];
		if (text === undefined) {
			errors.push(`The scene "${s.name}" has no note at "${s.path}".`);
			continue;
		}
		chars += text.length;
		read.push(s.path);
		sources.push({ path: s.path, paragraphs: splitParagraphs(text) });
	}
	if (chars > MAX_CHARS) return empty('incomplete', [...errors, `The notes have ${chars} characters. The limit is ${MAX_CHARS}.`]);
	const output = splitParagraphs(input.outputText);
	const cmp = compareParagraphs(sources, output, input.exclusions);
	const status: Status = errors.length ? 'incomplete' : cmp.unmatched.length ? 'mismatch' : 'pass';
	return { status, errors, scenes: read, checked: cmp.checked, outputParagraphs: output.length, excluded: cmp.excluded, unmatched: cmp.unmatched };
}

/** "2026-10-13 0930" in local time, for report names. */
export function fileStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** The first free report path: base.md, then base 2.md, base 3.md. Never a path in taken. */
export function reportPath(folder: string, base: string, taken: string[]): string {
	const has = new Set(taken);
	const prefix = folder ? `${folder}/` : '';
	const safe = base.replace(/[\\/:*?"<>|#^[\]]/g, '-');
	for (let n = 1; ; n++) {
		const p = `${prefix}${safe}${n === 1 ? '' : ` ${n}`}.md`;
		if (!has.has(p)) return p;
	}
}

const STATUS_TEXT: Record<Status, string> = {
	pass: 'Pass. Each source paragraph has a match in the compiled note.',
	mismatch: 'Mismatch. Some source paragraphs have no match in the compiled note.',
	incomplete: 'Incomplete check. The result is not a pass.',
};

export function statusText(s: Status): string {
	return STATUS_TEXT[s];
}

/** Escapes a path for a wikilink target. */
function link(path: string, line?: number): string {
	const target = path.replace(/\.md$/, '');
	return line ? `[[${target}|${path}]] line ${line}` : `[[${target}|${path}]]`;
}

/** Markdown text of a report for one or more compiled notes. */
export function renderReport(title: string, indexPath: string, runs: { outputPath: string; result: CheckResult }[], when: string): string {
	const lines: string[] = [`# ${title}`, '', `- Index: ${link(indexPath)}`, `- Date: ${when}`, ''];
	for (const { outputPath, result: r } of runs) {
		if (runs.length > 1) lines.push(`## ${outputPath}`, '');
		lines.push(`- Compiled note: ${link(outputPath)}`, `- Result: ${statusText(r.status)}`, `- Scenes read: ${r.scenes.length}`, `- Source paragraphs checked: ${r.checked}`, `- Compiled paragraphs: ${r.outputParagraphs}`);
		if (r.excluded) lines.push(`- Paragraphs excluded by the profile: ${r.excluded}`);
		lines.push(`- Unmatched paragraphs: ${r.unmatched.length}`, '');
		const h = runs.length > 1 ? '###' : '##';
		if (r.errors.length) {
			lines.push(`${h} Errors`, '');
			for (const e of r.errors) lines.push(`- ${e}`);
			lines.push('');
		}
		if (r.unmatched.length) {
			lines.push(`${h} Unmatched paragraphs`, '', STRICT_RULE, '');
			for (const u of r.unmatched) {
				lines.push(`> ${u.text}`, '');
				const count = u.missing === 1 ? '1 occurrence' : `${u.missing} occurrences`;
				lines.push(`- Missing: ${count} (source ${u.sourceCount}, compiled ${u.outputCount}).`);
				if (u.uncertain) lines.push('- Repeated text. The source copy that was lost is not certain. Possible source lines:');
				else lines.push(u.places.length === 1 ? '- Source line:' : '- Source lines:');
				for (const p of u.places) lines.push(`  - ${link(p.path, p.line)}`);
				if (u.hint === 'quotes') lines.push('- The compiled note has this text with other quote marks.');
				if (u.hint === 'inside') lines.push('- A longer compiled paragraph contains this text. The compile step can have joined paragraphs.');
				lines.push('');
			}
		}
	}
	return lines.join('\n');
}
