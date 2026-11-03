/**
 * 折り返したリスト項目を揃えるための、対象行の収集と計測結果の扱いを検証する
 * 描画後の座標計測は DOM が要るため対象にせず、純粋な関数だけを確かめる
 * @file
 */
import { ChangeSet, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectListHangingTargets, formatListHangingStyle, mapListHangingMeasures, mergeListHangingMeasures, sameListHangingMeasures, type ListHangingMeasure } from './listHangingIndent';

/**
 * TMS Markdown 付き EditorState を生成する
 * @param doc - 対象行を集める本文
 * @returns リストの構文木を持つ EditorState
 */
function createMarkdownState(doc: string): EditorState {
	return EditorState.create({
		// 対象行を集める本文
		doc,
		// リスト項目とタスク記法のノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

/**
 * 対象を、行の本文と本文開始より前の文字列の組にする
 * @param state - 対象を集めた文書
 * @returns 各対象の、本文開始より前の文字列と本文開始以降の文字列
 */
function describeTargets(state: EditorState): Array<[string, string]> {
	return collectListHangingTargets(state).map((target) => {
		// 対象の行。本文開始を行内の文字列で確かめる
		const line = state.doc.lineAt(target.lineFrom);
		return [state.doc.sliceString(line.from, target.textFrom), state.doc.sliceString(target.textFrom, line.to)];
	});
}

describe('collectListHangingTargets', () => {
	it('箇条書きと番号付きリストの本文開始を、記号と直後の空白の後ろにする', () => {
		// 入れ子の箇条書きと、記号の後ろに空白が 2 つある番号付きリスト
		const state = createMarkdownState(['- 箇条書き１', '    - 箇条書き１－１＿ああ', '', '1.  番号つきリスト１', '    1. 番号つきリスト１－１'].join('\n'));

		expect(describeTargets(state)).toEqual([
			['- ', '箇条書き１'], // 最上位の箇条書き
			['    - ', '箇条書き１－１＿ああ'], // 入れ子の箇条書き。行頭の空白も幅に含める
			['1.  ', '番号つきリスト１'], // 記号の後ろの空白 2 つを飛ばす
			['    1. ', '番号つきリスト１－１'] // 入れ子の番号付きリスト
		]);
	});

	it('タブでインデントした入れ子の項目も、タブと記号の後ろを本文開始にする', () => {
		// 2 行目だけタブで入れ子にした箇条書きと、タブで入れ子にした番号付きリスト
		const state = createMarkdownState(['- 親', '\t- 子＿ああ', '', '1.  親', '\t1.  子'].join('\n'));

		expect(describeTargets(state)).toEqual([
			['- ', '親'], // 最上位の箇条書き
			['\t- ', '子＿ああ'], // タブで入れ子にした箇条書き
			['1.  ', '親'], // 最上位の番号付きリスト
			['\t1.  ', '子'] // タブで入れ子にした番号付きリスト
		]);
	});

	it('タスク項目はチェックボックスの後ろを本文開始にする', () => {
		// 未完了と完了のタスク
		const state = createMarkdownState(['- [ ] 未完了', '- [x] 完了'].join('\n'));

		expect(describeTargets(state)).toEqual([
			['- [ ] ', '未完了'], // 未完了のタスク
			['- [x] ', '完了'] // 完了のタスク
		]);
	});

	it('本文が無い項目は行末を本文開始にし、リストでない行は集めない', () => {
		// 記号だけの項目と、通常の段落
		const state = createMarkdownState(['段落', '', '- '].join('\n'));

		expect(describeTargets(state)).toEqual([['- ', '']]);
	});
});

describe('計測結果の扱い', () => {
	/** 比較に使う 2 行分の計測結果。位置は 0 と 10、幅は固定値 */
	const measures: ListHangingMeasure[] = [
		{ lineFrom: 0, hang: 20 }, // 先頭行の結果
		{ lineFrom: 10, hang: 40 } // 2 件目の結果
	];

	it('同じ並びなら一致とし、幅が違えば不一致とする', () => {
		// 幅だけを変えた結果
		const changed = [measures[0], { lineFrom: 10, hang: 41 }];

		expect(sameListHangingMeasures(measures, [...measures])).toBe(true);
		expect(sameListHangingMeasures(measures, changed)).toBe(false);
		expect(sameListHangingMeasures(measures, measures.slice(0, 1))).toBe(false);
	});

	it('測った範囲の中だけを今回の結果で置き換え、範囲外は残す', () => {
		// 範囲 5〜20 で測った結果。位置 10 の幅だけ変わった
		const measured = [{ lineFrom: 10, hang: 42 }];

		expect(mergeListHangingMeasures(measures, measured, 5, 20)).toEqual([measures[0], measured[0]]);
	});

	it('文書変更で行頭位置をずらし、行頭でなくなった結果は捨てる', () => {
		// 2 行の文書。各行の先頭は 0 と 10
		const doc     = EditorState.create({ doc: '- 1234567\n- abc' }).doc;
		// 先頭へ 2 文字挿入し、2 行目の前の改行を消す変更
		const changes = ChangeSet.of(
			[
				{ from: 0, insert: 'xx' }, // 先頭行の前へ挿入する
				{ from: 9, to: 10 } // 1 行目末尾の改行を消し、2 行目を 1 行目へつなげる
			],
			doc.length
		);
		// 変更後の文書
		const nextDoc = changes.apply(doc);

		expect(mapListHangingMeasures(measures, changes, nextDoc)).toEqual([{ lineFrom: 0, hang: 20 }]);
	});

	it('style は padding を変えず、hanging 付きの text-indent で 2 行目以降だけを寄せる', () => {
		expect(formatListHangingStyle({ lineFrom: 0, hang: 24.5 })).toBe('text-indent: 24.5px hanging');
	});
});
