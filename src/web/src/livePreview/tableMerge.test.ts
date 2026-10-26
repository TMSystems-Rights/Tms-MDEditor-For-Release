/**
 * セル結合、配置、占有グリッドが文書変更へどう出るかを検証する
 * EditorState はヘルパーが都度作り、画面への dispatch はモックで受ける
 * @file
 */
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { createDocumentContextExtensions } from './documentContext';
import { buildAlignTableCellsChanges, buildMergeTableCellsChanges, buildTableLayoutChange, buildTableOccupancy, buildUnmergeTableCellsChanges, cellAlignmentClassNames, describeTableCellSelection, formatCellSpan, isMultiCellTableSelectionRect, getTableMergeActionState, getVisibleAdjacentTableCellPosition, isCoveredTableCell, parseCellSpan, readTableLayout, resolveTableMergeRect } from './tableMerge';
import { applyTableAlignSnapshot, applyTableMergeSnapshot, buildTableCellChange, collapseTableDocumentChanges, extractTableData, getTableDataIdentity, resolveTableMergeTargetFromParts, syncRenderedTableAlignment } from './tableWidget';
import { syntaxTree } from '@codemirror/language';

/**
 * ノートパス付きの Markdown 状態を、文書先頭のカーソルで作る
 * @param doc - ドキュメント全文
 * @returns 文書文脈と TMS Markdown を載せた状態
 */
function createState(doc: string): EditorState {
	return EditorState.create({
		// 結合を読む表を含む本文
		doc,
		// 文書先頭の空キャレット。先頭行はソース表示になる
		selection: EditorSelection.cursor(0),
		// 表の構文木と、画像解決用のノートパス
		extensions: [
			createTmsMarkdownSupport(),
			...createDocumentContextExtensions({
				// 画像解決の基準にするノート。固定パス
				filePath: 'E:\\vault\\note.md',
				// リモート画像も読み込む
				loadRemoteImages: true
			})
		]
	});
}

/**
 * 文書中の最初の表から、表示用データを取り出す
 * @param state - 構文木を読む状態
 * @returns 最初の表。無ければ null
 */
function tableData(state: EditorState) {
	// 最初の Table。無ければ null のまま
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param ref - ノード
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			// 最初の Table だけを採用し、探索を止める
			if (ref.name === 'Table') {
				// 採用する表ノード。2 件目は見ない
				found = ref.node;
				return false;
			}
		}
	});
	// 表が無い文書はテストの前提違反。空の表データにはしない
	if (!found) {
		throw new Error('Table が無い');
	}

	return extractTableData(state, found);
}

describe('tableMerge', () => {
	it('末尾の colspan / rowspan を読む', () => {
		expect(parseCellSpan('新キャラ{colspan=3}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: '新キャラ',
			// 横にまたぐ列数
			colspan: 3,
			// 縦はまたがない。1 は結合なし
			rowspan: 1
		});
		expect(parseCellSpan('A{rowspan=2}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: 'A',
			// 横はまたがない。1 は結合なし
			colspan: 1,
			// 縦にまたぐ行数
			rowspan: 2
		});
		expect(parseCellSpan('X{colspan=2 rowspan=2}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: 'X',
			// 横にまたぐ列数
			colspan: 2,
			// 縦にまたぐ行数
			rowspan: 2
		});
		expect(parseCellSpan('Y{colspan=2}{rowspan=3}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: 'Y',
			// 横にまたぐ列数
			colspan: 2,
			// 別グループの縦結合
			rowspan: 3
		});
		expect(formatCellSpan('新キャラ', 3, 1)).toBe('新キャラ{colspan=3}');
		expect(formatCellSpan('A', 1, 1)).toBe('A');
	});

	it('末尾の align / valign を読む', () => {
		expect(parseCellSpan('100{align=right}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: '100',
			// 右寄せ
			align: 'right',
			// 縦の既定。top
			valign: 'top'
		});
		expect(parseCellSpan('見出し{valign=middle}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: '見出し',
			// 横の既定。left
			align: 'left',
			// 上下中央
			valign: 'middle'
		});
		expect(parseCellSpan('新キャラ{colspan=3 align=center valign=middle}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: '新キャラ',
			// 横にまたぐ列数
			colspan: 3,
			// 左右中央
			align: 'center',
			// 上下中央
			valign: 'middle'
		});
		expect(parseCellSpan('A{align=center}{valign=bottom}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: 'A',
			// 左右中央
			align: 'center',
			// 下寄せ
			valign: 'bottom'
		});
		expect(parseCellSpan('B{valign=center}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: 'B',
			// center は middle に正規化する
			valign: 'middle'
		});
		expect(formatCellSpan('100', 1, 1, 'right')).toBe('100{align=right}');
		expect(formatCellSpan('見出し', 1, 1, 'left', 'middle')).toBe('見出し{valign=middle}');
		expect(formatCellSpan('新キャラ', 3, 1, 'center', 'middle')).toBe('新キャラ{colspan=3 align=center valign=middle}');
		expect(formatCellSpan('A', 1, 1, 'left', 'top')).toBe('A');
		expect(
			cellAlignmentClassNames({
				// 左右中央。クラスが付く
				align: 'center',
				// 上下中央。クラスが付く
				valign: 'middle'
			})
		).toBe('cm-md-table-align-center cm-md-table-valign-middle');
		expect(
			cellAlignmentClassNames({
				// 横の既定。クラスは付けない
				align: 'left',
				// 縦の既定。クラスは付けない
				valign: 'top'
			})
		).toBe('');
	});

	it('末尾の colwidths / rowheights を読む', () => {
		expect(parseCellSpan('{colwidths=120,80,200}')).toMatchObject({
			// 文字は無い。幅だけのセル
			text: '',
			// 列幅。px
			colwidths: [120, 80, 200],
			// 行高は未指定。空
			rowheights: []
		});
		expect(parseCellSpan('見出し{colspan=2 colwidths=100,90 rowheights=32,40}')).toMatchObject({
			// 表示する文字。記法は含まない
			text: '見出し',
			// 横にまたぐ列数
			colspan: 2,
			// 列幅。px
			colwidths: [100, 90],
			// 行高。px
			rowheights: [32, 40]
		});
		expect(formatCellSpan('', 1, 1, 'left', 'top', [120, 80], [32, 40])).toBe('{colwidths=120,80 rowheights=32,40}');
		expect(formatCellSpan('A', 2, 1, 'center', 'top', [100, 90], [])).toBe('A{colspan=2 align=center colwidths=100,90}');
	});

	it('見出し左上セルから列幅・行高を読み書きする', () => {
		// 幅も高さも無い 2 列の表
		const data = tableData(createState('|   |   |\n|---|---|\n|A|B|\n'));
		// 未指定。どちらも undefined
		expect(readTableLayout(data)).toEqual({
			// 列幅。未指定
			widths: undefined,
			// 行高。未指定
			heights: undefined
		});
		// 列幅と行高を左上セルへ書く変更
		const change = buildTableLayoutChange(data, {
			// 左から 120、80。px
			widths: [120, 80],
			// 上から 28、40。px
			heights: [28, 40]
		});
		expect(change?.insert).toBe('{colwidths=120,80 rowheights=28,40}');
		// 同じ幅と高さが既に書いてある表
		const sized = tableData(createState('| {colwidths=120,80 rowheights=28,40} |   |\n|---|---|\n|A|B|\n'));
		// 読み戻した幅と高さ
		expect(readTableLayout(sized)).toEqual({
			// 列幅。px
			widths: [120, 80],
			// 行高。px
			heights: [28, 40]
		});
	});

	it('占有グリッドで覆われるマスを付ける', () => {
		// 1 行目が 3 列をまたぐ表。隣のマスは覆われる
		const data      = tableData(createState('|   |   |   |\n|---|---|---|\n|新キャラ{colspan=3}|  |  |\n|A|B|C|'));
		// 結合が覆うマス。原点は覆われない
		const occupancy = buildTableOccupancy(data);
		// 結合の原点。覆われない
		expect(
			isCoveredTableCell(occupancy, {
				// データ行の先頭
				row: 1,
				// 左端
				column: 0
			})
		).toBe(false);
		// 原点の右。結合に覆われる
		expect(
			isCoveredTableCell(occupancy, {
				// 同じ行
				row: 1,
				// 2 列目
				column: 1
			})
		).toBe(true);
		// 原点のさらに右。結合に覆われる
		expect(
			isCoveredTableCell(occupancy, {
				// 同じ行
				row: 1,
				// 3 列目
				column: 2
			})
		).toBe(true);
		// 原点セル。3 列をまたぎ、自分は覆われない
		expect(occupancy.cells[1]![0]).toMatchObject({
			// またぐ列数
			colspan: 3,
			// 行はまたがない
			rowspan: 1,
			// 原点なので覆われない
			covered: false
		});
	});

	it('矩形選択を結合し、解除できる', () => {
		// 結合前の 3 セル。1 行を矩形にする
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A|B|C|'));
		// データ行の 3 列全部
		const rect = {
			// 開始行。最初のデータ行
			startRow: 1,
			// 開始列。左端
			startColumn: 0,
			// 終了行。同じ行
			endRow: 1,
			// 終了列。右端
			endColumn: 2
		};
		expect(getTableMergeActionState(data, rect).canMerge).toBe(true);
		// 矩形を 1 セルにまとめる変更
		const merged = buildMergeTableCellsChanges(data, rect);
		expect(merged).not.toBeNull();
		// 見出しセルの文字列。このケースでは書き換えない
		const next = data.headerSources[0]!.text;
		void next;
		// 結合を書き終えた文書
		const applied    = createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |');
		// その表データ。解除できる
		const mergedData = tableData(applied);
		expect(getTableMergeActionState(mergedData, rect).canUnmerge).toBe(true);
		// 結合を外す変更。先頭セルは A に戻る
		const undone = buildUnmergeTableCellsChanges(mergedData, rect);
		expect(undone?.[0]?.insert).toBe('A');
	});

	it('結合を文書へ書いたあと抽出し、解除で属性を消す', () => {
		// 結合前の文書。変更を適用してから解除する
		let state    = createState('|   |   |   |\n|---|---|---|\n|A|B|C|');
		// 結合前の表データ
		const data   = tableData(state);
		// データ行 3 列をまとめる変更
		const merged = buildMergeTableCellsChanges(data, {
			// 開始行。最初のデータ行
			startRow: 1,
			// 開始列。左端
			startColumn: 0,
			// 終了行。同じ行
			endRow: 1,
			// 終了列。右端
			endColumn: 2
		});
		expect(merged).not.toBeNull();
		// 結合を文書へ書く
		state            = state.update({
			// セルごとの置換
			changes: merged!.map((change) => ({
				// 置換の開始。文書オフセット
				from: change.from,
				// 置換の終了。文書オフセット
				to: change.to,
				// 結合後のセル文字列
				insert: change.insert
			}))
		}).state;
		// 結合を書き込んだあとの表データ
		const mergedData = tableData(state);
		expect(mergedData.rowSources[0]![0]!.text).toContain('{colspan=3}');
		expect(getTableDataIdentity(data)).not.toBe(getTableDataIdentity(mergedData));
		// 覆われたマスから結合全体を外す変更
		const undone = buildUnmergeTableCellsChanges(
			mergedData,
			resolveTableMergeRect(mergedData, null, {
				// 覆われたマスの行
				row: 1,
				// 覆われたマスの列
				column: 1
			})!
		);
		expect(undone?.[0]?.insert).toBe('A');
		// 解除を文書へ書く
		state = state.update({
			// セルごとの置換
			changes: undone!.map((change) => ({
				// 置換の開始。文書オフセット
				from: change.from,
				// 置換の終了。文書オフセット
				to: change.to,
				// 結合を外したセル文字列
				insert: change.insert
			}))
		}).state;
		expect(tableData(state).rowSources[0]![0]!.text).toBe('A');
	});

	it('結合は配置を残し、解除は結合だけ外す', () => {
		// 左セルに配置がある。結合しても配置は残す
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A{align=center valign=middle}|B|C|'));
		// データ行の 3 列
		const rect = {
			// 開始行。最初のデータ行
			startRow: 1,
			// 開始列。左端
			startColumn: 0,
			// 終了行。同じ行
			endRow: 1,
			// 終了列。右端
			endColumn: 2
		};
		expect(buildMergeTableCellsChanges(data, rect)?.map((change) => change.insert)).toContain('A{colspan=3 align=center valign=middle}');
		// 配置付きで結合済みの表。解除しても配置は残る
		const mergedData = tableData(createState('|   |   |   |\n|---|---|---|\n|A{colspan=3 align=center valign=middle}|  |  |'));
		expect(buildUnmergeTableCellsChanges(mergedData, rect)?.map((change) => change.insert)).toContain('A{align=center valign=middle}');
	});

	it('見出し結合がある表でも1行目3列目へ配置を書く', () => {
		// 見出しが 3 列結合。1 行目 3 列目へ配置を書く
		const doc   = ['|見出し１{colspan=3 colwidths=138,136,169 rowheights=32,32,32}|||', '|---|---|---|', '|データ１－１|データ１－２|a|', '|データ２－１|a<br>b<br>c|b{align=right valign=middle}|'].join('\n');
		// その表の状態
		const state = createState(doc);
		// 配置を書く対象の表データ
		const data  = tableData(state);
		expect(data.rowSources[0]![2]!.text).toBe('a');
		// 1 行目 3 列目だけを右・中央にする変更
		const written = buildAlignTableCellsChanges(
			data,
			{
				// 開始行。最初のデータ行
				startRow: 1,
				// 開始列。3 列目
				startColumn: 2,
				// 終了行。同じ行
				endRow: 1,
				// 終了列。1 セル
				endColumn: 2
			},
			{
				// 右寄せ
				align: 'right',
				// 上下中央
				valign: 'middle'
			}
		);
		expect(written?.[0]?.insert).toBe('a{align=right valign=middle}');

		// 配置を 1 セルへ書くビュー。表の DOM は持たない
		const view = {
			// 書き込み前の状態
			state,
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: TransactionSpec) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			},
			// 表の DOM は持たない
			dom: {
				/**
				 *
				 */
				querySelector: () => null
			}
		};
		expect(
			applyTableAlignSnapshot(
				view as never,
				{
					// 対象表の開始
					tableFrom: data.tableFrom,
					// 1 行目 3 列目の 1 セル
					rect: {
						// 開始行。最初のデータ行
						startRow: 1,
						// 開始列。3 列目
						startColumn: 2,
						// 終了行。同じ行
						endRow: 1,
						// 終了列。1 セル
						endColumn: 2
					}
				},
				{
					// 右寄せ
					align: 'right',
					// 上下中央
					valign: 'middle'
				}
			)
		).toBe(true);
		expect(tableData(view.state).rowSources[0]![2]!.text).toBe('a{align=right valign=middle}');
		expect(tableData(view.state).rowSources[1]![2]!.text).toBe('b{align=right valign=middle}');
	});

	it('配置の書き込みは表全体を1置換にしてウィジェットを作り直す', () => {
		// 1 セルの表。配置を表全体の 1 置換にする
		const state   = createState('|   |\n|---|\n|100|');
		// その表データ
		const data    = tableData(state);
		// 右寄せにする変更。1 セル
		const written = buildAlignTableCellsChanges(
			data,
			{
				// 開始行。最初のデータ行
				startRow: 1,
				// 開始列。左端
				startColumn: 0,
				// 終了行。同じ行
				endRow: 1,
				// 終了列。1 セル
				endColumn: 0
			},
			{
				// 右寄せ。縦は既定のまま
				align: 'right'
			}
		);
		expect(written).not.toBeNull();
		// セル単位の変更を、表全体の 1 置換へまとめた結果
		const collapsed = collapseTableDocumentChanges(state.doc.sliceString(data.tableFrom, data.tableTo), data.tableFrom, data.tableTo, written!);
		expect(collapsed.from).toBe(data.tableFrom);
		expect(collapsed.to).toBe(data.tableTo);
		expect(collapsed.insert).toContain('100{align=right}');

		// dispatch へ渡した仕様。1 件なら表全体の 1 置換
		const dispatched: TransactionSpec[] = [];
		// 仕様を控えるビュー
		const view                          = {
			// 書き込み前の 1 セル表
			state,
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: TransactionSpec) {
				dispatched.push(spec);
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			},
			// 表の DOM は持たない
			dom: {
				/**
				 *
				 */
				querySelector: () => null
			}
		};
		expect(
			applyTableAlignSnapshot(
				view as never,
				{
					// 対象表の開始
					tableFrom: data.tableFrom,
					// データ行の 1 セル
					rect: {
						// 開始行。最初のデータ行
						startRow: 1,
						// 開始列。左端
						startColumn: 0,
						// 終了行。同じ行
						endRow: 1,
						// 終了列。1 セル
						endColumn: 0
					}
				},
				{
					// 右寄せ。縦は既定のまま
					align: 'right'
				}
			)
		).toBe(true);
		expect(dispatched[0]?.changes).toEqual({
			// 表全体の開始
			from: data.tableFrom,
			// 表全体の終了
			to: data.tableTo,
			// 配置を書き込んだ表
			insert: collapsed.insert
		});
		expect(tableData(view.state).rowSources[0]![0]!.text).toBe('100{align=right}');
	});

	it('配置書き込み後は描画中のセルへ揃えクラスを付ける', () => {
		// セルに付いているクラス。配置クラスの付け外しを見る
		const names = new Set<string>();
		// 1 行目 3 列目の描画セル。配置をクラスと style へ反映する
		const cell  = {
			// 行・列と、配置前のソース
			dataset: {
				// 先頭データ行。文字列
				tableRow: '1',
				// 3 列目。0 始まりの文字列
				tableColumn: '2',
				// 配置前のソース
				source: 'a',
				// 表示する編集値
				editableText: 'a'
			},
			// 文字の配置。空は未設定
			style: {
				// 横位置。空は既定
				textAlign: '',
				// 縦位置。空は既定
				verticalAlign: ''
			},
			// 配置クラスの付け外し
			classList: {
				/**
				 * @returns クラス
				 */
				[Symbol.iterator](): IterableIterator<string> {
					return names.values();
				},
				/**
				 * @param next - 追加
				 */
				add(...next: string[]) {
					for (const name of next) {
						names.add(name);
					}
				},
				/**
				 * @param next - 削除
				 */
				remove(...next: string[]) {
					for (const name of next) {
						names.delete(name);
					}
				}
			}
		};
		// 表の枠。query は描画中のセルを返す
		const wrap  = {
			// 表枠クラスがあるときだけ真
			classList: {
				/**
				 *
				 */
				contains: (name: string) => name === 'cm-md-table-wrap'
			},
			// 表の開始と終了。どちらも文書先頭
			dataset: {
				// 表の開始オフセット。文字列
				tableFrom: '0',
				// 表の終了オフセット。文字列
				tableTo: '0'
			},
			/**
			 * @returns セル
			 */
			querySelectorAll() {
				return [cell];
			}
		};
		// 3 列目が右寄せの表。描画セルへ同じクラスを付ける
		const doc   = ['|見出し１{colspan=3 colwidths=138,136,169 rowheights=32,32,32}|||', '|---|---|---|', '|データ１－１|データ１－２|a{align=right}|', '|データ２－１|a<br>b<br>c|b|'].join('\n');
		// その表の状態
		const state = createState(doc);
		// 描画と突き合わせる表データ
		const data  = tableData(state);
		// 枠の query が描画セルを返すビュー
		const view  = {
			// 配置を描画セルへ反映する状態
			state,
			// 枠を 1 つ返す DOM
			dom: {
				/**
				 * @returns 表
				 */
				querySelector() {
					return wrap;
				},
				/**
				 * @returns 表
				 */
				querySelectorAll() {
					return [wrap];
				}
			},
			// 編集面も同じ枠を返す
			contentDOM: {
				/**
				 * @returns 表
				 */
				querySelector() {
					return wrap;
				},
				/**
				 * @returns 表
				 */
				querySelectorAll() {
					return [wrap];
				}
			}
		};

		syncRenderedTableAlignment(view as never, data.tableFrom);
		expect(cell.dataset.source).toBe('a{align=right}');
		expect([...names]).toEqual(['cm-md-table-align-right']);
		expect(cell.style.textAlign).toBe('right');
	});

	it('配置だけ違う同じ位置の表は identity が違う', () => {
		// 配置の無い 100
		const plain   = tableData(createState('|   |\n|---|\n|100|'));
		// 同じ位置で右・中央。identity は別
		const aligned = tableData(createState('|   |\n|---|\n|100{align=right valign=middle}|'));
		expect(getTableDataIdentity(plain)).not.toBe(getTableDataIdentity(aligned));
	});

	it('配置を書いた直後のセル確定は属性を消さない', () => {
		// 配置を書いた直後にセル確定しても属性を消さない
		let state     = createState('|   |\n|---|\n|100|');
		// 書き込み前の表データ
		const data    = tableData(state);
		// 右・中央にする変更
		const written = buildAlignTableCellsChanges(
			data,
			{
				// 開始行。最初のデータ行
				startRow: 1,
				// 開始列。左端
				startColumn: 0,
				// 終了行。同じ行
				endRow: 1,
				// 終了列。1 セル
				endColumn: 0
			},
			{
				// 右寄せ
				align: 'right',
				// 上下中央
				valign: 'middle'
			}
		);
		expect(written?.[0]?.insert).toBe('100{align=right valign=middle}');
		// 配置を文書へ書く
		state       = state.update({
			// セルごとの置換
			changes: written!.map((change) => ({
				// 置換の開始。文書オフセット
				from: change.from,
				// 置換の終了。文書オフセット
				to: change.to,
				// 配置付きのセル文字列
				insert: change.insert
			}))
		}).state;
		// 配置を書き込んだあとの表データ。確定しても属性が残る
		const after = tableData(state);
		expect(after.rowSources[0]![0]!.text).toBe('100{align=right valign=middle}');
		expect(
			buildTableCellChange(
				after,
				{
					// 先頭データ行
					row: 1,
					// 先頭列。配置は残す
					column: 0
				},
				'100'
			)?.insert
		).toBe('100{align=right valign=middle}');
	});

	it('選択範囲の原点セルへ配置を書く', () => {
		// 右セルだけ配置がある。矩形の原点へも書く
		const data    = tableData(createState('|   |   |\n|---|---|\n|A|B{align=right}|'));
		// データ行の 2 列
		const rect    = {
			// 開始行。最初のデータ行
			startRow: 1,
			// 開始列。左端
			startColumn: 0,
			// 終了行。同じ行
			endRow: 1,
			// 終了列。右端
			endColumn: 1
		};
		// 両方を中央・上下中央にする変更
		const written = buildAlignTableCellsChanges(data, rect, {
			// 中央
			align: 'center',
			// 上下中央
			valign: 'middle'
		});
		expect(written?.map((change) => change.insert)).toEqual(['B{align=center valign=middle}', 'A{align=center valign=middle}']);
		expect(buildAlignTableCellsChanges(data, rect, { align: 'left' })?.[0]?.insert).toBe('B');
	});

	it('1セルだけの矩形は塗らず、複数セルだけ塗る', () => {
		expect(
			isMultiCellTableSelectionRect({
				// 開始行
				startRow: 1,
				// 開始列
				startColumn: 1,
				// 終了行。開始と同じなので 1 セル
				endRow: 1,
				// 終了列。開始と同じ
				endColumn: 1
			})
		).toBe(false);
		expect(
			isMultiCellTableSelectionRect({
				// 開始行
				startRow: 1,
				// 開始列
				startColumn: 1,
				// 終了行。同じ行
				endRow: 1,
				// 終了列。右隣まで
				endColumn: 2
			})
		).toBe(true);
		expect(
			isMultiCellTableSelectionRect({
				// 開始行
				startRow: 1,
				// 開始列
				startColumn: 1,
				// 終了行。次の行
				endRow: 2,
				// 終了列。同じ列
				endColumn: 1
			})
		).toBe(true);
	});

	it('選択範囲の外周辺だけをセルに付ける', () => {
		// 2 行 3 列の選択。外周だけをセルに付ける
		const rect = {
			// 開始行
			startRow: 1,
			// 開始列。左端
			startColumn: 0,
			// 終了行。次の行
			endRow: 2,
			// 終了列。右端
			endColumn: 2
		};
		expect(
			describeTableCellSelection(
				{
					// 選択の上端
					row: 1,
					// 選択の左端
					column: 0
				},
				1,
				1,
				rect
			)
		).toEqual({
			// 範囲内
			selected: true,
			// 上辺
			north: true,
			// 下辺ではない
			south: false,
			// 右辺ではない
			east: false,
			// 左辺
			west: true
		});
		expect(
			describeTableCellSelection(
				{
					// 選択の下端
					row: 2,
					// 選択の右端
					column: 2
				},
				1,
				1,
				rect
			)
		).toEqual({
			// 範囲内
			selected: true,
			// 上辺ではない
			north: false,
			// 下辺
			south: true,
			// 右辺
			east: true,
			// 左辺ではない
			west: false
		});
		expect(
			describeTableCellSelection(
				{
					// 結合セルの原点
					row: 1,
					// 結合の左端
					column: 0
				},
				2,
				3,
				rect
			)
		).toEqual({
			// 結合全体が範囲に入る
			selected: true,
			// 上辺
			north: true,
			// 下辺
			south: true,
			// 右辺
			east: true,
			// 左辺
			west: true
		});
		expect(
			describeTableCellSelection(
				{
					// 範囲の外
					row: 0,
					// 範囲の外
					column: 0
				},
				1,
				1,
				rect
			)
		).toEqual({
			// 範囲外
			selected: false,
			// 辺は付けない
			north: false,
			// 辺は付けない
			south: false,
			// 辺は付けない
			east: false,
			// 辺は付けない
			west: false
		});
	});

	it('結合セルからは覆われたマスを飛ばして移動する', () => {
		// 1 行目が 3 列結合。右のマスは飛ばす
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |\n|D|E|F|'));
		expect(
			getVisibleAdjacentTableCellPosition(
				data,
				{
					// 結合の原点
					row: 1,
					// 左端
					column: 0
				},
				'next'
			)
		).toEqual({
			// 覆われた右を飛ばした次の行
			row: 2,
			// その行の左端
			column: 0
		});
		expect(
			getVisibleAdjacentTableCellPosition(
				data,
				{
					// 結合の下の行
					row: 2,
					// 左端
					column: 0
				},
				'up'
			)
		).toEqual({
			// 結合の原点の行
			row: 1,
			// 原点の列
			column: 0
		});
	});

	it('上下キーは覆われているマスの結合原点へ入る', () => {
		// 1 行目と 3 行目が 3 列結合。上下は原点へ入る
		const data = tableData(createState(['見出し１{colwidths=111,97,32 rowheights=32,263}|||', '|---|---|---|', '|データ１－１{colspan=3}||', '|データ２－１|あああ<br>いいい|', '|データ３－１{colspan=3}||'].join('\n')));
		expect(
			getVisibleAdjacentTableCellPosition(
				data,
				{
					// 改行セルの行
					row: 2,
					// 改行セルの列
					column: 1
				},
				'up'
			)
		).toEqual({
			// 上の結合の原点の行
			row: 1,
			// 原点の列
			column: 0
		});
		expect(
			getVisibleAdjacentTableCellPosition(
				data,
				{
					// 改行セルの行
					row: 2,
					// 改行セルの列
					column: 1
				},
				'down'
			)
		).toEqual({
			// 下の結合の原点の行
			row: 3,
			// 原点の列
			column: 0
		});
		expect(
			getVisibleAdjacentTableCellPosition(
				data,
				{
					// 上の結合の原点
					row: 1,
					// 左端
					column: 0
				},
				'down'
			)
		).toEqual({
			// 改行セルの行
			row: 2,
			// 覆われていない左端
			column: 0
		});
		expect(
			getVisibleAdjacentTableCellPosition(
				data,
				{
					// 下の結合の原点
					row: 3,
					// 左端
					column: 0
				},
				'up'
			)
		).toEqual({
			// 改行セルの行
			row: 2,
			// 覆われていない左端
			column: 0
		});
	});

	it('検証表の結合セルは表位置だけから解除できる', () => {
		// 表位置だけで 1 行目の結合を外す
		const state    = createState(['見出し１{colwidths=111,97,32 rowheights=32,263}|||', '|---|---|---|', '|データ１－１{colspan=3}||', '|データ２－１|あああ<br>いいい|', '|データ３－１{colspan=3}||'].join('\n'));
		// その表データ
		const data     = tableData(state);
		// 覆われたマスから結合全体を解決した結果
		const resolved = resolveTableMergeTargetFromParts(state, data.tableFrom, null, {
			// 覆われたマスの行
			row: 1,
			// 覆われたマスの列
			column: 1
		});
		expect(resolved?.state.canUnmerge).toBe(true);
		// 解決した矩形の結合を外す変更
		const undone = buildUnmergeTableCellsChanges(resolved!.data, resolved!.state.rect);
		expect(undone?.[0]?.insert).toBe('データ１－１');
		// 解除を適用した状態
		const next = state.update({
			// セルごとの置換
			changes: undone!.map((change) => ({
				// 置換の開始。文書オフセット
				from: change.from,
				// 置換の終了。文書オフセット
				to: change.to,
				// 結合を外したセル文字列
				insert: change.insert
			}))
		}).state;
		expect(tableData(next).rowSources[0]![0]!.text).toBe('データ１－１');
		expect(tableData(next).rowSources[0]![0]!.text).not.toContain('colspan');
	});

	it('メニュー時点のスナップショットから解除すると colspan が消える', () => {
		// メニューを開いた時点の結合表
		const state    = createState(['見出し１{colwidths=111,97,32 rowheights=32,263}|||', '|---|---|---|', '|データ１－１{colspan=3}||', '|データ２－１|あああ<br>いいい|', '|データ３－１{colspan=3}||'].join('\n'));
		// その表データ。スナップショットの位置
		const data     = tableData(state);
		// 1 行目の結合。解除対象
		const resolved = resolveTableMergeTargetFromParts(state, data.tableFrom, null, {
			// 覆われたマスの行
			row: 1,
			// 覆われたマスの列
			column: 1
		});
		// dispatch で解除を書くビュー
		const view     = {
			// メニュー時点の状態。解除をここに書く
			state,
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: TransactionSpec) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			},
			/**
			 *
			 */
			focus() {},
			// 表の DOM は持たない
			dom: {
				/**
				 *
				 */
				querySelector: () => null
			}
		};

		expect(
			applyTableMergeSnapshot(
				view as never,
				{
					// メニュー時点の表の開始
					tableFrom: data.tableFrom,
					// 解除する結合の矩形
					rect: resolved!.state.rect
				},
				'unmerge'
			)
		).toBe(true);
		expect(tableData(view.state).rowSources[0]![0]!.text).toBe('データ１－１');
		expect(tableData(view.state).rowSources[2]![0]!.text).toContain('{colspan=3}');
	});

	it('1セルクリックは結合全体を解除対象にする', () => {
		// 1 行目が 3 列結合。覆われたマスをクリックする
		const data = tableData(createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |\n|D|E|F|'));
		expect(
			resolveTableMergeRect(data, null, {
				// 覆われたマスの行
				row: 1,
				// 覆われたマスの列
				column: 1
			})
		).toEqual({
			// 結合の開始行
			startRow: 1,
			// 結合の開始列。原点
			startColumn: 0,
			// 結合の終了行。同じ行
			endRow: 1,
			// 結合の終了列。右端
			endColumn: 2
		});
		expect(
			getTableMergeActionState(
				data,
				resolveTableMergeRect(data, null, {
					// 覆われた右端の行
					row: 1,
					// 覆われた右端の列
					column: 2
				})!
			).canUnmerge
		).toBe(true);
		expect(
			buildUnmergeTableCellsChanges(
				data,
				resolveTableMergeRect(data, null, {
					// 覆われたマスの行
					row: 1,
					// 覆われたマスの列
					column: 1
				})!
			)?.[0]?.insert
		).toBe('A');
		expect(
			resolveTableMergeRect(
				data,
				{
					// 2 行目の開始
					startRow: 2,
					// 左端
					startColumn: 0,
					// 同じ行
					endRow: 2,
					// 右端
					endColumn: 2
				},
				{
					// その行の中央
					row: 2,
					// 中央列
					column: 1
				}
			)
		).toEqual({
			// 渡した矩形の開始行
			startRow: 2,
			// 渡した矩形の開始列
			startColumn: 0,
			// 渡した矩形の終了行
			endRow: 2,
			// 渡した矩形の終了列
			endColumn: 2
		});
	});
});
