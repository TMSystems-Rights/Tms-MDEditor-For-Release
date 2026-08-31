import { describe, expect, it } from 'vitest';
import { createPaneLayout, findAdjacentPaneId, listPaneIds, removePane, splitPane, updateSplitRatio, type PaneLayoutNode } from './paneLayout';

describe('paneLayout', () => {
	it('分割済みペインを再分割して3ペイン以上のツリーを作る', () => {
		let layout: PaneLayoutNode = createPaneLayout('pane-1');
		layout                     = splitPane(layout, 'pane-1', 'pane-2', 'split-1', 'vertical');
		layout                     = splitPane(layout, 'pane-2', 'pane-3', 'split-2', 'horizontal');

		expect(listPaneIds(layout)).toEqual(['pane-1', 'pane-2', 'pane-3']);
		expect(layout).toMatchObject({
			kind: 'split',
			direction: 'vertical',
			second: { kind: 'split', direction: 'horizontal' },
		});
	});

	it('ペイン削除時に兄弟を昇格して分割ツリーを畳む', () => {
		let layout: PaneLayoutNode = createPaneLayout('pane-1');
		layout                     = splitPane(layout, 'pane-1', 'pane-2', 'split-1', 'vertical');
		layout                     = splitPane(layout, 'pane-2', 'pane-3', 'split-2', 'horizontal');

		const next = removePane(layout, 'pane-2');
		expect(next && listPaneIds(next)).toEqual(['pane-1', 'pane-3']);
		expect(findAdjacentPaneId(layout, 'pane-2')).toBe('pane-1');
	});

	it('各分割の比率を独立して20%〜80%へ制限する', () => {
		let layout: PaneLayoutNode = createPaneLayout('pane-1');
		layout                     = splitPane(layout, 'pane-1', 'pane-2', 'split-1', 'vertical');
		layout                     = splitPane(layout, 'pane-2', 'pane-3', 'split-2', 'horizontal');
		layout                     = updateSplitRatio(layout, 'split-2', 0.95);

		expect(layout).toMatchObject({
			kind: 'split',
			ratio: 0.5,
			second: { kind: 'split', ratio: 0.8 },
		});
	});

	it('新しいペインを分割対象の手前へ配置できる', () => {
		const layout = splitPane(createPaneLayout('pane-1'), 'pane-1', 'pane-2', 'split-1', 'vertical', 'first');

		expect(listPaneIds(layout)).toEqual(['pane-2', 'pane-1']);
	});
});
