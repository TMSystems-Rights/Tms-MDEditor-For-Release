/**
 * 分割木の追加、削除、比率の上限を確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { createPaneLayout, findAdjacentPaneId, listPaneIds, removePane, splitPane, updateSplitRatio, type PaneLayoutNode } from './paneLayout';

describe('paneLayout', () => {
	it('分割済みペインを再分割して3ペイン以上のツリーを作る', () => {
		// 分割前の 1 ペイン。ここから 2 回分割する
		let layout: PaneLayoutNode = createPaneLayout('pane-1');
		// pane-1 を左右に分け、右へ pane-2 を足す
		layout                     = splitPane(layout, 'pane-1', 'pane-2', 'split-1', 'vertical');
		// pane-2 を上下に分け、下へ pane-3 を足す
		layout                     = splitPane(layout, 'pane-2', 'pane-3', 'split-2', 'horizontal');

		expect(listPaneIds(layout)).toEqual(['pane-1', 'pane-2', 'pane-3']);
		expect(layout).toMatchObject({
			// 外側は分割ノード
			kind: 'split',
			// 最初の分割は左右
			direction: 'vertical',
			// 右側がさらに分割されている
			second: {
				// 内側も分割ノード
				kind: 'split',
				// 内側の分割は上下
				direction: 'horizontal'
			}
		});
	});

	it('ペイン削除時に兄弟を昇格して分割ツリーを畳む', () => {
		// 3 ペインの木。pane-2 を消す前の状態
		let layout: PaneLayoutNode = createPaneLayout('pane-1');
		// pane-1 の右へ pane-2
		layout                     = splitPane(layout, 'pane-1', 'pane-2', 'split-1', 'vertical');
		// pane-2 の下へ pane-3
		layout                     = splitPane(layout, 'pane-2', 'pane-3', 'split-2', 'horizontal');

		// pane-2 を除いた木。分割が畳めていなければ null
		const next = removePane(layout, 'pane-2');
		expect(next && listPaneIds(next)).toEqual(['pane-1', 'pane-3']);
		expect(findAdjacentPaneId(layout, 'pane-2')).toBe('pane-1');
	});

	it('各分割の比率を独立して20%〜80%へ制限する', () => {
		// 外側と内側で比率を別に持つ 3 ペイン
		let layout: PaneLayoutNode = createPaneLayout('pane-1');
		// 外側の左右分割。比率は既定の 0.5
		layout                     = splitPane(layout, 'pane-1', 'pane-2', 'split-1', 'vertical');
		// 内側の上下分割。こちらだけ上限を超えて更新する
		layout                     = splitPane(layout, 'pane-2', 'pane-3', 'split-2', 'horizontal');
		// 内側だけ 0.95。上限 0.8 へ丸まる
		layout                     = updateSplitRatio(layout, 'split-2', 0.95);

		expect(layout).toMatchObject({
			// 外側は分割のまま
			kind: 'split',
			// 外側の比率。内側の更新では変わらない
			ratio: 0.5,
			// 内側の分割。比率だけが上限に張り付く
			second: {
				// 内側も分割ノード
				kind: 'split',
				// 上限へ丸めた比率
				ratio: 0.8
			}
		});
	});

	it('新しいペインを分割対象の手前へ配置できる', () => {
		// 新しい pane-2 を pane-1 の手前へ置いた分割
		const layout = splitPane(createPaneLayout('pane-1'), 'pane-1', 'pane-2', 'split-1', 'vertical', 'first');

		expect(listPaneIds(layout)).toEqual(['pane-2', 'pane-1']);
	});
});
