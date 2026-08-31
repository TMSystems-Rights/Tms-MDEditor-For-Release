import { history, undo } from '@codemirror/commands';
import { SearchQuery, replaceAll, search, setSearchQuery } from '@codemirror/search';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { type EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import {
	countSearchMatches,
	findSearchMatch,
	findSearchMatchFromPosition,
	findSearchMatchFromRange,
	getRegularExpressionError,
} from './searchLogic';

describe('searchLogic', () => {
	it('検索ヒット総数とカーソルから見た現在位置を数える', () => {
		const state = EditorState.create({
			doc      : 'alpha beta alpha ALPHA',
			selection: { anchor: 8 },
		});
		const query = new SearchQuery({ search: 'alpha' });

		expect(countSearchMatches(state, query)).toEqual({
			current: 2,
			total  : 3,
		});
	});

	it('選択中の一致を現在位置として数える', () => {
		const state = EditorState.create({
			doc      : 'one two one',
			selection: { anchor: 8, head: 11 },
		});
		const query = new SearchQuery({ search: 'one', caseSensitive: true });

		expect(countSearchMatches(state, query)).toEqual({
			current: 2,
			total  : 2,
		});
	});

	it('選択中の一致から次の一致へ移動する範囲を返す', () => {
		const state = EditorState.create({
			doc      : 'one two one',
			selection: { anchor: 0, head: 3 },
		});
		const query = new SearchQuery({ search: 'one', caseSensitive: true });

		expect(findSearchMatch(state, query, 'next')).toEqual({
			from: 8,
			to  : 11,
		});
	});

	it('現在位置より前の一致へ移動する範囲を返す', () => {
		const state = EditorState.create({
			doc      : 'one two one',
			selection: { anchor: 7 },
		});
		const query = new SearchQuery({ search: 'one', caseSensitive: true });

		expect(findSearchMatch(state, query, 'previous')).toEqual({
			from: 0,
			to  : 3,
		});
	});

	it('指定位置を基準に次の一致へ移動する範囲を返す', () => {
		const state = EditorState.create({
			doc: 'alpha beta alpha',
		});
		const query = new SearchQuery({ search: 'alpha', caseSensitive: true });

		expect(findSearchMatchFromPosition(state, query, 1, 'next')).toEqual({
			from: 0,
			to  : 5,
		});
		expect(findSearchMatchFromPosition(state, query, 6, 'next')).toEqual({
			from: 11,
			to  : 16,
		});
	});

	it('現在一致範囲を基準に次の一致へ移動する範囲を返す', () => {
		const state = EditorState.create({
			doc: 'one two one three one',
		});
		const query = new SearchQuery({ search: 'one', caseSensitive: true });

		expect(findSearchMatchFromRange(state, query, { from: 0, to: 3 }, 'next')).toEqual({
			from: 8,
			to  : 11,
		});
		expect(findSearchMatchFromRange(state, query, { from: 8, to: 11 }, 'previous')).toEqual({
			from: 0,
			to  : 3,
		});
	});

	it('不正な正規表現へ日本語のインラインエラーを返す', () => {
		expect(getRegularExpressionError('[abc')).toContain('正規表現が正しくありません');
		expect(getRegularExpressionError('a+')).toBeNull();
	});

	it('すべて置換は1回の undo で元へ戻る', () => {
		let state = EditorState.create({
			doc       : 'foo foo foo',
			extensions: [history(), search()],
		});
		state     = state.update({
			effects: setSearchQuery.of(new SearchQuery({
				search : 'foo',
				replace: 'bar',
			})),
		}).state;

		let transactionCount = 0;
		const commandTarget  = {
			/**
			 * 現在のエディタ状態を返す
			 * @returns {EditorState} エディタ状態
			 */
			get state() {
				return state;
			},
			/**
			 * テスト用トランザクションを適用する
			 * @param {TransactionSpec[]} specs トランザクション仕様
			 * @returns {void}
			 */
			dispatch(...specs: TransactionSpec[]) {
				const transaction = state.update(...specs);
				state             = transaction.state;
				transactionCount += 1;
			},
		} as unknown as EditorView;

		expect(replaceAll(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe('bar bar bar');
		expect(transactionCount).toBe(1);
		expect(undo(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe('foo foo foo');
	});
});
