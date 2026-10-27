import { describe, expect, it, vi } from 'vitest';
import { App } from 'obsidian-test-mocks/obsidian';
import manifest from '../manifest.json';

// Record each Pro notice lead. The other parts of the Pro facade stay real (free user: no manager).
const leads: string[] = [];
vi.mock('../src/pro', async (orig) => ({ ...(await orig<Record<string, unknown>>()), proNotice: (lead: string) => void leads.push(lead) }));
const { default: CompileLossCheckPlugin } = await import('../src/main');

describe('Pro notice lead', () => {
	it('a free user who runs a comparison profile gets the lead "Comparison profiles are a Pro feature."', async () => {
		const app = App.createConfigured__({ files: {} });
		const plugin = new CompileLossCheckPlugin(app as never, manifest as never);
		await plugin.loadSettings();
		leads.length = 0;
		expect(await plugin.runProfile({ name: 'P', indexPath: 'I.md', outputPaths: ['O.md'], excludeTexts: [], excludePaths: [] }, false)).toBeNull();
		expect(leads).toEqual(['Comparison profiles are a Pro feature.']);
	});
});
