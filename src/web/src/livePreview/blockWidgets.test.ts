import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import {
	collectBlockDecorationEntries,
	extractImageAltAndUrl,
	extractWikiEmbedPath,
} from './blockWidgets';
import { createDocumentContextExtensions } from './documentContext';
import { classifyImageSource } from './imageWidget';
import {
	buildAppendTableRowChange,
	buildTableCellChange,
	TableWidget,
	extractTableData,
	getActiveTableCellInlineRangeIds,
	getAdjacentTableCellPosition,
	getNormalizedTableCellCaretOffset,
	getTableCellEditableOffsetFromPreview,
	getTableCellEditableCaretOffset,
	getTableCellVerticalArrowDirection,
	getTableCellVerticalNavigation,
	getTableVerticalExitPosition,
	getTableVerticalEntryTarget,
	isTableCellSoftBreakKey,
	isTableCellSelectAllKey,
	isBreakHtmlTag,
	normalizeTableCellSource,
	tableCellNodesToPlainText,
} from './tableWidget';
import { collectHtmlDecorationEntries } from './htmlInline';
import { collectHtmlBreakDecorationEntries } from './htmlBreak';

/**
 * @param {string} doc ドキュメント
 * @param {number} [cursor] カーソル位置
 * @returns {EditorState}
 */
function createState(doc: string, cursor: number = 0): EditorState {
	return EditorState.create({
		doc,
		selection  : EditorSelection.cursor(cursor),
		extensions : [
			createTmsMarkdownSupport(),
			...createDocumentContextExtensions({
				filePath         : 'E:\\vault\\note.md',
				loadRemoteImages : true,
			}),
		],
	});
}

/**
 * @param {EditorState} state 状態
 * @param {string} name ノード名
 * @returns {import('@lezer/common').SyntaxNode | null}
 */
function findNode(state: EditorState, name: string) {
	let found: import('@lezer/common').SyntaxNode | null = null;
	syntaxTree(state).iterate({
		/**
		 * @param {{ name: string; node: import('@lezer/common').SyntaxNode }} ref ノード
		 * @returns {boolean | void}
		 */
		enter(ref) {
			if (ref.name === name) {
				found = ref.node;
				return false;
			}
		},
	});
	return found;
}

describe('blockWidgets', () => {
	it('classifyImageSource は URL / 絶対 / 相対を判定する', () => {
		expect(classifyImageSource('https://example.com/a.png')).toBe('url');
		expect(classifyImageSource('C:\\images\\a.png')).toBe('absolute');
		expect(classifyImageSource('./a.png')).toBe('relative');
		expect(classifyImageSource('images/a.png')).toBe('relative');
	});

	it('テーブルデータを抽出し、強調・ハイライトを保持する', () => {
		const state = createState('| a | b |\n| --- | --- |\n| **1** | ==y== |\n', 0);
		const table = findNode(state, 'Table');
		expect(table).not.toBeNull();
		const data = extractTableData(state, table!);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('a');
		expect(tableCellNodesToPlainText(data.rows[0]![0]!)).toBe('1');
		expect(data.rows[0]![0]!.some((node) => node.kind === 'strong')).toBe(true);
		expect(data.rows[0]![1]!.some((node) => node.kind === 'highlight')).toBe(true);
	});

	it('テーブルの空セルと末尾空行を列として保持する', () => {
		const state = createState('| No. | 内容 | 備考 |\n| --- | --- | --- |\n| | | 情報行 |\n| | | |\n', 0);
		const table = findNode(state, 'Table');
		expect(table).not.toBeNull();
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

	it('テーブルセル内の br を AST に含める', () => {
		const state = createState('| a<br>b | c |\n| --- | --- |\n| 1 | 2 |', 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);
		expect(data.headers[0]!.some((node) => node.kind === 'br')).toBe(true);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('a\nb');
	});

	it('表セルの編集値ではHTML改行タグだけを実改行へ変換する', () => {
		const description = [
			'**外部公開されてはいけない機密性の高い内容**を置く場所',
			'・プライベートな内容（ログイン情報など含む）',
			'・顧客業務で使用する内容',
			'・Obsidianの機能の検証など',
		].join('<br>');
		const doc         = `| Vault名 | 説明 |\n| --- | --- |\n| TmObsidian01 | ${description} |\n| code | \`code<br>literal\`<br>次 |`;
		const state       = createState(doc, 0);
		const table       = findNode(state, 'Table');
		const data        = extractTableData(state, table!);

		expect(data.rows[0]![1]!.some((node) => node.kind === 'br')).toBe(true);
		expect(data.rowSources[0]![1]!.text).toBe(description);
		expect(data.rowSources[0]![1]!.editableText).toBe(description.replaceAll('<br>', '\n'));
		expect(data.rowSources[1]![1]!.editableText).toBe('`code<br>literal`\n次');
	});

	it('表セル編集中もキャレット外のインライン記法をプレビュー表示できる範囲を保持する', () => {
		const description   = [
			'Cursor,Claude等AIに参照させる`abc`設計書や==各種==ドキュメントを置く場所',
			'（仮に外部に情報が漏れても影響のない性質の内容のみ置く）',
		].join('<br>');
		const doc           = `| Vault名 | 説明 |\n| --- | --- |\n| PublicDocs | ${description} |`;
		const state         = createState(doc, 0);
		const table         = findNode(state, 'Table');
		const data          = extractTableData(state, table!);
		const source        = data.rowSources[0]![1]!;
		const code          = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'code');
		const highlight     = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'highlight');
		const codeFrom      = source.editableText.indexOf('`abc`');
		const highlightFrom = source.editableText.indexOf('==各種==');

		expect(source.editableText).toBe(description.replace('<br>', '\n'));
		expect(code).toMatchObject({
			from: codeFrom,
			to  : codeFrom + '`abc`'.length,
			markRanges: [
				{ from: codeFrom, to: codeFrom + 1 },
				{ from: codeFrom + 4, to: codeFrom + 5 },
			],
		});
		expect(highlight).toMatchObject({
			from: highlightFrom,
			to  : highlightFrom + '==各種=='.length,
			markRanges: [
				{ from: highlightFrom, to: highlightFrom + 2 },
				{ from: highlightFrom + 4, to: highlightFrom + 6 },
			],
		});
		expect(getActiveTableCellInlineRangeIds(source.inlineRanges, 0)).toEqual([]);
		expect(getActiveTableCellInlineRangeIds(source.inlineRanges, codeFrom + 2)).toEqual([code!.id]);
		expect(getActiveTableCellInlineRangeIds(source.inlineRanges, highlightFrom + 3)).toEqual([highlight!.id]);
		expect(getTableCellEditableOffsetFromPreview(
			source.editableText,
			source.inlineRanges,
			codeFrom + 1,
		)).toBe(codeFrom + 2);
		expect(getTableCellEditableOffsetFromPreview(
			source.editableText,
			source.inlineRanges,
			highlightFrom - 2 + 1,
		)).toBe(highlightFrom + 3);
	});

	it('表セルの `{java}` インラインコードは言語接頭辞を markRanges に含める', () => {
		const doc      = '| col |\n| --- |\n| `{java}String a;` |';
		const state    = createState(doc, 0);
		const table    = findNode(state, 'Table');
		const data     = extractTableData(state, table!);
		const source   = data.rowSources[0]![0]!;
		const code     = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'code');
		const codeFrom = source.editableText.indexOf('`{java}String a;`');

		expect(code?.codeLanguage).toBe('java');
		expect(code?.markRanges).toEqual(expect.arrayContaining([
			{ from: codeFrom, to: codeFrom + 1 },
			{ from: codeFrom + 1, to: codeFrom + 7 },
			{ from: codeFrom + 16, to: codeFrom + 17 },
		]));
	});

	it('表セルの `{java}` 直後の空白も markRanges に含める', () => {
		const doc      = '| col |\n| --- |\n| `{java}  x` |';
		const state    = createState(doc, 0);
		const table    = findNode(state, 'Table');
		const data     = extractTableData(state, table!);
		const source   = data.rowSources[0]![0]!;
		const code     = source.inlineRanges.find((inlineRange) => inlineRange.kind === 'code');
		const codeFrom = source.editableText.indexOf('`{java}  x`');

		expect(code?.codeLanguage).toBe('java');
		expect(code?.markRanges).toEqual(expect.arrayContaining([
			{ from: codeFrom, to: codeFrom + 1 },
			{ from: codeFrom + 1, to: codeFrom + 9 },
			{ from: codeFrom + 10, to: codeFrom + 11 },
		]));
	});

	it('プレビュー時にテーブル replace を生成する', () => {
		const doc        = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter';
		const state      = createState(doc, doc.length - 1);
		const entries    = collectBlockDecorationEntries(state);
		const tableEntry = entries.find((entry) => entry.decoration.spec.widget instanceof TableWidget);
		expect(tableEntry).toBeDefined();
		expect(tableEntry!.from).toBe(0);
	});

	it('カーソルがテーブル内にあっても編集可能な表 replace を維持する', () => {
		const doc        = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nafter';
		const state      = createState(doc, 2);
		const entries    = collectBlockDecorationEntries(state);
		const tableEntry = entries.find((entry) => entry.decoration.spec.widget instanceof TableWidget);
		expect(tableEntry).toBeDefined();
	});

	it('セル編集変更は対象セルだけを置換し、Undo可能な単一変更になる', () => {
		const doc    = '| 見出し１ | 見出し２ |\n| --- | --- |\n| aa | bbb |';
		const state  = createState(doc, 0);
		const table  = findNode(state, 'Table');
		const data   = extractTableData(state, table!);
		const change = buildTableCellChange(data, { row: 1, column: 0 }, 'aZa');

		expect(change).not.toBeNull();
		expect(state.update({ changes: change! }).state.doc.toString()).toBe(
			'| 見出し１ | 見出し２ |\n| --- | --- |\n| aZa | bbb |',
		);
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

	it('Shift+Enterだけを表セル内改行として扱う', () => {
		expect(isTableCellSoftBreakKey({
			ctrlKey: false, metaKey: false, altKey: false, shiftKey: true, key: 'Enter',
		})).toBe(true);
		expect(isTableCellSoftBreakKey({
			ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: 'Enter',
		})).toBe(false);
		expect(isTableCellSoftBreakKey({
			ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: 'Enter',
		})).toBe(false);
	});

	it('表セル内の Ctrl+A と Cmd+A だけをセル全選択として扱う', () => {
		expect(isTableCellSelectAllKey({ ctrlKey: true, metaKey: false, altKey: false, key: 'a' })).toBe(true);
		expect(isTableCellSelectAllKey({ ctrlKey: false, metaKey: true, altKey: false, key: 'A' })).toBe(true);
		expect(isTableCellSelectAllKey({ ctrlKey: true, metaKey: false, altKey: true, key: 'a' })).toBe(false);
		expect(isTableCellSelectAllKey({ ctrlKey: true, metaKey: false, altKey: false, key: 'z' })).toBe(false);
	});

	it('表セルの上下キーだけを同一列の縦移動として扱う', () => {
		/**
		 * 修飾キーなしのキーイベント相当値を作る。
		 * @param {string} value キー名
		 * @returns {object} キーイベント相当値
		 */
		const key = (value: string) => ({
			ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: value,
		});
		expect(getTableCellVerticalArrowDirection(key('ArrowUp'))).toBe('up');
		expect(getTableCellVerticalArrowDirection(key('ArrowDown'))).toBe('down');
		expect(getTableCellVerticalArrowDirection(key('ArrowLeft'))).toBeNull();
		expect(getTableCellVerticalArrowDirection(key('ArrowRight'))).toBeNull();
		expect(getTableCellVerticalArrowDirection({ ...key('ArrowUp'), shiftKey: true })).toBeNull();
	});

	it('末尾空行の上下キーは同列移動し、上下端では表外の隣接行へ出る', () => {
		const doc   = 'above\n| h1 | h2 | h3 |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n| | | |\n\nbelow';
		const state = createState(doc, 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);
		const key   = {
			ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: 'ArrowDown',
		};

		expect(getTableCellVerticalNavigation(data, { row: 3, column: 0 }, key)).toEqual({
			direction: 'down',
			target   : null,
		});
		expect(getTableCellVerticalNavigation(data, { row: 3, column: 1 }, {
			...key,
			key: 'ArrowUp',
		})).toEqual({
			direction: 'up',
			target   : { row: 2, column: 1 },
		});
		expect(getTableCellVerticalNavigation(data, { row: 3, column: 1 }, {
			...key,
			key: 'ArrowRight',
		})).toBeNull();
		expect(getTableCellVerticalNavigation(data, { row: 0, column: 0 }, {
			...key,
			key: 'ArrowUp',
		})).toEqual({
			direction: 'up',
			target   : null,
		});
		expect(getTableVerticalExitPosition(state, data.tableFrom, data.tableTo, false))
			.toBe(state.doc.line(1).from);
		expect(getTableVerticalExitPosition(state, data.tableFrom, data.tableTo, true))
			.toBe(state.doc.line(7).from);
	});

	it('エスケープ済みパイプをセル境界として扱わない', () => {
		const state = createState('| a \\| b | c |\n| --- | --- |\n| `x\\|y` | z |', 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);

		expect(data.headerSources).toHaveLength(2);
		expect(data.headerSources[0]?.text).toBe('a \\| b');
		expect(data.rowSources[0]).toHaveLength(2);
	});

	it('Tab・Enter・上下キーの移動先、および最終セルでの空行追加を構築する', () => {
		const doc   = '| a | b |\n| --- | --- |\n| 1 | 2 |';
		const state = createState(doc, 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);

		expect(getAdjacentTableCellPosition(data, { row: 0, column: 0 }, 'next')).toEqual({ row: 0, column: 1 });
		expect(getAdjacentTableCellPosition(data, { row: 1, column: 0 }, 'previous')).toEqual({ row: 0, column: 1 });
		expect(getAdjacentTableCellPosition(data, { row: 0, column: 1 }, 'down')).toEqual({ row: 1, column: 1 });
		expect(getAdjacentTableCellPosition(data, { row: 1, column: 1 }, 'up')).toEqual({ row: 0, column: 1 });
		expect(getAdjacentTableCellPosition(data, { row: 0, column: 1 }, 'up')).toBeNull();
		expect(getAdjacentTableCellPosition(data, { row: 1, column: 1 }, 'down')).toBeNull();
		expect(getAdjacentTableCellPosition(data, { row: 1, column: 1 }, 'next')).toBeNull();

		const change = buildAppendTableRowChange(state, data);
		expect(change).not.toBeNull();
		expect(state.update({ changes: change! }).state.doc.toString()).toBe(
			'| a | b |\n| --- | --- |\n| 1 | 2 |\n|  |  |',
		);
	});

	it('テーブル外からの上下移動は移動方向側の第1列セルへ入る', () => {
		const doc   = [
			'above',
			'| h1 | h2 |',
			'| --- | --- |',
			'| a | b |',
			'| c | d |',
			'',
			'below',
		].join('\n');
		const state = createState(doc, 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);

		const fromAbove  = state.doc.line(1).to;
		const intoHeader = state.doc.line(2).from;
		expect(getTableVerticalEntryTarget(state, fromAbove, intoHeader, true)).toEqual({
			tableFrom: data.tableFrom,
			position : { row: 0, column: 0 },
			sourceFrom: data.headerSources[0]!.from,
		});

		const fromBelow   = state.doc.line(6).from;
		const intoLastRow = state.doc.line(5).to;
		expect(getTableVerticalEntryTarget(state, fromBelow, intoLastRow, false)).toEqual({
			tableFrom: data.tableFrom,
			position : { row: 2, column: 0 },
			sourceFrom: data.rowSources[1]![0]!.from,
		});

		expect(getTableVerticalEntryTarget(
			state,
			data.headerSources[0]!.from,
			data.rowSources[0]![0]!.from,
			true,
		)).toBeNull();
	});

	it('セル編集は履歴から1回でUndoできる', () => {
		const doc    = '| a | b |\n| --- | --- |\n| aa | bb |';
		let state    = EditorState.create({
			doc,
			extensions: [createTmsMarkdownSupport(), history()],
		});
		const table  = findNode(state, 'Table');
		const data   = extractTableData(state, table!);
		const change = buildTableCellChange(data, { row: 1, column: 0 }, 'aZa');
		state        = state.update({ changes: change!, userEvent: 'input.type' }).state;

		const commandTarget = {
			state,
			/**
			 *
			 */
			dispatch(transaction: import('@codemirror/state').Transaction) {
				state = transaction.state;
			},
		} as unknown as import('@codemirror/view').EditorView;

		expect(undo(commandTarget)).toBe(true);
		expect(state.doc.toString()).toBe(doc);
	});

	it('Image から alt と URL を抽出する', () => {
		const state = createState('![説明](./img.png)');
		const image = findNode(state, 'Image');
		expect(image).not.toBeNull();
		expect(extractImageAltAndUrl(state, image!)).toEqual({
			alt: '説明',
			url: './img.png',
		});
	});

	it('![[embed.png]] を WikiEmbed としてパースする', () => {
		const state           = createState('![[embed.png]]');
		const names: string[] = [];
		syntaxTree(state).iterate({
			/**
			 * @param {{ name: string }} node ノード
			 * @returns {void}
			 */
			enter(node) {
				names.push(node.name);
			},
		});
		expect(names).toContain('WikiEmbed');
		expect(names).toContain('WikiEmbedPath');
		expect(names).not.toContain('Image');

		const embed = findNode(state, 'WikiEmbed');
		expect(embed).not.toBeNull();
		expect(extractWikiEmbedPath(state, embed!)).toBe('embed.png');
	});

	it('幅付き WikiEmbed のパスからサイズを除いて widget を作る', () => {
		const doc     = '先頭\n![[_添付ファイル/a.png|478]]';
		const state   = createState(doc, 0);
		const entries = collectBlockDecorationEntries(state);
		expect(entries).toHaveLength(1);
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).toBe('![[_添付ファイル/a.png|478]]');
	});

	it('プレビュー時に画像 replace を生成する', () => {
		const doc     = 'before\n![a](https://example.com/x.png)\nafter';
		const state   = createState(doc, 0);
		const entries = collectBlockDecorationEntries(state);
		expect(entries.some((entry) => entry.to > entry.from)).toBe(true);
	});

	it('テーブルセル内の許可 HTML を AST に含める', () => {
		const state = createState('| a <u>x</u> | b |\n| --- | --- |\n| 1 | 2 |', 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);
		expect(data.headers[0]!.some((node) => node.kind === 'html' && node.tagName === 'u')).toBe(true);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toBe('a x');
	});

	it('テーブルセル内の非許可 HTML はテキストとして残す', () => {
		const state = createState('| a <script>x</script> | b |\n| --- | --- |\n| 1 | 2 |', 0);
		const table = findNode(state, 'Table');
		const data  = extractTableData(state, table!);
		expect(data.headers[0]!.some((node) => node.kind === 'html')).toBe(false);
		expect(tableCellNodesToPlainText(data.headers[0]!)).toContain('<script>');
	});

	it('本文の <br> を改行 Decoration にする（インラインコード内は対象外）', () => {
		const doc     = 'hello<br>world and `code<br>here`\n\ncursor';
		const state   = createState(doc, doc.length - 1);
		const entries = collectHtmlDecorationEntries(state);
		expect(entries).toHaveLength(1);
		expect(state.doc.sliceString(entries[0]!.from, entries[0]!.to)).toBe('<br>');
		// 互換 export
		expect(collectHtmlBreakDecorationEntries(state)).toHaveLength(1);
	});

	it('HTMLは同じ行のカーソル外ではプレビュー、内部ではソース表示にする', () => {
		const doc          = '前 <u>下線</u> 後';
		const previewState = createState(doc, 0);
		const sourceState  = createState(doc, doc.indexOf('下線') + 1);

		expect(collectHtmlDecorationEntries(previewState)).toHaveLength(3);
		expect(collectHtmlDecorationEntries(sourceState)).toHaveLength(0);
	});
});
