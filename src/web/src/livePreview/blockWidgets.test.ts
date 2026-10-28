/**
 * 表、画像、Mermaid、HTML 表をウィジェットへ置き換える条件を検証する
 * EditorState はヘルパーが都度作り、ホストのファイル読み込みはモックに置き換える
 * @file
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectBlockDecorationEntries, extractImageAltAndUrl, extractWikiEmbedPath } from './blockWidgets';
import { createDocumentContextExtensions } from './documentContext';
import { classifyImageSource } from './imageWidget';
import { applyImageDisplayWidth, applyImageWidthOnDocumentLine } from './imageResize';
import {
	buildAppendTableRowChange,
	buildTableCellChange,
	TableWidget,
	clearCellImageWidths,
	extractTableData,
	findTableNodeAt,
	forgetCellImageWidth,
	getTableDataIdentity,
	normalizeTableCellTextForIdentity,
	persistTableLayout,
	writeTableCellImageWidth,
	recallCellImageWidth,
	rememberCellImageWidth,
	getActiveTableCellInlineRangeIds,
	getAdjacentTableCellPosition,
	getNormalizedTableCellCaretOffset,
	getTableCellEditableOffsetFromPreview,
	getTableCellEditableCaretOffset,
	getTableCellLineCaretPosition,
	getTableCellVerticalArrowDirection,
	getTableCellVerticalCaretOffset,
	getTableCellVerticalNavigation,
	getTableVerticalExitPosition,
	getTableVerticalEntryTarget,
	hasTableSelectionPointerMoved,
	insertLineBreakAtOffset,
	isTableCellSoftBreakKey,
	isTableCellSelectAllKey,
	isTableEditExitKey,
	runTableCellDocumentHistory,
	tableCellPositionForTextChange,
	shouldRefreshEditingTableCell,
	shouldRefreshPreviewTableCell,
	shouldKeepSelectionOutsideTable,
	tableCellNeedsHeightBreak,
	tableCellSourceBreakIndexes,
	isBreakHtmlTag,
	normalizeEditableCellDomText,
	normalizeTableCellSource,
	observeTableStructureGeometry,
	resolveTableStructureOffset,
	restoreTableCellFocus,
	shouldPreserveTableCellSelectionOnMouseDown,
	shouldSyncTableCellEditorOnMouseDown,
	syncTableCellEditorSelection,
	syncTableDataAfterCellChange,
	TABLE_CELL_BREAK_CARET,
	tableCellNodesToPlainText
} from './tableWidget';
import { collectHtmlDecorationEntries } from './htmlInline';
import { collectHtmlBreakDecorationEntries } from './htmlBreak';

/**
 * ノートパス付きの Markdown 状態を作る
 * @param doc - ドキュメント全文
 * @param cursor - カーソル位置。省略時は文書先頭
 * @returns 文書文脈と TMS Markdown を載せた状態
 */
function createState(doc: string, cursor: number = 0): EditorState {
	return EditorState.create({
		// ウィジェット判定の本文
		doc,
		// 空のキャレット。省略時は文書先頭で、先頭行はソース表示になる
		selection: EditorSelection.cursor(cursor),
		// 表と画像の構文木、およびノートパス
		extensions: [
			createTmsMarkdownSupport(),
			...createDocumentContextExtensions({
				// 画像解決の基準にするノート。固定パス
				filePath: 'E:\\vault\\note.md',
				// リモート画像も読み込む。無効だと外部 URL を捨てる
				loadRemoteImages: true
			})
		]
	});
}

/**
 * 構文木から、指定名の最初のノードを探す
 * @param state - 構文木を読む状態
 * @param name - 探すノード名
 * @returns 最初のノード。無ければ null
 */
function findNode(state: EditorState, name: string) {
	// 最初に名前が一致したノード。無ければ null のまま
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param ref - ノード
		 * @returns 子の走査を止めるとき false。続けるときは値を返さない
		 */
		enter(ref) {
			// 指定名の最初の 1 つだけを採用し、探索を止める
			if (ref.name === name) {
				// 採用するノード。2 件目は見ない
				found = ref.node;
				return false;
			}
		}
	});
	return found;
}

describe('blockWidgets', () => {
	it('行列選択ヘッダーは表本体と余白が変わるラッパーの両方を監視する', () => {
		// 監視へ渡された要素。枠と表の両方
		const observed = [] as Element[];
		// observe の呼び出しを控えるモック
		const observer = {
			/** @param element - 監視対象 */
			observe(element: Element) {
				observed.push(element);
			}
		};
		// 余白が変わる枠。中身は持たない
		const wrap     = {} as Element;
		// 表本体。枠とは別に監視する
		const table    = {} as Element;

		observeTableStructureGeometry(observer, wrap, table);

		expect(observed).toEqual([wrap, table]);
	});

	it('選択ヘッダー表示直後は未反映の実測値よりCSS余白を優先する', () => {
		expect(resolveTableStructureOffset(0, 26, true)).toBe(26);
		expect(resolveTableStructureOffset(32, 26, true)).toBe(32);
		expect(resolveTableStructureOffset(0, 26, false)).toBe(0);
	});

	it('複数セル選択と右クリックでは単一セル編集位置へ同期しない', () => {
		// 主ボタンで Shift なし。単一セルの編集位置へ同期する
		expect(
			shouldSyncTableCellEditorOnMouseDown({
				// 主ボタン
				button: 0,
				// Shift なし。複数選択ではない
				shiftKey: false
			})
		).toBe(true);
		// 主ボタンでも Shift あり。複数選択なので同期しない
		expect(
			shouldSyncTableCellEditorOnMouseDown({
				// 主ボタン
				button: 0,
				// Shift あり
				shiftKey: true
			})
		).toBe(false);
		// 副ボタン。右クリックでは同期しない
		expect(
			shouldSyncTableCellEditorOnMouseDown({
				// 副ボタン
				button: 2,
				// Shift なし
				shiftKey: false
			})
		).toBe(false);
	});

	it('複数セル選択中の右クリックでは既定のセルフォーカス移動を抑止する', () => {
		// 複数選択中の副ボタン。セルのフォーカス移動を抑止する
		expect(
			shouldPreserveTableCellSelectionOnMouseDown(
				{
					// 副ボタン
					button: 2
				},
				true
			)
		).toBe(true);
		// 副ボタンでも複数選択でなければ抑止しない
		expect(
			shouldPreserveTableCellSelectionOnMouseDown(
				{
					// 副ボタン
					button: 2
				},
				false
			)
		).toBe(false);
		// 主ボタン。複数選択中でも既定の移動は抑止しない
		expect(
			shouldPreserveTableCellSelectionOnMouseDown(
				{
					// 主ボタン
					button: 0
				},
				true
			)
		).toBe(false);
	});

	it('セル結合後のフォーカス復元完了時に選択ヘッダーの配置を再計測する', () => {
		vi.useFakeTimers();
		try {
			// focus と再計測イベントの呼出順。空ならまだ動いていない
			const calls: string[] = [];
			// 編集中のセル。closest は親の枠を返す
			const cell            = {
				// 編集中。true のときだけ復元対象
				dataset: {
					// 編集中であることを示す値
					editing: 'true'
				},
				// 選択を消すための文書
				ownerDocument: {
					// getSelection を持つ窓
					defaultView: {
						/**
						 *
						 */
						getSelection: () => null
					}
				},
				/**
				 *
				 */
				closest: () => wrap,
				/**
				 *
				 */
				focus: () => calls.push('focus')
			};
			// 表の枠。query は編集中のセルを返す
			const wrap            = {
				// 表の開始位置。文書上の 10
				dataset: {
					// 表の開始オフセット。文字列
					tableFrom: '10'
				},
				/**
				 *
				 */
				querySelector: () => cell,
				/**
				 *
				 */
				querySelectorAll: () => [],
				/**
				 *
				 */
				dispatchEvent: (event: Event) => {
					calls.push(event.type);
					return true;
				}
			};
			// querySelector の回数。0 はまだ検索していない
			let queryCount        = 0;
			// 回数で枠とセルを返す DOM
			const view            = {
				// 枠とセルを回数で返す DOM
				dom: {
					/**
					 *
					 */
					querySelector: () => {
						// 検索回数を 1 進める。0 から数える
						queryCount += 1;
						// 1 回目は枠がまだ無い
						if (queryCount === 1) return null;
						// 2 回目は表の枠。それ以降はセル
						if (queryCount === 2) return wrap;
						return cell;
					}
				}
			};

			restoreTableCellFocus(
				view as never,
				10,
				{
					// 先頭データ行
					row: 1,
					// 2 列目。0 始まり
					column: 1
				},
				0,
				false
			);
			vi.runAllTimers();

			expect(calls).toEqual(['focus', 'tms-mde-table-geometry-change']);
		} finally {
			vi.useRealTimers();
		}
	});

	afterEach(() => {
		clearCellImageWidths();
	});

	it('classifyImageSource は URL / 絶対 / 相対を判定する', () => {
		expect(classifyImageSource('https://example.com/a.png')).toBe('url');
		expect(classifyImageSource('C:\\images\\a.png')).toBe('absolute');
		expect(classifyImageSource('./a.png')).toBe('relative');
		expect(classifyImageSource('images/a.png')).toBe('relative');
	});

	it('セル末尾の colspan は表示 AST から除きソースには残す', () => {
		// 3 列結合。表示からは記法を除き、ソースには残す。カーソルは先頭
		const state = createState('|   |   |   |\n| --- | --- | --- |\n| 新キャラ{colspan=3} |  |  |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		expect(tableCellNodesToPlainText(data.rows[0]![0]!)).toBe('新キャラ');
		expect(data.rowSources[0]![0]!.text).toContain('{colspan=3}');
		expect(data.rowSources[0]![0]!.editableText).toBe('新キャラ');
	});

	it('セル末尾の align / valign は表示 AST から除きソースには残す', () => {
		// 右寄せと上下中央。表示からは記法を除く。カーソルは先頭
		const state = createState('|   |\n| --- |\n| 100{align=right valign=middle} |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		expect(tableCellNodesToPlainText(data.rows[0]![0]!)).toBe('100');
		expect(data.rowSources[0]![0]!.text).toContain('{align=right valign=middle}');
		expect(data.rowSources[0]![0]!.editableText).toBe('100');
	});

	it('フェンス無し HTML 表をブロック widget にする', () => {
		// フェンス無しの HTML 表
		const doc     = '<table>\n<tr><th>見出し１</th><th>見出し２</th></tr>\n<tr><td>データ１－１</td><td>データ１－２</td></tr>\n</table>\n';
		// カーソルは文書末尾。表の行はプレビュー
		const state   = createState(doc, doc.length);
		// ブロック装飾。表や HTML 表の widget を含む
		const entries = collectBlockDecorationEntries(state);
		expect(entries.some((entry) => entry.decoration.spec.widget?.constructor.name === 'HtmlTableWidget')).toBe(true);
	});

	it('テーブルセル内の WikiEmbed を画像ノードにする', () => {
		// 幅の無い埋め込み画像が 1 セルにある表。カーソルは先頭
		const state = createState('|   |\n| --- |\n| ![[C:\\\\shots\\\\a.png]] |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		expect(table).not.toBeNull();
		// 表示ノードと、記法を残したソース
		const data = extractTableData(state, table!);
		expect(data.rows[0]![0]!.some((node) => node.kind === 'image')).toBe(true);
		// 先頭セルの画像。無ければ undefined
		const image = data.rows[0]![0]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.kind : null).toBe('embed');
	});

	it('表セルの \\|幅 を画像サイズとして保持する', () => {
		// 幅 72 の埋め込み。サイズを画像ノードに残す。カーソルは先頭
		const state = createState('|   |\n| --- |\n| ![[C:\\\\shots\\\\a.png\\|72]] |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 先頭セルの画像。無ければ undefined
		const image = data.rows[0]![0]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.width : null).toBe(72);
		expect(image?.kind === 'image' ? image.spec.sourceTo : null).toBeGreaterThan(image?.kind === 'image' ? (image.spec.sourceFrom ?? 0) : 0);
	});

	it('画像幅だけ違う表は同じ identity で、ウィジェットを作り直さない', () => {
		// 幅の有無だけが違う画像パス
		const path    = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png';
		// 幅の無い表。カーソルは先頭
		const plain   = createState(`|   |\n|---|\n|![[${path}]]|\n`, 0);
		// 幅 96 だけを足した表
		const sized   = createState(`|   |\n|---|\n|![[${path}\\|96]]|\n`, 0);
		// 幅を無視した identity
		const plainId = getTableDataIdentity(extractTableData(plain, findNode(plain, 'Table')!));
		// 幅があっても同じ identity
		const sizedId = getTableDataIdentity(extractTableData(sized, findNode(sized, 'Table')!));
		expect(normalizeTableCellTextForIdentity(`![[${path}\\|96]]`)).toBe(`![[${path}]]`);
		expect(plainId).toBe(sizedId);
	});

	it('中身が同じ別の表は identity が違う', () => {
		// 同じ中身の表。2 つ置くと位置だけが違う
		const block                                        = '| a | b |\n|---|---|\n| 1 | 2 |';
		// 空行を挟んで同じ表が 2 つ
		const state                                        = createState(`${block}\n\n${block}\n`);
		// 出現順の Table。空ならまだ走査していない
		const tables: import('@lezer/common').SyntaxNode[] = [];
		syntaxTree(state).iterate({
			/**
			 * @param ref - ノード
			 * @returns 子の走査を止めるとき false。続けるときは値を返さない
			 */
			enter(ref) {
				// Table だけを積む。子は走査しない
				if (ref.name === 'Table') {
					tables.push(ref.node);
					return false;
				}
			}
		});
		expect(tables).toHaveLength(2);
		// 1 つ目の表の identity
		const first  = getTableDataIdentity(extractTableData(state, tables[0]!));
		// 2 つ目。中身が同じでも位置が違う
		const second = getTableDataIdentity(extractTableData(state, tables[1]!));
		expect(first).not.toBe(second);
		// 1 つ目の widget
		const firstWidget  = new TableWidget(extractTableData(state, tables[0]!));
		// 2 つ目の widget。eq は false
		const secondWidget = new TableWidget(extractTableData(state, tables[1]!));
		expect(firstWidget.eq(secondWidget)).toBe(false);
	});

	it('列幅属性だけ違う同じ位置の表は identity が同じ', () => {
		// 列幅の無い表
		const plain = createState('| a | b |\n|---|---|\n| 1 | 2 |\n');
		// 列幅だけを足した同じ位置の表
		const sized = createState('| a{colwidths=120,80} | b |\n|---|---|\n| 1 | 2 |\n');
		expect(getTableDataIdentity(extractTableData(plain, findNode(plain, 'Table')!))).toBe(getTableDataIdentity(extractTableData(sized, findNode(sized, 'Table')!)));
	});

	it('セル本文だけ違う同じ位置の表は identity が同じ', () => {
		// 本文が 1 の表
		const first  = createState('| a | b |\n|---|---|\n| 1 | 2 |\n');
		// 同じ位置で本文だけ br を足した表。identity は同じ
		const second = createState('| a | b |\n|---|---|\n| 1<br>あ | 2 |\n');
		expect(getTableDataIdentity(extractTableData(first, findNode(first, 'Table')!))).toBe(getTableDataIdentity(extractTableData(second, findNode(second, 'Table')!)));
	});

	it('結合だけ違う同じ位置の表は identity が違い、ウィジェットを再利用しない', () => {
		// 結合前の 3 セル
		const plain        = createState('|   |   |   |\n|---|---|---|\n|A|B|C|\n');
		// 同じ位置を 3 列結合した表
		const merged       = createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |\n');
		// 結合前の widget
		const plainWidget  = new TableWidget(extractTableData(plain, findNode(plain, 'Table')!));
		// 結合後の widget。再利用しない
		const mergedWidget = new TableWidget(extractTableData(merged, findNode(merged, 'Table')!));
		expect(getTableDataIdentity(plainWidget.data)).not.toBe(getTableDataIdentity(mergedWidget.data));
		expect(plainWidget.eq(mergedWidget)).toBe(false);
		expect(mergedWidget.eq(plainWidget)).toBe(false);
	});

	it('配置だけ違う同じ位置の表は identity が違い、ウィジェットを再利用しない', () => {
		// 配置の無い 100
		const plain         = createState('|   |\n|---|\n|100|\n');
		// 右寄せと上下中央
		const aligned       = createState('|   |\n|---|\n|100{align=right valign=middle}|\n');
		// 中央だけ。右寄せとは別
		const centered      = createState('|   |\n|---|\n|100{align=center}|\n');
		// 配置なしの widget
		const plainWidget   = new TableWidget(extractTableData(plain, findNode(plain, 'Table')!));
		// 右・中央の widget
		const alignedWidget = new TableWidget(extractTableData(aligned, findNode(aligned, 'Table')!));
		// 中央だけの widget
		const centerWidget  = new TableWidget(extractTableData(centered, findNode(centered, 'Table')!));
		expect(getTableDataIdentity(plainWidget.data)).not.toBe(getTableDataIdentity(alignedWidget.data));
		expect(getTableDataIdentity(alignedWidget.data)).not.toBe(getTableDataIdentity(centerWidget.data));
		expect(plainWidget.eq(alignedWidget)).toBe(false);
		expect(alignedWidget.eq(centerWidget)).toBe(false);
	});

	it('配置が違う既存表の updateDOM は false を返し DOM を作り直す', () => {
		// 右寄せだけが付いた 1 セル。identity の比較に使う
		const aligned = createState('|   |\n|---|\n|100{align=right}|\n');
		// 右寄せの表 widget。updateDOM は作り直す
		const widget  = new TableWidget(extractTableData(aligned, findNode(aligned, 'Table')!));
		// 枠のクラス。配置クラスはまだ無い
		const names   = new Set<string>(['cm-md-table-wrap']);
		// 見出し行とデータ行。ソースは配置前
		const cells   = [
			// 見出しセル。配置クラスはまだ無い
			{
				// 行・列と、配置前のソース
				dataset: {
					// 見出し行。0 始まり
					tableRow: '0',
					// 先頭列。0 始まり
					tableColumn: '0',
					// 見出しのソース。空
					source: ''
				},
				// クラス列挙。空なので配置クラスは無い
				classList: {
					/**
					 *
					 */
					[Symbol.iterator]: () => [][Symbol.iterator]()
				}
			},
			// データセル。ソースは配置前の 100
			{
				// 行・列と、配置前のソース
				dataset: {
					// 先頭データ行。0 始まりの見出しの次
					tableRow: '1',
					// 先頭列。0 始まり
					tableColumn: '0',
					// 配置を付ける前のソース
					source: '100'
				},
				// クラス列挙。空なので配置クラスは無い
				classList: {
					/**
					 *
					 */
					[Symbol.iterator]: () => [][Symbol.iterator]()
				}
			}
		];
		// 配置クラスの無い表枠。updateDOM は作り直す
		const dom     = {
			// 枠クラスの有無。配置クラスは持たない
			classList: {
				/**
				 * @param name - クラス
				 * @returns 同一なら true
				 */
				contains(name: string) {
					return names.has(name);
				}
			},
			// 枠の dataset。属性は空
			dataset: {},
			/**
			 * @returns セル
			 */
			querySelectorAll() {
				return cells;
			}
		};
		expect(widget.updateDOM(dom as never, { state: aligned } as never)).toBe(false);
	});

	it('配置が同じ既存表の updateDOM は DOM を再利用する', () => {
		// 右寄せだけが付いた 1 セル。identity の比較に使う
		const aligned = createState('|   |\n|---|\n|100{align=right}|\n');
		// 右寄せの表 widget。DOM は再利用する
		const widget  = new TableWidget(extractTableData(aligned, findNode(aligned, 'Table')!));
		// 見出しセルのクラス。空は配置クラスが無い
		const header  = new Set<string>();
		// データセルのクラス。右寄せが既にある
		const data    = new Set<string>(['cm-md-table-align-right']);
		// 見出しと、配置済みのデータセル
		const cells   = [
			// 見出しセル。配置クラスは空のまま
			{
				// 行・列と、空のソースと編集値
				dataset: {
					// 見出し行。0 始まり
					tableRow: '0',
					// 先頭列。0 始まり
					tableColumn: '0',
					// 見出しのソース。空
					source: '',
					// 編集値。空
					editableText: ''
				},
				// クラスは空。追加と削除も空操作
				classList: {
					/**
					 *
					 */
					[Symbol.iterator]: () => header.values() /**
					 *
					 */,
					/**
					 *
					 */
					add() {} /**
					 *
					 */,
					/**
					 *
					 */
					remove() {}
				},
				// 文字の配置。空は未設定
				style: {
					// 横位置。空は既定
					textAlign: '',
					// 縦位置。空は既定
					verticalAlign: ''
				}
			},
			// データセル。右寄せクラスが既にある
			{
				// 行・列と、右寄せ付きソース
				dataset: {
					// 先頭データ行。0 始まりの見出しの次
					tableRow: '1',
					// 先頭列。0 始まり
					tableColumn: '0',
					// 右寄せを含むソース
					source: '100{align=right}',
					// 表示する編集値
					editableText: '100'
				},
				// 右寄せクラスが既にあり、追加と削除は空操作
				classList: {
					/**
					 *
					 */
					[Symbol.iterator]: () => data.values() /**
					 *
					 */,
					/**
					 *
					 */
					add() {} /**
					 *
					 */,
					/**
					 *
					 */
					remove() {}
				},
				// 文字の配置。空でもクラスが同じなら再利用する
				style: {
					// 横位置。空は既定
					textAlign: '',
					// 縦位置。空は既定
					verticalAlign: ''
				}
			}
		];
		// 枠クラスだけがある表。DOM は再利用する
		const dom     = {
			// 表枠クラスがあるときだけ真
			classList: {
				/**
				 * @param name - クラス
				 * @returns 同一なら true
				 */
				contains(name: string) {
					return name === 'cm-md-table-wrap';
				}
			},
			// 枠の dataset。属性は空
			dataset: {},
			/**
			 * @returns セル
			 */
			querySelectorAll() {
				return cells;
			}
		};
		expect(widget.updateDOM(dom as never, { state: aligned } as never)).toBe(true);
	});

	it('表と表の隙間では次の表を拾わない', () => {
		// 同じ中身の表。2 つ置くと位置だけが違う
		const block                                        = '| a | b |\n|---|---|\n| 1 | 2 |';
		// 空行を挟んで同じ表が 2 つ
		const state                                        = createState(`${block}\n\n${block}\n`);
		// 出現順の Table。空ならまだ走査していない
		const tables: import('@lezer/common').SyntaxNode[] = [];
		syntaxTree(state).iterate({
			/**
			 * @param ref - ノード
			 * @returns 子の走査を止めるとき false。続けるときは値を返さない
			 */
			enter(ref) {
				// Table だけを積む。子は走査しない
				if (ref.name === 'Table') {
					tables.push(ref.node);
					return false;
				}
			}
		});
		expect(tables).toHaveLength(2);
		expect(findTableNodeAt(state, tables[0]!.from)?.from).toBe(tables[0]!.from);
		expect(findTableNodeAt(state, tables[1]!.from)?.from).toBe(tables[1]!.from);
		expect(findTableNodeAt(state, tables[0]!.to)?.from).not.toBe(tables[1]!.from);
	});

	it('列幅の書き戻しは指定した表だけを変える', () => {
		// 同じ中身の表。2 つ目だけ列幅を書く
		const block = '| a | b |\n|---|---|\n| 1 | 2 |';
		// dispatch で 2 つ目の表だけを更新する
		const view  = {
			// 同じ表が 2 つ。2 つ目だけを変える
			state: createState(`${block}\n\n${block}\n`),
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: { changes: { from: number; to: number; insert: string } }) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			}
		};
		// 書き込み前の Table。2 件
		const tables: import('@lezer/common').SyntaxNode[] = [];
		syntaxTree(view.state).iterate({
			/**
			 * @param ref - ノード
			 * @returns 子の走査を止めるとき false。続けるときは値を返さない
			 */
			enter(ref) {
				// Table だけを積む。子は走査しない
				if (ref.name === 'Table') {
					tables.push(ref.node);
					return false;
				}
			}
		});
		expect(tables).toHaveLength(2);
		expect(
			persistTableLayout(
				view as never,
				tables[1]!.from,
				{
					// 2 列の幅。px
					widths: [160, 90],
					// 見出しとデータ行の高さ。px
					heights: [32, 32]
				},
				{
					// 列幅の変更
					kind: 'col',
					// 先頭列。0 始まり
					index: 0
				}
			)
		).toBe(true);

		// 書き込み後の Table。1 件目の位置は変わらない
		const after: import('@lezer/common').SyntaxNode[] = [];
		syntaxTree(view.state).iterate({
			/**
			 * @param ref - ノード
			 * @returns 子の走査を止めるとき false。続けるときは値を返さない
			 */
			enter(ref) {
				// Table だけを積む。子は走査しない
				if (ref.name === 'Table') {
					after.push(ref.node);
					return false;
				}
			}
		});
		expect(after).toHaveLength(2);
		expect(after[0]!.from).toBe(tables[0]!.from);
		expect(view.state.doc.sliceString(after[0]!.from, after[0]!.to)).not.toContain('colwidths');
		expect(view.state.doc.sliceString(after[1]!.from, after[1]!.to)).toContain('{colwidths=160,90}');
	});

	it('表セルクリック用の同期処理はCodeMirrorの選択をセルのソース位置へ移す', () => {
		// 見出しの後ろの表。セルクリックでソース位置へ移す
		const state = createState(['# 見出し', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n'));
		// 最初の表。表示とソースを分ける
		const data  = extractTableData(state, findNode(state, 'Table')!);
		// 選択の移動を受けるビュー
		const view  = {
			// クリック前の状態
			state,
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: import('@codemirror/state').TransactionSpec) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			}
		};

		expect(
			syncTableCellEditorSelection(view as never, data, {
				// 先頭データ行
				row: 1,
				// 2 列目。0 始まり
				column: 1
			})
		).toBe(true);
		expect(view.state.selection.main.head).toBe(data.rowSources[0]![1]!.from);
	});

	it('存在しない表セルではCodeMirrorの選択を変更しない', () => {
		// 1 セルだけの表。範囲外のクリックは選択を変えない
		const state = createState('| a |\n|---|\n| 1 |');
		// 最初の表。表示とソースを分ける
		const data  = extractTableData(state, findNode(state, 'Table')!);
		// dispatch されたら失敗。範囲外では呼ばない
		const view  = {
			// 選択は先頭のまま
			state,
			/**
			 */
			dispatch() {
				throw new Error('dispatchされないこと');
			}
		};

		expect(
			syncTableCellEditorSelection(view as never, data, {
				// 表に無い行
				row: 9,
				// 表に無い列
				column: 9
			})
		).toBe(false);
		expect(view.state.selection.main.head).toBe(0);
	});

	it('選択ヘッダー表示による表の再配置だけではセルドラッグ選択を開始しない', () => {
		// ドラッグ開始。4px 未満は再配置であって選択開始ではない
		const origin = {
			// 開始の横位置。px
			x: 420,
			// 開始の縦位置。px
			y: 280
		};
		expect(
			hasTableSelectionPointerMoved(origin, {
				// 開始と同じ横位置。px
				x: 420,
				// 開始と同じ縦位置。px
				y: 280
			})
		).toBe(false);
		expect(
			hasTableSelectionPointerMoved(origin, {
				// 開始から 3px。閾値未満
				x: 423,
				// 縦は開始のまま。px
				y: 280
			})
		).toBe(false);
		expect(
			hasTableSelectionPointerMoved(origin, {
				// 開始から 4px。選択開始
				x: 424,
				// 縦は開始のまま。px
				y: 280
			})
		).toBe(true);
		expect(
			hasTableSelectionPointerMoved(origin, {
				// 横は開始のまま。px
				x: 420,
				// 開始から 6px。選択開始
				y: 286
			})
		).toBe(true);
	});

	it('検証表の Windows パスでも覚えた幅で表示し、行へ書いたあと抽出できる', () => {
		// 覚えた幅 64 を表示し、行へも書くパス
		const path = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png';
		rememberCellImageWidth(path, 64, {
			// 先頭データ行
			row: 1,
			// 画像のある 4 列目。0 始まり
			column: 3
		});
		// 4 列目にそのパスがある 1 行の表
		const doc   = ['|   |   |   |   |   |', '|---|---|---|---|---|', `|クリスマス|ユイ(クリスマス)|クリユイ|![[${path}]]|火|`].join('\n');
		// カーソルは文書先頭。対象行はソース表示
		const state = createState(doc, 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 4 列目の画像。覚えた幅 64
		const image = data.rows[0]![3]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.raw : null).toBe(path);
		expect(image?.kind === 'image' ? image.spec.width : null).toBe(64);

		// 行テキストへ幅を書くビュー
		const view = {
			// 書き込み前の状態
			state,
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: { changes: { from: number; to: number; insert: string } }) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			}
		};
		// 画像記法の開始。見つからなければ -1
		const pos = doc.indexOf('![[');
		expect(applyImageWidthOnDocumentLine(view as never, pos, 64)).toBe(true);
		// 幅を書いたあとの表データ
		const written = extractTableData(view.state, findNode(view.state, 'Table')!);
		// 4 列目の画像。幅 64 が残る
		const sized   = written.rows[0]![3]!.find((node) => node.kind === 'image');
		expect(sized?.kind === 'image' ? sized.spec.width : null).toBe(64);
		expect(written.rowSources[0]![3]!.text).toContain('\\|64');
	});

	it('検証表4行目は TableWidget の view から \\|幅 を書く', () => {
		// 4 行目に書く Windows パス
		const path     = 'C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png';
		// そのパスを含む最終行
		const princess = `|プリンセス|ユイ(プリンセス)|プリユイ|![[${path}]]|光|`;
		// 見出しと 4 行。対象は最後の行
		const doc      = ['|   |   |   |   |   |', '|---|---|---|---|---|', '|クリスマス|ユイ(クリスマス)|クリユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image001-5.png]]|火|', '|サマー|ユイ(サマー)|水ユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image002.png]]|水|', '|ニューイヤー|ユイ(ニューイヤー)|正月ユイ|![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image003.png]]|光|', princess].join('\n');
		// カーソルは文書先頭。対象行はソース表示
		const state    = createState(doc, 0);
		// 4 行目へ幅を書く表データ
		const data     = extractTableData(state, findNode(state, 'Table')!);
		// 行へ \\|幅 を書くビュー
		const view     = {
			// 書き込み前の 4 行の表
			state,
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: { changes: { from: number; to: number; insert: string } }) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			}
		};
		// パスだけを持つ画像枠。表の枠は closest が返さない
		const wrap = {
			// スラッシュへ直したパス。表の枠は持たない
			dataset: {
				// 幅を書く画像のパス
				imagePath: path.replaceAll('\\', '/')
			},
			/**
			 * 祖先を探すモック。このケースでは表の枠を持たない
			 * @returns 常に null
			 */
			closest() {
				return null;
			}
		} as unknown as HTMLElement;
		expect(
			writeTableCellImageWidth(
				view as never,
				data,
				{
					// 4 行目。見出しの次から数えて 4
					row: 4,
					// 画像のある 4 列目。0 始まり
					column: 3
				},
				wrap,
				data.rows[3]![3] ?? [],
				430
			)
		).toBe(true);
		expect(view.state.doc.toString()).toContain('![[C:\\Users\\tmsys\\Pictures\\TMS-MDEditor\\Screenshots\\clip_image004.png\\|430]]');
		expect(view.state.doc.toString()).toContain('|光|');
		expect(view.state.doc.toString()).not.toContain('png|430]]|光|');
		expect(view.state.doc.toString()).toContain('clip_image003.png]]');
	});

	it('ソースに幅が無くても覚えた幅でセル画像を表示する', () => {
		rememberCellImageWidth('C:\\\\shots\\\\a.png', 96);
		// 幅の無い埋め込み画像が 1 セルにある表。カーソルは先頭
		const state = createState('|   |\n| --- |\n| ![[C:\\\\shots\\\\a.png]] |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 先頭セルの画像。無ければ undefined
		const image = data.rows[0]![0]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.raw : null).toBe('C:\\\\shots\\\\a.png');
		expect(image?.kind === 'image' ? image.spec.width : null).toBe(96);
	});

	it('ソースの幅を優先し、覚えた幅も更新する', () => {
		rememberCellImageWidth('C:\\\\shots\\\\a.png', 40);
		// 幅 72 の埋め込み。サイズを画像ノードに残す。カーソルは先頭
		const state = createState('|   |\n| --- |\n| ![[C:\\\\shots\\\\a.png\\|72]] |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 先頭セルの画像。無ければ undefined
		const image = data.rows[0]![0]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.width : null).toBe(72);
		expect(recallCellImageWidth('C:\\\\shots\\\\a.png')).toBe(72);
	});

	it('ソースから幅を消したら覚えた幅も忘れる', () => {
		rememberCellImageWidth('C:\\\\shots\\\\a.png', 88);
		forgetCellImageWidth('C:\\\\shots\\\\a.png');
		// 幅の無い埋め込み画像が 1 セルにある表。カーソルは先頭
		const state = createState('|   |\n| --- |\n| ![[C:\\\\shots\\\\a.png]] |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 先頭セルの画像。無ければ undefined
		const image = data.rows[0]![0]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.width : null).toBeNull();
	});

	it('表セルへ幅を書いたあと抽出でも幅を保つ', () => {
		// 2 列目の画像へ幅 88 を書く表
		const doc  = '| a | 画像 |\n| --- | --- |\n| 1 | ![[C:\\\\shots\\\\a.png]] |\n';
		// その表。カーソルは先頭
		const view = {
			// 幅を書く前。カーソルは先頭
			state: createState(doc, 0),
			/**
			 * @param spec - 更新
			 */
			dispatch(spec: { changes: { from: number; to: number; insert: string } }) {
				// 渡された更新を状態へ反映する
				this.state = this.state.update(spec).state;
			}
		};
		// 画像記法の開始。見つからなければ -1
		const pos = doc.indexOf('![[');
		expect(applyImageDisplayWidth(view as never, pos, 88)).toBe(true);
		// 書き込み後の Table。無ければ null
		const table = findNode(view.state, 'Table');
		// 幅がソースに残った表データ
		const data  = extractTableData(view.state, table!);
		// 2 列目の画像。幅 88
		const image = data.rows[0]![1]!.find((node) => node.kind === 'image');
		expect(image?.kind === 'image' ? image.spec.width : null).toBe(88);
		expect(data.rowSources[0]![1]!.text).toContain('\\|88');
		expect(getTableDataIdentity(data)).toBe(getTableDataIdentity(extractTableData(view.state, table!)));
	});

	it('テーブルデータを抽出し、強調・ハイライトを保持する', () => {
		// 太字とハイライト。表示ノードに kind が残る。カーソルは先頭
		const state = createState('| a | b |\n| --- | --- |\n| **1** | ==y== |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		expect(table).not.toBeNull();
		// 表示ノードと、記法を残したソース
		const data = extractTableData(state, table!);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('a');
		expect(tableCellNodesToPlainText(data.rows[0]![0]!)).toBe('1');
		expect(data.rows[0]![0]!.some((node) => node.kind === 'strong')).toBe(true);
		expect(data.rows[0]![1]!.some((node) => node.kind === 'highlight')).toBe(true);
	});

	it('テーブルの空セルと末尾空行を列として保持する', () => {
		// 空セルと末尾の空行。列数は落とさない。カーソルは先頭
		const state = createState('| No. | 内容 | 備考 |\n| --- | --- | --- |\n| | | 情報行 |\n| | | |\n', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		expect(table).not.toBeNull();
		// 表示ノードと、記法を残したソース
		const data = extractTableData(state, table!);
		expect(data.rows[0]).toHaveLength(3);
		expect(tableCellNodesToPlainText(data.rows[0]![0]!)).toBe('');
		expect(tableCellNodesToPlainText(data.rows[0]![1]!)).toBe('');
		expect(tableCellNodesToPlainText(data.rows[0]![2]!)).toBe('情報行');
		expect(data.rows[1]).toHaveLength(3);
		expect(data.rowSources[1]).toHaveLength(3);
		expect(data.rows[1]!.map(tableCellNodesToPlainText)).toEqual(['', '', '']);
	});

	it('isBreakHtmlTag は br 系のみ真', () => {
		expect(isBreakHtmlTag('<br>')).toBe(true);
		expect(isBreakHtmlTag('<br/>')).toBe(true);
		expect(isBreakHtmlTag('<br />')).toBe(true);
		expect(isBreakHtmlTag('<span>')).toBe(false);
	});

	it('表セルの [[path\\|label]] はラベルだけを表示する', () => {
		// パスとラベル。見えるのはラベルだけ
		const doc   = '| [[docs/要望_009\\|要望_009]] |\n| --- |\n';
		// カーソルは文書先頭。対象行はソース表示
		const state = createState(doc, 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 見出しセルの内部リンク。無ければ undefined
		const wiki  = data.headerSources[0]?.inlineRanges.find((inlineRange) => inlineRange.kind === 'wikilink');
		// 隠すパスと区切り。ラベルは含まない
		const hide  = 'docs/要望_009\\|';
		// 隠す範囲の開始。見つからなければ -1
		const from  = data.headerSources[0]!.editableText.indexOf(hide);

		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('要望_009');
		expect(from).toBeGreaterThanOrEqual(0);
		expect(wiki?.markRanges).toEqual(expect.arrayContaining([{ from, to: from + hide.length }]));
	});

	it('テーブルセル内の br を AST に含める', () => {
		// 見出しセルに br。表示は改行。カーソルは先頭
		const state = createState('| a<br>b | c |\n| --- | --- |\n| 1 | 2 |', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		expect(data.headers[0]!.some((node) => node.kind === 'br')).toBe(true);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('a\nb');
	});

	it('表セルの編集値ではHTML改行タグだけを実改行へ変換する', () => {
		// 説明セルの HTML 改行。編集値では実改行になる
		const description = ['**外部公開されてはいけない機密性の高い内容**を置く場所', '・プライベートな内容（ログイン情報など含む）', '・顧客業務で使用する内容', '・Obsidianの機能の検証など'].join('<br>');
		// コードセルの br はリテラルのまま、外の br だけ改行
		const doc         = `| Vault名 | 説明 |\n| --- | --- |\n| TmObsidian01 | ${description} |\n| code | \`code<br>literal\`<br>次 |`;
		// カーソルは先頭
		const state       = createState(doc, 0);
		// 最初の Table。無ければ null
		const table       = findNode(state, 'Table');
		// 表示と編集値を分けた表データ
		const data        = extractTableData(state, table!);

		expect(data.rows[0]![1]!.some((node) => node.kind === 'br')).toBe(true);
		expect(data.rowSources[0]![1]!.text).toBe(description);
		expect(data.rowSources[0]![1]!.editableText).toBe(description.replaceAll('<br>', '\n'));
		expect(data.rowSources[1]![1]!.editableText).toBe('`code<br>literal`\n次');
	});

	it('表セル編集中もキャレット外のインライン記法をプレビュー表示できる範囲を保持する', () => {
		// コードとハイライトが br でつながる説明
		const description   = ['Cursor,Claude等AIに参照させる`abc`設計書や==各種==ドキュメントを置く場所', '（仮に外部に情報が漏れても影響のない性質の内容のみ置く）'].join('<br>');
		// その説明が 1 セルにある表
		const doc           = `| Vault名 | 説明 |\n| --- | --- |\n| PublicDocs | ${description} |`;
		// カーソルは先頭
		const state         = createState(doc, 0);
		// 最初の Table。無ければ null
		const table         = findNode(state, 'Table');
		// インライン範囲を取る表データ
		const data          = extractTableData(state, table!);
		// 説明セルのソース
		const source        = data.rowSources[0]![1]!;
		// インラインコードの範囲。無ければ undefined
		const code          = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'code');
		// ハイライトの範囲。無ければ undefined
		const highlight     = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'highlight');
		// `abc` の開始。見つからなければ -1
		const codeFrom      = source.editableText.indexOf('`abc`');
		// ==各種== の開始。見つからなければ -1
		const highlightFrom = source.editableText.indexOf('==各種==');

		expect(source.editableText).toBe(description.replace('<br>', '\n'));
		expect(code).toMatchObject({
			// `abc` の開始。編集テキスト上
			from: codeFrom,
			// 閉じバッククォートの直後
			to: codeFrom + '`abc`'.length,
			// 開きと閉じのバッククォート
			markRanges: [
				{
					// 開きの開始
					from: codeFrom,
					// 開きの直後
					to: codeFrom + 1
				},
				{
					// 閉じの開始
					from: codeFrom + 4,
					// 閉じの直後
					to: codeFrom + 5
				}
			]
		});
		expect(highlight).toMatchObject({
			// ==各種== の開始。編集テキスト上
			from: highlightFrom,
			// 閉じ == の直後
			to: highlightFrom + '==各種=='.length,
			// 開きと閉じの ==
			markRanges: [
				{
					// 開きの開始
					from: highlightFrom,
					// 開き == の直後
					to: highlightFrom + 2
				},
				{
					// 閉じの開始
					from: highlightFrom + 4,
					// 閉じ == の直後
					to: highlightFrom + 6
				}
			]
		});
		expect(getActiveTableCellInlineRangeIds(source.inlineRanges, 0)).toEqual([]);
		expect(getActiveTableCellInlineRangeIds(source.inlineRanges, codeFrom + 2)).toEqual([code!.id]);
		expect(getActiveTableCellInlineRangeIds(source.inlineRanges, highlightFrom + 3)).toEqual([highlight!.id]);
		expect(getTableCellEditableOffsetFromPreview(source.editableText, source.inlineRanges, codeFrom + 1)).toBe(codeFrom + 2);
		expect(getTableCellEditableOffsetFromPreview(source.editableText, source.inlineRanges, highlightFrom - 2 + 1)).toBe(highlightFrom + 3);
	});

	it('表セルの `{java}` インラインコードは言語接頭辞を markRanges に含める', () => {
		// 接頭辞の直後に空白が無い java。接頭辞も mark に入れる
		const doc      = '| col |\n| --- |\n| `{java}String a;` |';
		// カーソルは文書先頭。対象行はソース表示
		const state    = createState(doc, 0);
		// 最初の Table。無ければ null
		const table    = findNode(state, 'Table');
		// インライン範囲を取る表データ
		const data     = extractTableData(state, table!);
		// 先頭セルのソース。表示用テキストとは別に記法が残る
		const source   = data.rowSources[0]![0]!;
		// java のインラインコード。無ければ undefined
		const code     = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'code');
		// 記法全体の開始。見つからなければ -1
		const codeFrom = source.editableText.indexOf('`{java}String a;`');

		expect(code?.codeLanguage).toBe('java');
		expect(code?.markRanges).toEqual(
			expect.arrayContaining([
				{
					// 開きバッククォートの開始
					from: codeFrom,
					// 開きの直後
					to: codeFrom + 1
				},
				{
					// 言語接頭辞の開始。空白は含まない
					from: codeFrom + 1,
					// 接頭辞の直後
					to: codeFrom + 7
				},
				{
					// 閉じバッククォートの開始
					from: codeFrom + 16,
					// 閉じの直後
					to: codeFrom + 17
				}
			])
		);
	});

	it('表セルの `{java}` 直後の空白も markRanges に含める', () => {
		// 接頭辞の直後に空白が 2 つ。空白も mark に入れる
		const doc      = '| col |\n| --- |\n| `{java}  x` |';
		// カーソルは文書先頭。対象行はソース表示
		const state    = createState(doc, 0);
		// 最初の Table。無ければ null
		const table    = findNode(state, 'Table');
		// インライン範囲を取る表データ
		const data     = extractTableData(state, table!);
		// 先頭セルのソース。表示用テキストとは別に記法が残る
		const source   = data.rowSources[0]![0]!;
		// 空白付き java のインラインコード。無ければ undefined
		const code     = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'code');
		// 記法全体の開始。見つからなければ -1
		const codeFrom = source.editableText.indexOf('`{java}  x`');

		expect(code?.codeLanguage).toBe('java');
		expect(code?.markRanges).toEqual(
			expect.arrayContaining([
				{
					// 開きバッククォートの開始
					from: codeFrom,
					// 開きの直後
					to: codeFrom + 1
				},
				{
					// 言語接頭辞と直後の空白の開始
					from: codeFrom + 1,
					// 空白の直後
					to: codeFrom + 9
				},
				{
					// 閉じバッククォートの開始
					from: codeFrom + 10,
					// 閉じの直後
					to: codeFrom + 11
				}
			])
		);
	});

	it('プレビュー時にテーブル replace を生成する', () => {
		// 表の後ろに after。カーソルは表の外
		const doc        = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter';
		// カーソルは末尾の手前。表はプレビュー
		const state      = createState(doc, doc.length - 1);
		// ブロック装飾。表や HTML 表の widget を含む
		const entries    = collectBlockDecorationEntries(state);
		// 表 widget の装飾。無ければ未生成
		const tableEntry = entries.find((entry) => entry.decoration.spec.widget instanceof TableWidget);
		expect(tableEntry).toBeDefined();
		expect(tableEntry!.from).toBe(0);
	});

	it('カーソルがテーブル内にあっても編集可能な表 replace を維持する', () => {
		// カーソルを表の中へ置く。replace は残す
		const doc        = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter';
		// カーソルは 2 文字目。表の中
		const state      = createState(doc, 2);
		// ブロック装飾。表や HTML 表の widget を含む
		const entries    = collectBlockDecorationEntries(state);
		// 表 widget の装飾。カーソルが中でも残る
		const tableEntry = entries.find((entry) => entry.decoration.spec.widget instanceof TableWidget);
		expect(tableEntry).toBeDefined();
	});

	it('セル編集確定時は align / valign を付け直す', () => {
		// 右・中央の 100。確定後も配置を付け直す
		const doc    = '|   |\n| --- |\n| 100{align=right valign=middle} |';
		// カーソルは文書先頭。対象行はソース表示
		const state  = createState(doc, 0);
		// 最初の Table。無ければ null
		const table  = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data   = extractTableData(state, table!);
		// 100 を 200 に置換し、配置は残す変更
		const change = buildTableCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 先頭列。0 始まり
				column: 0
			},
			'200'
		);

		expect(change?.insert).toBe('200{align=right valign=middle}');
	});

	it('セル確定は文書上の結合を残し、無いときは付けない', () => {
		// 3 列結合がある文書。確定しても結合は残す
		const mergedState = createState('|   |   |   |\n|---|---|---|\n|A{colspan=3}|  |  |', 0);
		// その表データ
		const merged      = extractTableData(mergedState, findNode(mergedState, 'Table')!);
		expect(
			buildTableCellChange(
				merged,
				{
					// 結合のある先頭データ行
					row: 1,
					// 先頭列。0 始まり
					column: 0
				},
				'A'
			)?.insert
		).toBe('A{colspan=3}');
		// 結合の無い同じ見た目。確定で結合は付かない
		const plainState = createState('|   |   |   |\n|---|---|---|\n|A|  |  |', 0);
		// その表データ
		const plain      = extractTableData(plainState, findNode(plainState, 'Table')!);
		expect(
			buildTableCellChange(
				plain,
				{
					// 結合の無い先頭データ行
					row: 1,
					// 先頭列。0 始まり
					column: 0
				},
				'A'
			)?.insert
		).toBe('A');
	});

	it('セル編集変更は対象セルだけを置換し、Undo可能な単一変更になる', () => {
		// aa だけを aZa に置換する表
		const doc    = '| 見出し１ | 見出し２ |\n| --- | --- |\n| aa | bbb |';
		// カーソルは文書先頭。対象行はソース表示
		const state  = createState(doc, 0);
		// 最初の Table。無ければ null
		const table  = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data   = extractTableData(state, table!);
		// 先頭データセルだけを aZa にする変更
		const change = buildTableCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 先頭列。aa だけを置換する
				column: 0
			},
			'aZa'
		);

		expect(change).not.toBeNull();
		expect(state.update({ changes: change! }).state.doc.toString()).toBe('| 見出し１ | 見出し２ |\n| --- | --- |\n| aZa | bbb |');
	});

	it('表セル入力は改行と未エスケープのパイプを安全な Markdown にする', () => {
		expect(normalizeTableCellSource('日本語|値\n次')).toBe('日本語\\|値<br>次');
		expect(normalizeTableCellSource('既存\\|値')).toBe('既存\\|値');
		expect(getNormalizedTableCellCaretOffset('a|b', 2)).toBe(3);
		expect(getNormalizedTableCellCaretOffset('a\nb', 2)).toBe(5);
		expect(getTableCellEditableCaretOffset('a|b', 2)).toBe(3);
		expect(getTableCellEditableCaretOffset('a\nb', 2)).toBe(2);
		expect(getTableCellEditableCaretOffset('`a<br>b`', 8)).toBe(8);
	});

	it('末尾の br は編集用改行になり、列は割れない', () => {
		// 2 列目の末尾 br。列は割れず編集用改行になる
		const state = createState('| h1 | h2 | h3 |\n| --- | --- | --- |\n|データ２－１|データ２－２<br>|b|\n');
		// 最初の表。表示とソースを分ける
		const data  = extractTableData(state, findNode(state, 'Table')!);
		expect(data.rowSources[0]).toHaveLength(3);
		expect(data.rowSources[0]![1]!.text).toBe('データ２－２<br>');
		expect(data.rowSources[0]![1]!.editableText).toBe('データ２－２\n');
		expect(data.rowSources[0]![2]!.text).toBe('b');
		expect(data.rows[0]![1]!.some((node) => node.kind === 'br')).toBe(true);
	});

	it('連続した Shift+Enter は空行を1つずつソースへ残す', () => {
		expect(insertLineBreakAtOffset('あああ\nああ', 6)).toBe('あああ\nああ\n');
		expect(insertLineBreakAtOffset('あああ\nああ\n', 7)).toBe('あああ\nああ\n\n');
		expect(normalizeTableCellSource('あああ\nああ\n')).toBe('あああ<br>ああ<br>');
		expect(normalizeTableCellSource('あああ\nああ\n\n')).toBe('あああ<br>ああ<br><br>');
		expect(normalizeTableCellSource('あああ\nああ\n\n\n')).toBe('あああ<br>ああ<br><br><br>');
	});

	it('セル改行の連続書き戻しは次セルを壊さない', () => {
		// 2 列目へ改行を 1 つずつ足す表
		const doc   = '| h1 | h2 | h3 |\n| --- | --- | --- |\n|データ２－１|データ２－２|b|\n';
		// 書き戻しのたびに更新する文書
		let state   = createState(doc);
		// 最初の表。表示とソースを分ける
		const data  = extractTableData(state, findNode(state, 'Table')!);
		// 末尾に改行を 1 つ足す変更
		const first = buildTableCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 改行を足す 2 列目。0 始まり
				column: 1
			},
			`データ２－２\n`
		);
		expect(first?.insert).toBe('データ２－２<br>');
		expect(first?.insert.includes('\n')).toBe(false);
		// 1 つ目の改行を文書へ反映する
		state = state.update({ changes: first! }).state;
		syncTableDataAfterCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 改行を足した 2 列目
				column: 1
			},
			first!.insert,
			'データ２－２\n'
		);
		// 2 行目の末尾にも改行を足す変更
		const second = buildTableCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 2 行目の末尾へ改行を足す列
				column: 1
			},
			'データ２－２\nあああ\n'
		);
		expect(second?.insert).toBe('データ２－２<br>あああ<br>');
		// 2 つ目の改行を文書へ反映する
		state = state.update({ changes: second! }).state;
		expect(state.doc.toString()).toBe('| h1 | h2 | h3 |\n| --- | --- | --- |\n|データ２－１|データ２－２<br>あああ<br>|b|\n');
		expect(state.doc.toString()).not.toContain('br>>');
		expect(state.doc.toString()).not.toMatch(/br><br>br>/);
		syncTableDataAfterCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 2 つ目の改行を反映した列
				column: 1
			},
			second!.insert,
			'データ２－２\nあああ\n'
		);
		// 空行を 1 つ足す変更。次セルは壊れない
		const third = buildTableCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 空行を足す列。次セルは壊さない
				column: 1
			},
			'データ２－２\nあああ\n\n'
		);
		expect(third?.insert).toBe('データ２－２<br>あああ<br><br>');
		// 空行を文書へ反映する
		state = state.update({ changes: third! }).state;
		expect(state.doc.toString()).toBe('| h1 | h2 | h3 |\n| --- | --- | --- |\n|データ２－１|データ２－２<br>あああ<br><br>|b|\n');
		expect(state.doc.toString()).not.toContain('br>>');
	});

	it('編集用 DOM のゼロ幅文字はソースへ残さない', () => {
		expect(normalizeEditableCellDomText(`データ２－２\n${TABLE_CELL_BREAK_CARET}`)).toBe('データ２－２\n');
		expect(normalizeTableCellSource(`データ２－２\n${TABLE_CELL_BREAK_CARET}`)).toBe('データ２－２<br>');
	});

	it('Shift+Enterだけを表セル内改行として扱う', () => {
		expect(
			isTableCellSoftBreakKey({
				// Ctrl は押していない
				ctrlKey: false,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift だけが押されている
				shiftKey: true,
				// セル内改行にするキー
				key: 'Enter'
			})
		).toBe(true);
		expect(
			isTableCellSoftBreakKey({
				// Ctrl は押していない
				ctrlKey: false,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift が無い Enter は改行にしない
				shiftKey: false,
				// 修飾なしの Enter
				key: 'Enter'
			})
		).toBe(false);
		expect(
			isTableCellSoftBreakKey({
				// Ctrl が付くとセル内改行にしない
				ctrlKey: true,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift は押している
				shiftKey: true,
				// Ctrl 付きの Enter
				key: 'Enter'
			})
		).toBe(false);
	});

	it('表セル内の Ctrl+A と Cmd+A だけをセル全選択として扱う', () => {
		expect(
			isTableCellSelectAllKey({
				// Ctrl+A
				ctrlKey: true,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// 小文字の a
				key: 'a'
			})
		).toBe(true);
		expect(
			isTableCellSelectAllKey({
				// Ctrl は押していない
				ctrlKey: false,
				// Cmd+A
				metaKey: true,
				// Alt は押していない
				altKey: false,
				// 大文字の A
				key: 'A'
			})
		).toBe(true);
		expect(
			isTableCellSelectAllKey({
				// Ctrl は押している
				ctrlKey: true,
				// Meta は押していない
				metaKey: false,
				// Alt が付くと全選択にしない
				altKey: true,
				// 小文字の a
				key: 'a'
			})
		).toBe(false);
		expect(
			isTableCellSelectAllKey({
				// Ctrl は押している
				ctrlKey: true,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// a 以外は全選択にしない
				key: 'z'
			})
		).toBe(false);
	});

	it('修飾なしの Escape だけを表編集の終了として扱う', () => {
		expect(
			isTableEditExitKey({
				// 修飾なしの Escape
				key: 'Escape',
				// Ctrl は押していない
				ctrlKey: false,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift は押していない
				shiftKey: false,
				// 文字変換中ではない
				isComposing: false
			})
		).toBe(true);
		expect(
			isTableEditExitKey({
				// Escape 以外は編集を閉じない
				key: 'Enter',
				// Ctrl は押していない
				ctrlKey: false,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift は押していない
				shiftKey: false,
				// 文字変換中ではない
				isComposing: false
			})
		).toBe(false);
		expect(
			isTableEditExitKey({
				// Escape
				key: 'Escape',
				// Ctrl 付きは表編集を閉じない
				ctrlKey: true,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift は押していない
				shiftKey: false,
				// 文字変換中ではない
				isComposing: false
			})
		).toBe(false);
		expect(
			isTableEditExitKey({
				// Escape
				key: 'Escape',
				// Ctrl は押していない
				ctrlKey: false,
				// Meta は押していない
				metaKey: false,
				// Alt は押していない
				altKey: false,
				// Shift は押していない
				shiftKey: false,
				// 変換中の Escape は変換のキャンセル
				isComposing: true
			})
		).toBe(false);
	});

	it('表セルの上下キーだけを同一列の縦移動として扱う', () => {
		/**
		 * 修飾キーなしのキーイベント相当値を作る
		 * @param value - キー名
		 * @returns キーイベント相当値
		 */
		const key = (value: string) => ({
			// Ctrl は押していない
			ctrlKey: false,
			// Meta は押していない
			metaKey: false,
			// Alt は押していない
			altKey: false,
			// Shift は押していない
			shiftKey: false,
			// 渡されたキー名
			key: value
		});
		expect(getTableCellVerticalArrowDirection(key('ArrowUp'))).toBe('up');
		expect(getTableCellVerticalArrowDirection(key('ArrowDown'))).toBe('down');
		expect(getTableCellVerticalArrowDirection(key('ArrowLeft'))).toBeNull();
		expect(getTableCellVerticalArrowDirection(key('ArrowRight'))).toBeNull();
		expect(
			getTableCellVerticalArrowDirection({
				// 修飾なしの上キーを引き継ぐ
				...key('ArrowUp'),
				// Shift 付きは縦移動にしない
				shiftKey: true
			})
		).toBeNull();
	});

	it('セル内改行では上下キーを同じ桁の前後行へ移す', () => {
		// 3 行。7 文字目は 2 行目の 3 桁目
		const text = 'あああ\nいいい\nううう';
		expect(getTableCellLineCaretPosition(text, 7)).toEqual({
			// 2 行目。0 始まり
			line: 1,
			// その行の 3 桁目。0 始まり
			column: 3,
			// 改行で分かれた行数
			lineCount: 3
		});
		expect(getTableCellVerticalCaretOffset(text, 7, 'up')).toBe(3);
		expect(getTableCellVerticalCaretOffset(text, 7, 'down')).toBe(11);
		expect(getTableCellVerticalCaretOffset(text, 3, 'up')).toBeNull();
		expect(getTableCellVerticalCaretOffset(text, 11, 'down')).toBeNull();
		expect(getTableCellVerticalCaretOffset('単一行', 2, 'down')).toBeNull();
		expect(getTableCellVerticalCaretOffset('短い\nあああ', 6, 'up')).toBe(2);
	});

	it('末尾空行の上下キーは同列移動し、上下端では表外の隣接行へ出る', () => {
		// 表の上下に above と below。末尾空行から表の外へ出る
		const doc   = 'above\n| h1 | h2 | h3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n| | | |\n\nbelow';
		// カーソルは文書先頭。対象行はソース表示
		const state = createState(doc, 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 修飾なしの下キー。末尾空行では表の外へ出る
		const key   = {
			// Ctrl は押していない
			ctrlKey: false,
			// Meta は押していない
			metaKey: false,
			// Alt は押していない
			altKey: false,
			// Shift は押していない
			shiftKey: false,
			// 下方向
			key: 'ArrowDown'
		};

		expect(
			getTableCellVerticalNavigation(
				data,
				{
					// 末尾の空行
					row: 3,
					// 先頭列。0 始まり
					column: 0
				},
				key
			)
		).toEqual({
			// 下へ出る
			direction: 'down',
			// 表の外。セルは無い
			target: null
		});
		expect(
			getTableCellVerticalNavigation(
				data,
				{
					// 末尾の空行
					row: 3,
					// 2 列目。0 始まり
					column: 1
				},
				{
					// 修飾なしのキーを引き継ぐ
					...key,
					// 上方向へ上書きする
					key: 'ArrowUp'
				}
			)
		).toEqual({
			// 上の行へ移る
			direction: 'up',
			// 同じ列の直前行
			target: {
				// 空行の 1 つ上
				row: 2,
				// 2 列目。0 始まり
				column: 1
			}
		});
		expect(
			getTableCellVerticalNavigation(
				data,
				{
					// 末尾の空行
					row: 3,
					// 2 列目。0 始まり
					column: 1
				},
				{
					// 修飾なしのキーを引き継ぐ
					...key,
					// 左右は縦移動にしない
					key: 'ArrowRight'
				}
			)
		).toBeNull();
		expect(
			getTableCellVerticalNavigation(
				data,
				{
					// 見出し行
					row: 0,
					// 先頭列。0 始まり
					column: 0
				},
				{
					// 修飾なしのキーを引き継ぐ
					...key,
					// 上方向へ上書きする
					key: 'ArrowUp'
				}
			)
		).toEqual({
			// 表の上へ出る
			direction: 'up',
			// 上端なのでセルは無い
			target: null
		});
		expect(getTableVerticalExitPosition(state, data.tableFrom, data.tableTo, false)).toBe(state.doc.line(1).from);
		expect(getTableVerticalExitPosition(state, data.tableFrom, data.tableTo, true)).toBe(state.doc.line(7).from);
	});

	it('改行セルの上下端は結合セルの原点へ移る', () => {
		// 結合セルの間に改行セル。上下端は結合の原点へ移る
		const doc   = ['見出し１{colwidths=111,97,32 rowheights=32,263}|||', '|---|---|---|', '|データ１－１{colspan=3}||', '|データ２－１|あああ<br>いいい|', '|データ３－１{colspan=3}||'].join('\n');
		// カーソルは文書先頭。対象行はソース表示
		const state = createState(doc, 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		// 修飾なしの上キー。結合セルの原点へ移る
		const key   = {
			// Ctrl は押していない
			ctrlKey: false,
			// Meta は押していない
			metaKey: false,
			// Alt は押していない
			altKey: false,
			// Shift は押していない
			shiftKey: false,
			// 上方向
			key: 'ArrowUp'
		};

		expect(
			getTableCellVerticalNavigation(
				data,
				{
					// 改行セルのある行
					row: 2,
					// 改行セルの列。0 始まり
					column: 1
				},
				key
			)
		).toEqual({
			// 上の結合セルへ移る
			direction: 'up',
			// 結合の原点
			target: {
				// 上の結合行
				row: 1,
				// 結合の先頭列
				column: 0
			}
		});
		expect(
			getTableCellVerticalNavigation(
				data,
				{
					// 改行セルのある行
					row: 2,
					// 改行セルの列。0 始まり
					column: 1
				},
				{
					// 修飾なしのキーを引き継ぐ
					...key,
					// 下方向へ上書きする
					key: 'ArrowDown'
				}
			)
		).toEqual({
			// 下の結合セルへ移る
			direction: 'down',
			// 結合の原点
			target: {
				// 下の結合行
				row: 3,
				// 結合の先頭列
				column: 0
			}
		});
	});

	it('エスケープ済みパイプをセル境界として扱わない', () => {
		// エスケープ済みパイプはセル境界にしない。カーソルは先頭
		const state = createState('| a \\| b | c |\n| --- | --- |\n| `x\\|y` | z |', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);

		expect(data.headerSources).toHaveLength(2);
		expect(data.headerSources[0]?.text).toBe('a \\| b');
		expect(data.rowSources[0]).toHaveLength(2);
	});

	it('Tab・Enter・上下キーの移動先、および最終セルでの空行追加を構築する', () => {
		// 2×2。最終セルの次は空行を足す
		const doc   = '| a | b |\n| --- | --- |\n| 1 | 2 |';
		// カーソルは文書先頭。対象行はソース表示
		const state = createState(doc, 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);

		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 見出し行
					row: 0,
					// 先頭列。0 始まり
					column: 0
				},
				'next'
			)
		).toEqual({
			// 同じ見出し行
			row: 0,
			// 右隣
			column: 1
		});
		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 先頭データ行
					row: 1,
					// 先頭列。0 始まり
					column: 0
				},
				'previous'
			)
		).toEqual({
			// 見出し行へ戻る
			row: 0,
			// 見出しの末列
			column: 1
		});
		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 見出し行
					row: 0,
					// 末列。0 始まり
					column: 1
				},
				'down'
			)
		).toEqual({
			// 真下のデータ行
			row: 1,
			// 同じ列
			column: 1
		});
		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 先頭データ行
					row: 1,
					// 末列。0 始まり
					column: 1
				},
				'up'
			)
		).toEqual({
			// 真上の見出し
			row: 0,
			// 同じ列
			column: 1
		});
		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 見出し行。上は無い
					row: 0,
					// 末列。0 始まり
					column: 1
				},
				'up'
			)
		).toBeNull();
		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 最終データ行。下は無い
					row: 1,
					// 末列。0 始まり
					column: 1
				},
				'down'
			)
		).toBeNull();
		expect(
			getAdjacentTableCellPosition(
				data,
				{
					// 最終データ行。次は空行追加
					row: 1,
					// 末列。0 始まり
					column: 1
				},
				'next'
			)
		).toBeNull();

		// 表の末尾へ空行を足す変更
		const change = buildAppendTableRowChange(state, data);
		expect(change).not.toBeNull();
		expect(state.update({ changes: change! }).state.doc.toString()).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |');
	});

	it('テーブル外からの上下移動は移動方向側の第1列セルへ入る', () => {
		// 表の上は above、下は below。入る側の第 1 列へ移る
		const doc   = ['above', '| h1 | h2 |', '| --- | --- |', '| a | b |', '| c | d |', '', 'below'].join('\n');
		// カーソルは文書先頭。対象行はソース表示
		const state = createState(doc, 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);

		// above 行の末尾。ここから下へ入る
		const fromAbove  = state.doc.line(1).to;
		// 見出し行の先頭。入口の位置
		const intoHeader = state.doc.line(2).from;
		expect(getTableVerticalEntryTarget(state, fromAbove, intoHeader, true)).toEqual({
			// 入る表の開始
			tableFrom: data.tableFrom,
			// 下方向の入口は見出しの先頭列
			position: {
				// 見出し行
				row: 0,
				// 先頭列。0 始まり
				column: 0
			},
			// そのセルのソース開始
			sourceFrom: data.headerSources[0]!.from
		});

		// 空行の先頭。ここから上へ入る
		const fromBelow   = state.doc.line(6).from;
		// 最終データ行の末尾。入口の位置
		const intoLastRow = state.doc.line(5).to;
		expect(getTableVerticalEntryTarget(state, fromBelow, intoLastRow, false)).toEqual({
			// 入る表の開始
			tableFrom: data.tableFrom,
			// 上方向の入口は最終行の先頭列
			position: {
				// 最終データ行
				row: 2,
				// 先頭列。0 始まり
				column: 0
			},
			// そのセルのソース開始
			sourceFrom: data.rowSources[1]![0]!.from
		});

		expect(getTableVerticalEntryTarget(state, data.headerSources[0]!.from, data.rowSources[0]![0]!.from, true)).toBeNull();
	});

	it('セル編集は履歴から1回でUndoできる', () => {
		// aa を aZa にしたあと、履歴から 1 回で戻す
		const doc    = '| a | b |\n| --- | --- |\n| aa | bb |';
		// 履歴付きの文書。編集前
		let state    = EditorState.create({
			// 編集前の表
			doc,
			// Markdown と履歴。Undo を 1 回で戻す
			extensions: [createTmsMarkdownSupport(), history()]
		});
		// 最初の Table。無ければ null
		const table  = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data   = extractTableData(state, table!);
		// 先頭データセルだけを aZa にする変更
		const change = buildTableCellChange(
			data,
			{
				// 先頭データ行
				row: 1,
				// 先頭列。aa を aZa にする
				column: 0
			},
			'aZa'
		);
		// 入力として履歴へ積む
		state        = state.update({
			// セル置換
			changes: change!,
			// 入力として履歴へ残す
			userEvent: 'input.type'
		}).state;

		// undo が dispatch する対象
		const commandTarget = {
			// 編集後の状態
			state,
			/**
			 *
			 */
			dispatch(transaction: import('@codemirror/state').Transaction) {
				// Undo 後の文書へ置き換える
				state = transaction.state;
			}
		} as unknown as import('@codemirror/view').EditorView;

		expect(undo(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe(doc);
	});

	it('連続したセル入力は1回のUndoで編集前へ戻る', () => {
		// aa を aZ、続けて aZa にしたあと、履歴から 1 回で戻す
		const doc   = '| a | b |\n| --- | --- |\n| aa | bb |';
		// 履歴付きの文書。編集前
		let state   = EditorState.create({
			// 編集前の表
			doc,
			// Markdown と履歴。連続入力を 1 回で戻す
			extensions: [createTmsMarkdownSupport(), history()]
		});
		// セル文字列を先頭データセルへ書く
		/**
		 *
		 */
		const apply = (text: string): void => {
			// 最初の Table。無ければ null
			const table  = findNode(state, 'Table');
			// 表示ノードと、記法を残したソース
			const data   = extractTableData(state, table!);
			// 先頭データセルを text にする変更
			const change = buildTableCellChange(
				data,
				{
					// 先頭データ行
					row: 1,
					// 先頭列
					column: 0
				},
				text
			);
			// 入力として履歴へ積む
			state        = state.update({
				// セル置換
				changes: change!,
				// 入力として履歴へ残す
				userEvent: 'input.type'
			}).state;
		};

		apply('aZ');
		apply('aZa');

		// undo が dispatch する対象
		const commandTarget = {
			// 編集後の状態
			state,
			/**
			 *
			 */
			dispatch(transaction: import('@codemirror/state').Transaction) {
				// Undo 後の文書へ置き換える
				state = transaction.state;
			}
		} as unknown as import('@codemirror/view').EditorView;

		expect(undo(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe(doc);
	});

	it('履歴コマンドのあいだはセルの書き戻しを止める', async () => {
		// dataset だけを持つセル
		const cell = { dataset: {} } as HTMLElement;
		// コマンド実行中に見えたフラグ
		let during = '';
		runTableCellDocumentHistory(
			{
				/**
				 *
				 */
				focus() {
					return;
				},
				// 操作前の文書。このテストでは履歴は動かさない
				state: {
					// 空の文書
					doc: {
						/**
						 *
						 */
						toString() {
							return '';
						}
					}
				}
			} as unknown as import('@codemirror/view').EditorView,
			cell,
			0,
			{
				// 先頭データ行
				row: 1,
				// 先頭列
				column: 0
			},
			() => {
				during = cell.dataset.skipHistoryPersist ?? '';
				return false;
			}
		);
		expect(during).toBe('true');
		// 取り消し直後の br を書き戻さないよう、フラグは関数を抜けた直後も残る
		expect(cell.dataset.skipHistoryPersist).toBe('true');
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				resolve();
			}, 0);
		});
		expect(cell.dataset.skipHistoryPersist).toBe('false');
	});

	it('編集中セルは文書と違うときだけ表示を戻す', () => {
		// 入力直後は文書と DOM が同じ。キャレットを崩さない
		expect(shouldRefreshEditingTableCell('a', 'a')).toBe(false);
		// 取り消しで文書だけ戻ったとき、表示を文書へ合わせる
		expect(shouldRefreshEditingTableCell('a', '')).toBe(true);
		// セルが無く変更を作れないときは、表示を触らない
		expect(shouldRefreshEditingTableCell(null, 'a')).toBe(false);
	});

	it('取り消しで変わった文字のセルへ戻る', () => {
		// B1 は 14 から 17、B2 は 30 から 33
		const cells     = [
			{
				// 1 行目
				row: 1,
				// B 列
				column: 1,
				// aaa の開始
				from: 14,
				// aaa の終端
				to: 17
			},
			{
				// 2 行目
				row: 2,
				// B 列
				column: 1,
				// bbb の開始
				from: 30,
				// bbb の終端
				to: 33
			}
		];
		// B1 の aaa を消した位置は、B1
		const aaaPrefix = 'x'.repeat(14);
		const aaaSuffix = `${'y'.repeat(13)}bbb`;
		expect(tableCellPositionForTextChange(`${aaaPrefix}aaa${aaaSuffix}`, `${aaaPrefix}${aaaSuffix}`, cells)).toEqual({
			// 1 行目
			row: 1,
			// B 列
			column: 1
		});
		// B2 の bbb を消した位置は、B2
		const bbbPrefix = 'x'.repeat(30);
		expect(tableCellPositionForTextChange(`${bbbPrefix}bbb`, bbbPrefix, cells)).toEqual({
			// 2 行目
			row: 2,
			// B 列
			column: 1
		});
		// 空セルへ入れた文字を戻す位置は、幅の無いそのセル
		expect(
			tableCellPositionForTextChange('x'.repeat(14), `${'x'.repeat(14)}a`, [
				{
					// 1 行目
					row: 1,
					// B 列
					column: 1,
					// 空セルの位置
					from: 14,
					// 空セルは終端も同じ
					to: 14
				}
			])
		).toEqual({
			// 1 行目
			row: 1,
			// B 列
			column: 1
		});
	});

	it('取り消した隣セルだけプレビューを文書へ戻す', () => {
		// 編集中でないセルは、文書の文字が消えたとき表示を戻す
		expect(shouldRefreshPreviewTableCell(false, 'aaa', '')).toBe(true);
		// 編集中セルは、入力 DOM を維持する
		expect(shouldRefreshPreviewTableCell(true, 'bbb', '')).toBe(false);
		// 文書と表示が同じセルは、埋め直さない
		expect(shouldRefreshPreviewTableCell(false, 'aaa', 'aaa')).toBe(false);
	});

	it('文字に挟まれた br だけをセルの改行として残す', () => {
		// <br><br> は、クリアしたセルにブラウザが足す行高。ソースへ残さない
		expect(tableCellSourceBreakIndexes(['break', 'break'])).toEqual([]);
		// 文字の前だけの br は、空セルへ入力したときに残るプレースホルダ
		expect(tableCellSourceBreakIndexes(['break', 'text'])).toEqual([]);
		// 文字の後ろだけの br は、行末のプレースホルダ
		expect(tableCellSourceBreakIndexes(['text', 'break'])).toEqual([]);
		// 文字に挟まれた br は、セル内改行
		expect(tableCellSourceBreakIndexes(['text', 'break', 'text'])).toEqual([1]);
		// 連続 br は1改行。2本目は行高のための br
		expect(tableCellSourceBreakIndexes(['text', 'break', 'break', 'text'])).toEqual([1]);
		// 改行だけのテキストが前後にあっても、挟まれた br は改行
		expect(tableCellSourceBreakIndexes(['text', 'gap', 'break', 'gap', 'text'])).toEqual([2]);
	});

	it('空セルだけ行の高さを残す', () => {
		// 文字も改行も無いセルは、行高が潰れる
		expect(tableCellNeedsHeightBreak([])).toBe(true);
		// 空白だけのセルも空と同じ
		expect(tableCellNeedsHeightBreak([{ kind: 'text', text: ' ' }])).toBe(true);
		// 文字があるセルは、その文字が行の高さを作る
		expect(tableCellNeedsHeightBreak([{ kind: 'text', text: 'a' }])).toBe(false);
		// 改行があるセルは、改行が行の高さを作る
		expect(tableCellNeedsHeightBreak([{ kind: 'br' }])).toBe(false);
	});

	it('表の外からの取り消しではキャレットを表へ戻さない', () => {
		// 表の外で、本文が変わった取り消し。キャレットを維持する
		expect(shouldKeepSelectionOutsideTable(false, true, false, true)).toBe(true);
		// セル内の取り消しでは、編集中のキャレットを動かさない
		expect(shouldKeepSelectionOutsideTable(true, true, false, true)).toBe(false);
		// もともと表の中にいたキャレットは、表の外へ追い出さない
		expect(shouldKeepSelectionOutsideTable(false, true, true, true)).toBe(false);
		// 本文が変わらない更新では、選択を置き換えない
		expect(shouldKeepSelectionOutsideTable(false, false, false, true)).toBe(false);
		// 取り消し以外では、キャレットを維持しない
		expect(shouldKeepSelectionOutsideTable(false, true, false, false)).toBe(false);
	});

	it('Image から alt と URL を抽出する', () => {
		// alt と URL を持つ画像
		const state = createState('![説明](./img.png)');
		// Image ノード。無ければ null
		const image = findNode(state, 'Image');
		expect(image).not.toBeNull();
		expect(extractImageAltAndUrl(state, image!)).toEqual({
			// 代替テキスト
			alt: '説明',
			// 画像の URL
			url: './img.png'
		});
	});

	it('![[embed.png]] を WikiEmbed としてパースする', () => {
		// 幅の無い埋め込み。Image にはならない
		const state           = createState('![[embed.png]]');
		// 出現したノード名。空ならまだ走査していない
		const names: string[] = [];
		syntaxTree(state).iterate({
			/**
			 * @param node - ノード
			 */
			enter(node) {
				names.push(node.name);
			}
		});
		expect(names).toContain('WikiEmbed');
		expect(names).toContain('WikiEmbedPath');
		expect(names).not.toContain('Image');

		// 埋め込みノード。無ければ null
		const embed = findNode(state, 'WikiEmbed');
		expect(embed).not.toBeNull();
		expect(extractWikiEmbedPath(state, embed!)).toBe('embed.png');
	});

	it('幅付き WikiEmbed のパスからサイズを除いて widget を作る', () => {
		// 幅 478 付き。widget の範囲はサイズを含む
		const doc     = '先頭\n![[_添付ファイル/a.png|478]]';
		// カーソルは先頭。画像はプレビュー
		const state   = createState(doc, 0);
		// ブロック装飾。表や HTML 表の widget を含む
		const entries = collectBlockDecorationEntries(state);
		expect(entries).toHaveLength(1);
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).toBe('![[_添付ファイル/a.png|478]]');
	});

	it('プレビュー時に画像 replace を生成する', () => {
		// 前後に文字がある画像。replace の幅は 0 より大きい
		const doc     = 'before\n![a](https://example.com/x.png)\nafter';
		// カーソルは先頭。画像はプレビュー
		const state   = createState(doc, 0);
		// ブロック装飾。表や HTML 表の widget を含む
		const entries = collectBlockDecorationEntries(state);
		expect(entries.some((entry) => entry.to > entry.from)).toBe(true);
	});

	it('テーブルセル内の許可 HTML を AST に含める', () => {
		// 見出しに許可タグ u。AST の html になる。カーソルは先頭
		const state = createState('| a <u>x</u> | b |\n| --- | --- |\n| 1 | 2 |', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		expect(data.headers[0]!.some((node) => node.kind === 'html' && node.tagName === 'u')).toBe(true);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('a x');
	});

	it('テーブルセル内の非許可 HTML はテキストとして残す', () => {
		// 見出しに script。html ノードにはせず文字のまま。カーソルは先頭
		const state = createState('| a <script>x</script> | b |\n| --- | --- |\n| 1 | 2 |', 0);
		// 最初の Table。無ければ null
		const table = findNode(state, 'Table');
		// 表示ノードと、記法を残したソース
		const data  = extractTableData(state, table!);
		expect(data.headers[0]!.some((node) => node.kind === 'html')).toBe(false);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toContain('<script>');
	});

	it('本文の <br> を改行 Decoration にする（インラインコード内は対象外）', () => {
		// 本文の br だけ装飾する。コード内の br は対象外
		const doc     = 'hello<br>world and `code<br>here`\n\ncursor';
		// カーソルは末尾の手前。本文の br はプレビュー
		const state   = createState(doc, doc.length - 1);
		// br の装飾。コード内は含まない
		const entries = collectHtmlDecorationEntries(state);
		expect(entries).toHaveLength(1);
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).toBe('<br>');
		// 互換 export
		expect(collectHtmlBreakDecorationEntries(state)).toHaveLength(1);
	});

	it('HTMLは同じ行のカーソル外ではプレビュー、内部ではソース表示にする', () => {
		// 同じ行の u。カーソルが外ならプレビュー、中ならソース
		const doc          = '前 <u>下線</u> 後';
		// カーソルは先頭。タグはプレビュー
		const previewState = createState(doc, 0);
		// カーソルは下線の中。タグはソースのまま
		const sourceState  = createState(doc, doc.indexOf('下線') + 1);

		expect(collectHtmlDecorationEntries(previewState)).toHaveLength(3);
		expect(collectHtmlDecorationEntries(sourceState)).toHaveLength(0);
	});
});
