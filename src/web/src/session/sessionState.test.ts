import { describe, expect, it } from 'vitest';
import { createSessionSnapshot, isEmptySessionSnapshot, normalizeSessionSnapshot } from './sessionState';
import { createPaneLayout, splitPane } from '../split/paneLayout';

describe('sessionState', () => {
	it('未保存タブを除外し、空になったペインを畳む', () => {
		const layout   = splitPane(createPaneLayout('pane-1'), 'pane-1', 'pane-2', 'split-1', 'vertical');
		const snapshot = createSessionSnapshot({
			tabs: [
				{ tabId: 'saved', filePath: 'C:\\docs\\saved.md' },
				{ tabId: 'untitled', filePath: null },
			],
			panes: [
				{ paneId: 'pane-1', tabIds: ['saved'], activeTabId: 'saved', viewModes: { saved: 'source' } },
				{ paneId: 'pane-2', tabIds: ['untitled'], activeTabId: 'untitled', viewModes: { untitled: 'live-preview' } },
			],
			paneLayout: layout,
			activePaneId: 'pane-2',
		});

		expect(snapshot).toMatchObject({
			tabs: [{ tabId: 'saved', filePath: 'C:\\docs\\saved.md' }],
			panes: [{ paneId: 'pane-1', tabIds: ['saved'], activeTabId: 'saved' }],
			paneLayout: { kind: 'pane', paneId: 'pane-1' },
			activePaneId: 'pane-1',
		});
	});

	it('壊れた参照を除外し、アクティブ状態と表示モードを補正する', () => {
		const snapshot = normalizeSessionSnapshot({
			schemaVersion: 1,
			tabs: [{ tabId: 'tab-1', filePath: 'C:\\docs\\one.md' }],
			panes: [
				{ paneId: 'pane-1', tabIds: ['missing', 'tab-1'], activeTabId: 'missing', viewModes: { 'tab-1': 'invalid' } },
				{ paneId: 'pane-2', tabIds: ['missing'], activeTabId: 'missing', viewModes: {} },
			],
			paneLayout: {
				kind: 'split', splitId: 'split-1', direction: 'horizontal', ratio: 0.95,
				first: { kind: 'pane', paneId: 'pane-1' }, second: { kind: 'pane', paneId: 'pane-2' },
			},
			activePaneId: 'pane-2',
		});

		expect(snapshot).toMatchObject({
			panes: [{ paneId: 'pane-1', tabIds: ['tab-1'], activeTabId: 'tab-1', viewModes: { 'tab-1': 'live-preview' } }],
			paneLayout: { kind: 'pane', paneId: 'pane-1' },
			activePaneId: 'pane-1',
		});
	});

	it('復元可能なファイルタブがなければ null を返す', () => {
		const empty = { schemaVersion: 1, tabs: [], panes: [], paneLayout: { kind: 'pane', paneId: 'pane-1' } };
		expect(normalizeSessionSnapshot(empty)).toBeNull();
		expect(isEmptySessionSnapshot(empty)).toBe(true);
		expect(isEmptySessionSnapshot({ schemaVersion: 2, tabs: [] })).toBe(false);
	});
});
