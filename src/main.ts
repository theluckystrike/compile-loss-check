import { Notice, Plugin, TFile, normalizePath, type TAbstractFile } from 'obsidian';
import type { SponsorsManager } from './license/index';
import { createGitHubSponsors } from './license/github-obsidian';
import { MAX_SCENES, checkCompile, fileStamp, parseSceneOrder, renderReport, reportPath, type CheckResult, type Exclusions } from './check';
import { SPONSORS, bindPro, isPro, resetPro, proNotice } from './pro';
import { DEFAULT_SETTINGS, CompileLossCheckSettingTab, HISTORY_MAX, normalizeSettings, type CompileLossCheckSettings, type Profile } from './settings';
import { CheckModal, ListPickModal, NotePickModal, ProfileModal, historyLabel, profileLabel } from './ui';
import { setupHello } from './hello/index';
import WHATS_NEW from './whats-new.json';

/** How often to ask the license state whether a check is due. It sends a request only when signed in and due (7 days). */
const PRO_TICK_MS = 6 * 60 * 60 * 1000;
/** Files read between two pauses, so the progress text can draw. */
const YIELD_EVERY = 20;

export interface RunOptions {
	exclusions?: Exclusions;
	profile?: string;
	/** Shows progress and the result. Without it the run is silent (tests). */
	modal?: CheckModal;
}

export interface RunOutcome {
	runs: { outputPath: string; result: CheckResult }[];
	reportPath: string | null;
	reportError?: string;
}

export function needsPro(feature: string): void {
	proNotice(`${feature} is a pro feature.`);
}

export default class CompileLossCheckPlugin extends Plugin {
	settings: CompileLossCheckSettings = { ...DEFAULT_SETTINGS };
	/** GitHub Sponsors Pro state. Created in onload; null before that. */
	pro: SponsorsManager | null = null;
	private settingTab: CompileLossCheckSettingTab | null = null;
	/** The index and compiled note of the last check, for "Save comparison profile". */
	last: { indexPath: string; outputPaths: string[] } | null = null;
	/** The result modal of the last check. The end-to-end test reads it. */
	lastModal: CheckModal | null = null;

	async onload(): Promise<void> {
		// First: "What's new" reads its state before the settings load (packages/hello). It does not wait.
		setupHello(this, WHATS_NEW);
		await this.loadSettings();
		// No request here: a request needs a GitHub sign in first (Settings, Pro, Sign in with GitHub).
		const pro = createGitHubSponsors(this.app, this.manifest.id, SPONSORS, this);
		pro.init();
		this.pro = pro;
		bindPro(pro);
		this.settingTab = new CompileLossCheckSettingTab(this.app, this);
		this.register(pro.onChange(() => this.settingTab?.update()));
		this.addSettingTab(this.settingTab);

		this.addCommand({ id: 'check', name: 'Check a compiled manuscript', callback: () => this.pickAndCheck() });
		this.addCommand({ id: 'save-profile', name: 'Save the last check as a comparison profile', callback: () => this.saveProfileCommand() });
		this.addCommand({ id: 'run-profile', name: 'Run a comparison profile', callback: () => this.runProfileCommand() });
		this.addCommand({ id: 'delete-profile', name: 'Delete a comparison profile', callback: () => this.deleteProfileCommand() });
		this.addCommand({ id: 'open-history', name: 'Open a report from the history', callback: () => this.historyCommand() });

		this.app.workspace.onLayoutReady(() => {
			void pro.refresh();
			this.registerInterval(window.setInterval(() => void pro.refresh(), PRO_TICK_MS));
		});
	}

	onunload(): void {
		resetPro();
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<CompileLossCheckSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** Markdown notes with a longform property in their frontmatter. */
	indexNotes(): TFile[] {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => {
				const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
				return fm !== undefined && fm.longform !== undefined;
			})
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	private pickOutput(exclude: string[], onPick: (f: TFile) => void): void {
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((f) => !exclude.includes(f.path))
			.sort((a, b) => a.path.localeCompare(b.path));
		new NotePickModal(this.app, files, 'Select the compiled manuscript note', 'No Markdown note found.', onPick).open();
	}

	private pickAndCheck(): void {
		new NotePickModal(this.app, this.indexNotes(), 'Select the Longform index note', 'No note with a longform property found.', (index) => {
			this.pickOutput([index.path], (out) => void this.runWithModal(index.path, [out.path]));
		}).open();
	}

	private async runWithModal(indexPath: string, outputPaths: string[], opts: Omit<RunOptions, 'modal'> = {}): Promise<RunOutcome> {
		const modal = new CheckModal(this.app);
		this.lastModal = modal;
		modal.open();
		return this.runCheck(indexPath, outputPaths, { ...opts, modal });
	}

	/**
	 * Reads the index, the scenes and each compiled note, compares them and saves a new report.
	 * A file that changes during the reads gives an incomplete check. The report never replaces a file.
	 */
	async runCheck(indexPath: string, outputPaths: string[], opts: RunOptions = {}): Promise<RunOutcome> {
		const vault = this.app.vault;
		const modal = opts.modal;
		const changed = new Set<string>();
		const ref = vault.on('modify', (f: TAbstractFile) => changed.add(f.path));
		const runs: RunOutcome['runs'] = [];
		try {
			const indexFile = vault.getAbstractFileByPath(indexPath);
			const indexText = indexFile instanceof TFile ? await vault.read(indexFile) : '';
			const order = parseSceneOrder(indexPath, indexText);
			const files: Record<string, string> = {};
			let n = 0;
			// Over the scene limit the check is incomplete, so it reads no scene.
			for (const s of order.scenes.length > MAX_SCENES ? [] : order.scenes) {
				n++;
				const f = vault.getAbstractFileByPath(s.path);
				if (f instanceof TFile) files[s.path] = await vault.read(f);
				if (n % YIELD_EVERY === 0) {
					modal?.setProgress(`Reading scene ${n} of ${order.scenes.length}.`);
					await new Promise((r) => window.setTimeout(r, 0));
				}
			}
			for (const outputPath of outputPaths) {
				const of = vault.getAbstractFileByPath(outputPath);
				const outputText = of instanceof TFile ? await vault.read(of) : '';
				modal?.setProgress(`Comparing with ${outputPath}.`);
				await new Promise((r) => window.setTimeout(r, 0));
				const watched = [indexPath, outputPath, ...order.scenes.map((s) => s.path)];
				const result = checkCompile({ indexPath, indexText, outputPath, outputText, files, changed: watched.filter((p) => changed.has(p)), exclusions: opts.exclusions });
				if (!(indexFile instanceof TFile)) result.errors.unshift(`The index note "${indexPath}" does not exist.`);
				if (!(of instanceof TFile)) result.errors.unshift(`The compiled note "${outputPath}" does not exist.`);
				if (result.errors.length) result.status = 'incomplete';
				runs.push({ outputPath, result });
			}
		} finally {
			vault.offref(ref);
		}
		this.last = { indexPath, outputPaths: [...outputPaths] };
		let saved: string | null = null;
		let reportError: string | undefined;
		try {
			saved = await this.saveReport(indexPath, runs, opts.profile);
		} catch (e) {
			reportError = `The report was not saved: ${e instanceof Error ? e.message : String(e)}`;
		}
		if (saved && isPro()) {
			const worst = runs.some((r) => r.result.status === 'incomplete') ? 'incomplete' : runs.some((r) => r.result.status === 'mismatch') ? 'mismatch' : 'pass';
			this.settings.history.push({
				date: fileStamp(new Date()),
				profile: opts.profile ?? '',
				indexPath,
				outputPaths: [...outputPaths],
				status: worst,
				unmatched: runs.reduce((a, r) => a + r.result.unmatched.length, 0),
				reportPath: saved,
			});
			this.settings.history = this.settings.history.slice(-HISTORY_MAX);
			await this.saveSettings();
		}
		modal?.showResults(runs, saved, () => void this.openPath(saved), reportError);
		return { runs, reportPath: saved, reportError };
	}

	/** Writes a new report note. Picks a new name when the path exists, and never modifies a file. */
	private async saveReport(indexPath: string, runs: RunOutcome['runs'], profile?: string): Promise<string> {
		const vault = this.app.vault;
		const first = runs[0]?.outputPath ?? indexPath;
		const outDir = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
		const folder = this.settings.reportFolder ? normalizePath(this.settings.reportFolder) : outDir;
		if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
		const now = new Date();
		const name = profile ? profile : (first.split('/').pop() ?? first).replace(/\.md$/, '');
		const base = `Compile check ${name} ${fileStamp(now)}`;
		const title = `Compile check: ${name}`;
		const text = renderReport(title, indexPath, runs, now.toLocaleString());
		const taken = vault.getFiles().map((f) => f.path);
		for (let i = 0; i < 5; i++) {
			const path = reportPath(folder, base, taken);
			if (vault.getAbstractFileByPath(path)) {
				taken.push(path);
				continue;
			}
			try {
				await vault.create(path, text);
				return path;
			} catch (e) {
				if (!vault.getAbstractFileByPath(path)) throw e;
				taken.push(path);
			}
		}
		throw new Error('No free report path was found.');
	}

	async openPath(path: string | null): Promise<void> {
		if (!path) return;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(f);
		else new Notice(`The report "${path}" does not exist.`);
	}

	private saveProfileCommand(): void {
		if (!isPro()) return needsPro('Comparison profiles');
		const last = this.last;
		if (!last) {
			new Notice('Run a check first. The profile uses the index and compiled note of the last check.');
			return;
		}
		const draft: Profile = { name: '', indexPath: last.indexPath, outputPaths: [...last.outputPaths], excludeTexts: [], excludePaths: [] };
		new ProfileModal(
			this.app,
			draft,
			(done) => this.pickOutput([last.indexPath, ...draft.outputPaths], (f) => done(f.path)),
			(p) => void this.saveProfile(p),
		).open();
	}

	/** Pro: adds a profile, or replaces the profile with the same name. */
	async saveProfile(p: Profile): Promise<void> {
		const i = this.settings.profiles.findIndex((x) => x.name === p.name);
		if (i >= 0) this.settings.profiles[i] = p;
		else this.settings.profiles.push(p);
		await this.saveSettings();
		new Notice(i >= 0 ? `Profile "${p.name}" updated.` : `Profile "${p.name}" saved.`);
	}

	/** Pro: runs a profile with its exclusions against each of its compiled notes. */
	async runProfile(p: Profile, withModal = true): Promise<RunOutcome | null> {
		if (!isPro()) {
			needsPro('Comparison profiles');
			return null;
		}
		const opts = { exclusions: { texts: p.excludeTexts, paths: p.excludePaths }, profile: p.name };
		return withModal ? this.runWithModal(p.indexPath, p.outputPaths, opts) : this.runCheck(p.indexPath, p.outputPaths, opts);
	}

	private runProfileCommand(): void {
		if (!isPro()) return needsPro('Comparison profiles');
		new ListPickModal(this.app, this.settings.profiles, profileLabel, 'Select a profile', 'No saved profile.', (p) => void this.runProfile(p)).open();
	}

	private deleteProfileCommand(): void {
		if (!isPro()) return needsPro('Comparison profiles');
		new ListPickModal(this.app, this.settings.profiles, profileLabel, 'Select a profile to delete', 'No saved profile.', (p) => {
			this.settings.profiles = this.settings.profiles.filter((x) => x !== p);
			void this.saveSettings();
			new Notice(`Profile "${p.name}" deleted. Its reports stay in the vault.`);
		}).open();
	}

	private historyCommand(): void {
		if (!isPro()) return needsPro('Report history');
		const items = [...this.settings.history].reverse();
		new ListPickModal(this.app, items, historyLabel, 'Select a report', 'No report in the history.', (h) => void this.openPath(h.reportPath)).open();
	}
}
