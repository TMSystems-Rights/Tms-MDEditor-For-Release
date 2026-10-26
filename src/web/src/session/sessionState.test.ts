/**
 * 未保存タブの除外と、壊れたセッション JSON の正規化を確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { createSessionSnapshot, isEmptySessionSnapshot, normalizeSessionSnapshot } from './sessionState';
import { createPaneLayout, splitPane } from '../split/paneLayout';

describe('sessionState', () => {
	it('未保存タブを除外し、空になったペインを畳む', () => {
		// 左右 2 ペイン。右は未保存タブだけで、畳む対象
		const layout   = splitPane(createPaneLayout('pane-1'), 'pane-1', 'pane-2', 'split-1', 'vertical');
		// 保存済みと未保存が混ざるセッション。未保存は復元できない
		const snapshot = createSessionSnapshot({
			// 保存済みと、パスの無い未保存
			tabs: [
				// ファイルパスがある。残す
				{
					// タブ ID
					tabId: 'saved',
					// 復元できる絶対パス
					filePath: 'C:\\docs\\saved.md'
				},
				// パスが無い。除外する
				{
					// タブ ID
					tabId: 'untitled',
					// 未保存。null は復元しない
					filePath: null
				}
			],
			// 左は保存済み、右は未保存だけ
			panes: [
				// 残るペイン
				{
					// ペイン ID
					paneId: 'pane-1',
					// このペインのタブ。保存済みだけ
					tabIds: ['saved'],
					// アクティブタブ。保存済み
					activeTabId: 'saved',
					// 表示モード。ソース
					viewModes: { saved: 'source' }
				},
				// 未保存だけなので畳むペイン
				{
					// ペイン ID
					paneId: 'pane-2',
					// 未保存タブだけ
					tabIds: ['untitled'],
					// アクティブも未保存
					activeTabId: 'untitled',
					// 表示モード。ライブプレビュー
					viewModes: { untitled: 'live-preview' }
				}
			],
			// 上で作った 2 ペインの木
			paneLayout: layout,
			// アクティブは消える右ペイン。残った左へ寄る
			activePaneId: 'pane-2'
		});

		expect(snapshot).toMatchObject({
			// 未保存を除いたタブ
			tabs: [
				{
					// 残ったタブ ID
					tabId: 'saved',
					// 残った絶対パス
					filePath: 'C:\\docs\\saved.md'
				}
			],
			// 空になった右ペインは無い
			panes: [
				{
					// 残ったペイン ID
					paneId: 'pane-1',
					// 保存済みタブだけ
					tabIds: ['saved'],
					// アクティブも保存済み
					activeTabId: 'saved'
				}
			],
			// 分割は畳み、単一ペインになる
			paneLayout: {
				// 分割ではない
				kind: 'pane',
				// 残ったペイン
				paneId: 'pane-1'
			},
			// 消えた右ではなく、残った左
			activePaneId: 'pane-1'
		});
	});

	it('壊れた参照を除外し、アクティブ状態と表示モードを補正する', () => {
		// 欠落タブと不正な表示モード、上限を超えた比率を含む壊れたセッション
		const snapshot = normalizeSessionSnapshot({
			// セッションの版。1 は現行
			schemaVersion: 1,
			// 実在するのは tab-1 だけ
			tabs: [
				{
					// 残るタブ ID
					tabId: 'tab-1',
					// 復元できる絶対パス
					filePath: 'C:\\docs\\one.md'
				}
			],
			// 欠落タブを参照する 2 ペイン。右は有効タブが無い
			panes: [
				// 欠落タブと有効タブが混ざる
				{
					// ペイン ID
					paneId: 'pane-1',
					// missing は捨て、tab-1 だけ残す
					tabIds: ['missing', 'tab-1'],
					// アクティブが欠落。残った tab-1 へ補正する
					activeTabId: 'missing',
					// 未知の表示モード。ライブプレビューへ戻す
					viewModes: { 'tab-1': 'invalid' }
				},
				// 有効タブが無く、畳む
				{
					// ペイン ID
					paneId: 'pane-2',
					// 欠落タブだけ
					tabIds: ['missing'],
					// アクティブも欠落
					activeTabId: 'missing',
					// 表示モードは空
					viewModes: {}
				}
			],
			// 比率が上限を超えた左右分割。右ペインが消えると畳む
			paneLayout: {
				// 分割ノード
				kind: 'split',
				// 分割 ID
				splitId: 'split-1',
				// 上下分割
				direction: 'horizontal',
				// 上限 0.8 を超えた比率。畳むので結果には残らない
				ratio: 0.95,
				// 左。残るペイン
				first: {
					// 単一ペイン
					kind: 'pane',
					// 有効タブがあるペイン
					paneId: 'pane-1'
				},
				// 右。有効タブが無い
				second: {
					// 単一ペイン
					kind: 'pane',
					// 畳むペイン
					paneId: 'pane-2'
				}
			},
			// アクティブは消える右。残った左へ寄る
			activePaneId: 'pane-2'
		});

		expect(snapshot).toMatchObject({
			// 有効タブのあるペインだけ
			panes: [
				{
					// 残ったペイン ID
					paneId: 'pane-1',
					// 欠落を除いたタブ
					tabIds: ['tab-1'],
					// 欠落していたアクティブを tab-1 へ補正
					activeTabId: 'tab-1',
					// 未知の表示モードはライブプレビュー
					viewModes: { 'tab-1': 'live-preview' }
				}
			],
			// 右が消えたので単一ペイン
			paneLayout: {
				// 分割ではない
				kind: 'pane',
				// 残ったペイン
				paneId: 'pane-1'
			},
			// 消えた右ではなく左
			activePaneId: 'pane-1'
		});
	});

	it('復元可能なファイルタブがなければ null を返す', () => {
		// ファイルタブが 1 つも無いスナップショット。復元しない
		const empty = {
			// セッションの版。1 は現行
			schemaVersion: 1,
			// タブは空
			tabs: [],
			// ペインは空
			panes: [],
			// 中身の無い単一ペイン
			paneLayout: {
				// 分割ではない
				kind: 'pane',
				// プレースホルダのペイン ID。タブが無いので残さない
				paneId: 'pane-1'
			}
		};
		expect(normalizeSessionSnapshot(empty)).toBeNull();
		expect(isEmptySessionSnapshot(empty)).toBe(true);
		// 版が 2 でタブが空。空判定の対象外なので false
		expect(
			isEmptySessionSnapshot({
				// 未知の版。1 ではない
				schemaVersion: 2,
				// タブは空でも、版が違うので空セッションにしない
				tabs: []
			})
		).toBe(false);
	});
});
