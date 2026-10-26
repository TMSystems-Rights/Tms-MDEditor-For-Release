/**
 * 検索一致の件数、移動先、不正な正規表現の文言を確認する
 * @file
 */
import { history, undo } from '@codemirror/commands';
import { SearchQuery, replaceAll, search, setSearchQuery } from '@codemirror/search';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import { type EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { countSearchMatches, findSearchMatch, findSearchMatchFromPosition, findSearchMatchFromRange, getRegularExpressionError } from './searchLogic';

describe('searchLogic', () => {
	it('検索ヒット総数とカーソルから見た現在位置を数える', () => {
		// 大小が混ざる alpha。キャレットは 2 件目の先頭
		const state = EditorState.create({
			// 小文字 2 件と大文字 1 件
			doc: 'alpha beta alpha ALPHA',
			// 2 件目の先頭。空のキャレット
			selection: { anchor: 8 }
		});
		// 大文字小文字を区別しない alpha
		const query = new SearchQuery({ search: 'alpha' });

		// 現在位置と総数。大文字も 1 件に数える
		expect(countSearchMatches(state, query)).toEqual({
			// キャレットから見て 2 件目
			current: 2,
			// 大文字を含む 3 件
			total: 3
		});
	});

	it('選択中の一致を現在位置として数える', () => {
		// 2 件目の one を選択している文書
		const state = EditorState.create({
			// one が 2 回出る
			doc: 'one two one',
			// 2 件目の one 全体。空のキャレットではない
			selection: {
				// 選択の起点。2 件目の先頭
				anchor: 8,
				// 選択の終点。one の末尾
				head: 11
			}
		});
		// 大文字小文字を区別する one
		const query = new SearchQuery({
			// 探す文字列
			search: 'one',
			// 区別する。大文字はヒットにしない
			caseSensitive: true
		});

		// 選択中の一致を現在位置にする
		expect(countSearchMatches(state, query)).toEqual({
			// 選択中なので 2 件目
			current: 2,
			// 文書中の一致
			total: 2
		});
	});

	it('選択中の一致から次の一致へ移動する範囲を返す', () => {
		// 1 件目の one を選択している文書
		const state = EditorState.create({
			// one が 2 回出る
			doc: 'one two one',
			// 1 件目の one 全体
			selection: {
				// 選択の起点。文書先頭
				anchor: 0,
				// 選択の終点。1 件目の末尾
				head: 3
			}
		});
		// 大文字小文字を区別する one
		const query = new SearchQuery({
			// 探す文字列
			search: 'one',
			// 区別する
			caseSensitive: true
		});

		// 選択の次の一致。2 件目
		expect(findSearchMatch(state, query, 'next')).toEqual({
			// 2 件目の先頭
			from: 8,
			// 2 件目の末尾
			to: 11
		});
	});

	it('現在位置より前の一致へ移動する範囲を返す', () => {
		// 2 件目の直前にキャレットがある文書
		const state = EditorState.create({
			// one が 2 回出る
			doc: 'one two one',
			// 2 件目の直前。空のキャレット
			selection: { anchor: 7 }
		});
		// 大文字小文字を区別する one
		const query = new SearchQuery({
			// 探す文字列
			search: 'one',
			// 区別する
			caseSensitive: true
		});

		// キャレットより前の一致。1 件目
		expect(findSearchMatch(state, query, 'previous')).toEqual({
			// 1 件目の先頭
			from: 0,
			// 1 件目の末尾
			to: 3
		});
	});

	it('指定位置を基準に次の一致へ移動する範囲を返す', () => {
		// alpha が 2 回出る文書。選択は先頭
		const state = EditorState.create({
			// 先頭と末尾に alpha
			doc: 'alpha beta alpha'
		});
		// 大文字小文字を区別する alpha
		const query = new SearchQuery({
			// 探す文字列
			search: 'alpha',
			// 区別する
			caseSensitive: true
		});

		// 1 文字目の次は、いま居る先頭の一致
		expect(findSearchMatchFromPosition(state, query, 1, 'next')).toEqual({
			// 先頭の alpha
			from: 0,
			// alpha の末尾
			to: 5
		});
		// 1 件目の後ろからは、次の alpha
		expect(findSearchMatchFromPosition(state, query, 6, 'next')).toEqual({
			// 2 件目の先頭
			from: 11,
			// 2 件目の末尾。文書末尾
			to: 16
		});
	});

	it('現在一致範囲を基準に次の一致へ移動する範囲を返す', () => {
		// one が 3 回出る文書。選択は先頭
		const state = EditorState.create({
			// 1 件目、2 件目、3 件目
			doc: 'one two one three one'
		});
		// 大文字小文字を区別する one
		const query = new SearchQuery({
			// 探す文字列
			search: 'one',
			// 区別する
			caseSensitive: true
		});

		// 1 件目の範囲の次。2 件目
		expect(
			findSearchMatchFromRange(
				state,
				query,
				{
					// 1 件目の先頭
					from: 0,
					// 1 件目の末尾
					to: 3
				},
				'next'
			)
		).toEqual({
			// 2 件目の先頭
			from: 8,
			// 2 件目の末尾
			to: 11
		});
		// 2 件目の範囲の前。1 件目
		expect(
			findSearchMatchFromRange(
				state,
				query,
				{
					// 2 件目の先頭
					from: 8,
					// 2 件目の末尾
					to: 11
				},
				'previous'
			)
		).toEqual({
			// 1 件目の先頭
			from: 0,
			// 1 件目の末尾
			to: 3
		});
	});

	it('不正な正規表現へ日本語のインラインエラーを返す', () => {
		expect(getRegularExpressionError('[abc')).toContain('正規表現が正しくありません');
		expect(getRegularExpressionError('a+')).toBeNull();
	});

	it('すべて置換は1回の undo で元へ戻る', () => {
		// foo が 3 つ。履歴と検索を載せ、1 回の undo で戻す
		let state = EditorState.create({
			// 置換前の本文
			doc: 'foo foo foo',
			// undo と検索コマンドに必要な拡張
			extensions: [history(), search()]
		});
		// 検索語 foo を bar へ置換するクエリを載せた状態
		state     = state.update({
			// 置換クエリ。検索と置換先が両方必要
			effects: setSearchQuery.of(
				new SearchQuery({
					// 置換する文字列
					search: 'foo',
					// 置き換える文字列
					replace: 'bar'
				})
			)
		}).state;

		// dispatch を呼んだ回数。1 なら 1 回の undo で戻る
		let transactionCount = 0;
		// replaceAll と undo が使うビュー。状態は外の state を見る
		const commandTarget  = {
			/**
			 * 現在のエディタ状態を返す
			 * @returns エディタ状態
			 */
			get state() {
				return state;
			},
			/**
			 * テスト用トランザクションを適用する
			 * @param specs - トランザクション仕様
			 */
			dispatch(...specs: TransactionSpec[]) {
				// 渡された仕様を適用したトランザクション
				const transaction = state.update(...specs);
				// 次の dispatch と undo が見る状態
				state             = transaction.state;
				// 更新回数。1 を超えると 1 回の undo では戻らない
				transactionCount += 1;
			}
		} as unknown as EditorView;

		expect(replaceAll(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe('bar bar bar');
		expect(transactionCount).toBe(1);
		expect(undo(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe('foo foo foo');
	});
});
