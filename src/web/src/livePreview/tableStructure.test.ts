/**
 * 行と列の挿入、削除、移動が Markdown の表をどう変えるかを検証する
 * 結合の占有は本番の tableMerge を使い、エディタ画面は開かない
 * @file
 */
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { extractTableData, type TableData } from './tableWidget';
import { buildTableStructureChange, buildTableStructureGroups, buildTableInsertionChange, createMarkdownTable, resolveTableStructureContextSelection, shouldHideTableStructureControls } from './tableStructure';

/**
 * Markdown 対応済みのテスト用状態を作る。選択は付けない
 * @param doc - ドキュメント全文
 * @returns 指定の文書と TMS Markdown 拡張だけを持つ状態
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		// 表を含む本文。選択は付けない
		doc,
		// 表ノードを得る Markdown サポート
		extensions: [createTmsMarkdownSupport()]
	});
}

/**
 * 文書中の最初の Table から、表示用の表データを取り出す
 * @param state - 構文木を読むテスト用状態
 * @returns 最初の表。表が無ければ呼び出し側の非 null 前提で失敗する
 */
function tableData(state: EditorState): TableData {
	// 最初の表。無ければ null のまま
	let result: TableData | null = null;
	syntaxTree(state).iterate({
		/**
		 * 最初の Table ノードのデータを result へ入れる
		 * @param node - 走査中の構文ノード
		 */
		enter(node) {
			// 最初の Table だけを採用する。2 件目は上書きする
			if (node.name === 'Table') result = extractTableData(state, node.node);
		}
	});
	return result!;
}

/**
 * 文書変更を適用したあとの全文を返す。画面は更新しない
 * @param state - 変更前の状態
 * @param change - 置換する範囲と挿入文字列。from と to は文字位置
 * @returns 適用後のドキュメント全文
 */
function applyChange(state: EditorState, change: { from: number; to: number; insert: string }): string {
	return state.update({ changes: change }).state.doc.toString();
}

describe('tableStructure', () => {
	it('右クリック対象を含む複数選択を維持し、範囲外なら対象へ切り替える', () => {
		// 右クリックが列選択の中。選択は維持する
		expect(
			resolveTableStructureContextSelection(
				{
					// 今の選択軸。列
					axis: 'column',
					// 選択の開始列。先頭ではない
					start: 1,
					// 選択の終了列。右クリックより後ろ
					end: 3
				},
				{
					// 右クリックした軸。選択と同じ列
					axis: 'column',
					// 右クリックした列。選択の中
					start: 2,
					// 右クリックは 1 列
					end: 2
				}
			)
		).toEqual({
			// 維持する軸。列
			axis: 'column',
			// 維持する開始
			start: 1,
			// 維持する終了
			end: 3
		});
		// 右クリックが別軸。選択をその対象へ切り替える
		expect(
			resolveTableStructureContextSelection(
				{
					// 今の選択軸。列
					axis: 'column',
					// 選択の開始列
					start: 1,
					// 選択の終了列
					end: 3
				},
				{
					// 右クリックした軸。行。列選択の外
					axis: 'row',
					// 右クリックした行
					start: 2,
					// 右クリックは 1 行
					end: 2
				}
			)
		).toEqual({
			// 切り替えた軸。行
			axis: 'row',
			// 右クリックした行
			start: 2,
			// 1 行のまま
			end: 2
		});
	});

	it('フォーカスが外れても行・列選択中は選択ヘッダーを維持する', () => {
		expect(shouldHideTableStructureControls(false, true)).toBe(false);
		expect(shouldHideTableStructureControls(true, false)).toBe(false);
		expect(shouldHideTableStructureControls(false, false)).toBe(true);
	});

	it('重なる colspan を推移的に1つの列選択単位へまとめる', () => {
		// 列をまたぐセルが隣の列と重なる表。0〜2 列が 1 単位
		const state = createState('| H1 | H2 | H3 | H4 |\n| --- | --- | --- | --- |\n| A{colspan=2} | | C | D |\n| A | B{colspan=2} | | D |');
		// 重なりでまとめた列の範囲
		expect(buildTableStructureGroups(tableData(state), 'column')).toEqual([
			{
				// まとめた単位の開始列
				start: 0,
				// まとめた単位の終了列。2 列目まで
				end: 2
			},
			{
				// 重ならない最後の列
				start: 3,
				// 1 列だけの単位
				end: 3
			}
		]);
	});

	it('データ行の重なる rowspan を推移的に1つの行選択単位へまとめる', () => {
		// データ行の rowspan が隣の行と重なる表。見出し行は単位に入れない
		const state = createState('| H1 | H2 |\n| --- | --- |\n| A{rowspan=2} | 1 |\n| | B{rowspan=2} |\n| 3 | |\n| 4 | 4 |');
		// 重なりでまとめた行の範囲
		expect(buildTableStructureGroups(tableData(state), 'row')).toEqual([
			{
				// まとめた単位の開始行。最初のデータ行
				start: 1,
				// まとめた単位の終了行
				end: 3
			},
			{
				// 重ならない最後のデータ行
				start: 4,
				// 1 行だけの単位
				end: 4
			}
		]);
	});

	it('複数行を同数追加、削除、隣接グループ単位で移動する', () => {
		// 2 行が 1 単位の表。追加、移動、削除で同じ元に戻す
		const source = '| H1 | H2 |\n| --- | --- |\n| A{rowspan=2} | 1 |\n| | 2 |\n| C | 3 |';
		// 追加前の状態
		let state    = createState(source);
		// その表データ。操作のたびに取り直す
		let data     = tableData(state);
		// 1〜2 行目の後ろへ同数の空行を入れる変更
		const added  = buildTableStructureChange(
			state,
			data,
			{
				// 操作する軸。行
				axis: 'row',
				// 単位の開始行
				start: 1,
				// 単位の終了行
				end: 2
			},
			'insert-after'
		)!;
		expect(applyChange(state, added)).toContain('|  |  |\n|  |  |\n| C | 3 |');

		// 移動の前に、追加前の文書へ戻す
		state          = createState(source);
		// 戻した文書の表データ
		data           = tableData(state);
		// 3 行目を 1 つ前の単位と入れ替える変更
		const moved    = buildTableStructureChange(
			state,
			data,
			{
				// 操作する軸。行
				axis: 'row',
				// 移動する行。1 行
				start: 3,
				// 1 行だけの単位
				end: 3
			},
			'move-previous'
		)!;
		// 移動後の全文。C の行が A より前に来る
		const movedDoc = applyChange(state, moved);
		expect(movedDoc.indexOf('| C | 3 |')).toBeLessThan(movedDoc.indexOf('| A{rowspan=2} | 1 |'));

		// 削除の前に、元の文書へ戻す
		state         = createState(source);
		// 戻した文書の表データ
		data          = tableData(state);
		// 1〜2 行目を消す変更
		const removed = buildTableStructureChange(
			state,
			data,
			{
				// 操作する軸。行
				axis: 'row',
				// 消す単位の開始行
				start: 1,
				// 消す単位の終了行
				end: 2
			},
			'delete'
		)!;
		expect(applyChange(state, removed)).toBe('| H1 | H2 |\n| --- | --- |\n| C | 3 |');
	});

	it('列操作で配置と表レイアウトを対象列と一緒に移動する', () => {
		// 列幅、行高、配置が付いた 3 列。3 列目を左へ動かす
		const state = createState('| H1{colwidths=100,200,300 rowheights=30,40} | H2 | H3 |\n| :--- | ---: | --- |\n| A | B | C |');
		// その表データ。列幅と配置の移動に使う
		const data  = tableData(state);
		// 3 列目を 1 つ前へ動かす変更。幅と配置も付いていく
		const moved = buildTableStructureChange(
			state,
			data,
			{
				// 操作する軸。列
				axis: 'column',
				// 移動する列。3 列目
				start: 2,
				// 1 列だけの単位
				end: 2
			},
			'move-previous'
		)!;
		expect(applyChange(state, moved)).toBe('| H1{colwidths=100,300,200 rowheights=30,40} | H3 | H2 |\n| :--- | --- | ---: |\n| A | C | B |');
	});

	it('全列削除は拒否し、先頭列削除でもレイアウトを新しい左上へ移す', () => {
		// 列幅が左上セルにある 2 列。全列削除は拒否する
		const state = createState('| H1{colwidths=100,200} | H2 |\n| --- | --- |\n| A | B |');
		// その表データ
		const data  = tableData(state);
		// 0〜1 列、つまり全列の削除。変更は作らない
		expect(
			buildTableStructureChange(
				state,
				data,
				{
					// 操作する軸。列
					axis: 'column',
					// 先頭列
					start: 0,
					// 最後の列。全列になる
					end: 1
				},
				'delete'
			)
		).toBeNull();
		// 先頭列だけを消す変更。残る列へ幅を移す
		const removed = buildTableStructureChange(
			state,
			data,
			{
				// 操作する軸。列
				axis: 'column',
				// 消す先頭列
				start: 0,
				// 1 列だけ
				end: 0
			},
			'delete'
		)!;
		expect(applyChange(state, removed)).toBe('| H2{colwidths=200} |\n| --- |\n| B |');
	});

	it('指定した列数とデータ行数で新規表を作る', () => {
		expect(createMarkdownTable(2, 2)).toBe('| 見出し 1 | 見出し 2 |\n| --- | --- |\n|  |  |\n|  |  |');
	});

	it('本文途中へ挿入すると表の前後を改行する', () => {
		// 表を挟む前後の文字。1 文字目の後ろへ入れる
		const state  = createState('前後');
		// 見出し 1 列、データ行なしの表を、前後が改行で分かれるように入れる変更
		const change = buildTableInsertionChange(state, 1, createMarkdownTable(1, 0));
		expect(applyChange(state, change)).toBe('前\n| 見出し 1 |\n| --- |\n後');
	});
});
