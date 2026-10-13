// Modals: pick an index, pick a compiled note, show progress and the result, edit a profile, pick a profile or a report.
import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from 'obsidian';
import { statusText, STRICT_RULE, type CheckResult } from './check';
import type { HistoryEntry, Profile } from './settings';

/** Picks one Markdown note from a list. */
export class NotePickModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		placeholder: string,
		empty: string,
		private readonly onPick: (f: TFile) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = empty;
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(f: TFile): string {
		return f.path;
	}

	onChooseItem(f: TFile): void {
		this.onPick(f);
	}
}

/** Picks one item of a list by its label. */
export class ListPickModal<T> extends FuzzySuggestModal<T> {
	constructor(
		app: App,
		private readonly items: T[],
		private readonly label: (t: T) => string,
		placeholder: string,
		empty: string,
		private readonly onPick: (t: T) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
		this.emptyStateText = empty;
	}

	getItems(): T[] {
		return this.items;
	}

	getItemText(t: T): string {
		return this.label(t);
	}

	onChooseItem(t: T): void {
		this.onPick(t);
	}
}

export function profileLabel(p: Profile): string {
	return `${p.name}: ${p.outputPaths.length === 1 ? p.outputPaths[0] : `${p.outputPaths.length} compiled notes`}`;
}

export function historyLabel(h: HistoryEntry): string {
	const who = h.profile ? `${h.profile}, ` : '';
	return `${h.date} ${who}${h.status}, ${h.unmatched} unmatched: ${h.reportPath}`;
}

/** Shows the progress of a check, then its result and a button that opens the report. */
export class CheckModal extends Modal {
	private progressEl: HTMLElement;
	private bodyEl: HTMLElement;

	constructor(app: App) {
		super(app);
		this.setTitle('Compile loss check');
		this.modalEl.addClass('clc-modal');
		this.progressEl = this.contentEl.createDiv({ cls: 'clc-progress', text: 'Starting the check.' });
		this.bodyEl = this.contentEl.createDiv({ cls: 'clc-body' });
	}

	setProgress(text: string): void {
		this.progressEl.setText(text);
	}

	/** Shows the results. One entry for each compiled note. */
	showResults(runs: { outputPath: string; result: CheckResult }[], reportPath: string | null, openReport: () => void, reportError?: string): void {
		this.progressEl.setText(reportPath ? `Report saved to ${reportPath}.` : (reportError ?? 'No report was saved.'));
		this.bodyEl.empty();
		for (const { outputPath, result: r } of runs) {
			const box = this.bodyEl.createDiv({ cls: `clc-result clc-${r.status}` });
			if (runs.length > 1) box.createEl('h3', { text: outputPath });
			box.createEl('p', { cls: 'clc-status', text: statusText(r.status) });
			box.createEl('p', { text: `Scenes read: ${r.scenes.length}. Source paragraphs checked: ${r.checked}. Compiled paragraphs: ${r.outputParagraphs}. Unmatched: ${r.unmatched.length}.` });
			if (r.excluded) box.createEl('p', { text: `Paragraphs excluded by the profile: ${r.excluded}.` });
			if (r.errors.length) {
				const ul = box.createEl('ul', { cls: 'clc-errors' });
				for (const e of r.errors) ul.createEl('li', { text: e });
			}
			if (r.unmatched.length) {
				box.createEl('p', { cls: 'clc-rule', text: STRICT_RULE });
				const ul = box.createEl('ul', { cls: 'clc-unmatched' });
				for (const u of r.unmatched.slice(0, 20)) {
					const li = ul.createEl('li');
					li.createDiv({ cls: 'clc-text', text: u.text });
					const where = u.places.map((p) => `${p.path} line ${p.line}`).join('; ');
					li.createDiv({ cls: 'clc-where', text: u.uncertain ? `Repeated text, missing ${u.missing} of ${u.sourceCount}. Possible source lines: ${where}` : where });
				}
				if (r.unmatched.length > 20) box.createEl('p', { text: `The report lists ${r.unmatched.length - 20} more.` });
			}
		}
		if (reportPath) {
			new Setting(this.bodyEl).addButton((b) =>
				b
					.setButtonText('Open report')
					.setCta()
					.onClick(() => {
						openReport();
						this.close();
					}),
			);
		}
	}
}

/** Pro: edits the name, the compiled notes and the exclusions of a profile. */
export class ProfileModal extends Modal {
	constructor(
		app: App,
		private readonly draft: Profile,
		private readonly addOutput: (done: (path: string) => void) => void,
		private readonly onSave: (p: Profile) => void,
	) {
		super(app);
		this.setTitle('Save comparison profile');
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		const d = this.draft;
		new Setting(el).setName('Name').addText((t) => t.setValue(d.name).onChange((v) => (d.name = v)));
		new Setting(el).setName('Index').setDesc(d.indexPath);
		const outs = new Setting(el).setName('Compiled notes').setDesc(d.outputPaths.join(', '));
		outs.addButton((b) =>
			b.setButtonText('Add a compiled note').onClick(() =>
				this.addOutput((p) => {
					if (!d.outputPaths.includes(p)) d.outputPaths.push(p);
					this.render();
				}),
			),
		);
		new Setting(el)
			.setName('Paragraphs to skip')
			.setDesc('One paragraph text for each line. The check skips source paragraphs with this text.')
			.addTextArea((t) => t.setValue(d.excludeTexts.join('\n')).onChange((v) => (d.excludeTexts = v.split('\n').filter((x) => x.trim()))));
		new Setting(el)
			.setName('Scenes to skip')
			.setDesc('One scene note path for each line, with the folder and the .md extension.')
			.addTextArea((t) => t.setValue(d.excludePaths.join('\n')).onChange((v) => (d.excludePaths = v.split('\n').map((x) => x.trim()).filter((x) => x))));
		new Setting(el).addButton((b) =>
			b
				.setButtonText('Save')
				.setCta()
				.onClick(() => {
					if (!d.name.trim()) return;
					this.onSave({ ...d, name: d.name.trim() });
					this.close();
				}),
		);
	}
}
