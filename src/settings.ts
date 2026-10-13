import { PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { sponsorsSettingItems } from './license/github-obsidian';
import type { Status } from './check';
import { PRO_UI, isPro } from './pro';
import type CompileLossCheckPlugin from './main';

/** Pro: a named comparison. One index, one or more compiled notes, and explicit exclusions. */
export interface Profile {
	name: string;
	indexPath: string;
	outputPaths: string[];
	/** Paragraph texts to skip. */
	excludeTexts: string[];
	/** Scene paths to skip. */
	excludePaths: string[];
}

/** Pro: one saved report in the history. */
export interface HistoryEntry {
	date: string;
	profile: string;
	indexPath: string;
	outputPaths: string[];
	status: Status;
	unmatched: number;
	reportPath: string;
}

export interface CompileLossCheckSettings {
	/** Folder for new reports. Empty = the folder of the compiled note. */
	reportFolder: string;
	profiles: Profile[];
	history: HistoryEntry[];
}

export const HISTORY_MAX = 200;

export const DEFAULT_SETTINGS: CompileLossCheckSettings = {
	reportFolder: '',
	profiles: [],
	history: [],
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const STATUSES: Status[] = ['pass', 'mismatch', 'incomplete'];

function normalizeProfile(v: unknown): Profile | null {
	if (v === null || typeof v !== 'object') return null;
	const p = v as Record<string, unknown>;
	if (typeof p.name !== 'string' || !p.name.trim() || typeof p.indexPath !== 'string') return null;
	const outputPaths = strings(p.outputPaths);
	if (!outputPaths.length) return null;
	return { name: p.name, indexPath: p.indexPath, outputPaths, excludeTexts: strings(p.excludeTexts), excludePaths: strings(p.excludePaths) };
}

function normalizeEntry(v: unknown): HistoryEntry | null {
	if (v === null || typeof v !== 'object') return null;
	const h = v as Record<string, unknown>;
	if (typeof h.date !== 'string' || typeof h.reportPath !== 'string' || typeof h.indexPath !== 'string') return null;
	return {
		date: h.date,
		profile: typeof h.profile === 'string' ? h.profile : '',
		indexPath: h.indexPath,
		outputPaths: strings(h.outputPaths),
		status: STATUSES.includes(h.status as Status) ? (h.status as Status) : 'incomplete',
		unmatched: typeof h.unmatched === 'number' && Number.isFinite(h.unmatched) ? h.unmatched : 0,
		reportPath: h.reportPath,
	};
}

/** Fills gaps and drops bad values from saved data, so old or hand-edited data.json never breaks the plugin. */
export function normalizeSettings(saved: Partial<CompileLossCheckSettings> | null | undefined): CompileLossCheckSettings {
	const s = saved ?? {};
	const folder = typeof s.reportFolder === 'string' ? s.reportFolder.trim().replace(/^\/+|\/+$/g, '') : DEFAULT_SETTINGS.reportFolder;
	const profiles = Array.isArray(s.profiles) ? s.profiles.map(normalizeProfile).filter((p): p is Profile => p !== null) : [];
	const history = Array.isArray(s.history) ? s.history.map(normalizeEntry).filter((h): h is HistoryEntry => h !== null) : [];
	return { reportFolder: folder, profiles, history: history.slice(-HISTORY_MAX) };
}

export class CompileLossCheckSettingTab extends PluginSettingTab {
	plugin: CompileLossCheckPlugin;

	constructor(app: ConstructorParameters<typeof PluginSettingTab>[0], plugin: CompileLossCheckPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const n = this.plugin.settings.profiles.length;
		return [
			...(this.plugin.pro ? sponsorsSettingItems(this.plugin.pro, PRO_UI) : []),
			{
				name: 'Report folder',
				desc: 'Folder for new reports. Leave empty to save each report next to its compiled note. The plugin makes the folder if it does not exist.',
				control: { type: 'text', key: 'reportFolder', defaultValue: DEFAULT_SETTINGS.reportFolder, placeholder: 'Compile checks' },
			},
			{
				name: 'Pro features',
				desc: isPro()
					? `Pro is on. Saved profiles: ${n}. Saved reports in the history: ${this.plugin.settings.history.length}.`
					: 'Free version: check one Longform index against one compiled note and save a new report. Pro adds named profiles with exclusions, a check of several compiled notes in one report, and a report history.',
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		this.plugin.settings = normalizeSettings(this.plugin.settings);
	}
}
