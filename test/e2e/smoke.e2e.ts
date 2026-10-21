import { browser, expect } from '@wdio/globals';
import { pluginId, reloadPlugin } from './load';

describe(`${pluginId} smoke test`, function () {
	it('is enabled and reloads with no console errors', async function () {
		const state = await reloadPlugin(pluginId);
		expect(state).toEqual({ enabled: true, reloaded: true, errors: [] });
	});

	it('registers its commands', async function () {
		const ids = await browser.executeObsidian(({ app }, id) => {
			const cmds = (app as unknown as { commands: { commands: Record<string, unknown> } }).commands.commands;
			return Object.keys(cmds).filter((k) => k.startsWith(`${id}:`)).sort();
		}, pluginId);
		expect(ids).toEqual(['check', 'delete-profile', 'open-history', 'run-profile', 'save-profile', 'send-feedback', 'show-whats-new'].map((c) => `${pluginId}:${c}`));
	});
});
