import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createTmsMarkdownSupport } from '../editor/createTmsMarkdown';
import { collectSourceLineNumbers } from './cursorLine';
import { buildDecorationSet } from './inlineDecorations';
import {
	collectLineDecorationEntries,
	findCalloutContainingRange,
	findCollapsedCalloutContainingRange,
} from './lineDecorations';

/**
 * TMS Markdown 付き EditorState を生成する
 * @param {string} doc ドキュメント
 * @returns {EditorState}
 */
function createMarkdownState(doc: string): EditorState {
	return EditorState.create({
		doc,
		extensions: [createTmsMarkdownSupport()],
	});
}

describe('lineDecorations', () => {
	it('見出し・引用・水平線・リストを含む Markdown でも DecorationSet を構築できる', () => {
		const state = createMarkdownState([
			'# Title',
			'> quote',
			'---',
			'- item one',
			'  - nested',
			'1. ordered',
			'- [ ] task',
		].join('\n'));

		expect(() => buildDecorationSet(collectLineDecorationEntries(state))).not.toThrow();
	});

	it('YAML フロントマターを水平線や Setext 見出しとして非表示にしない', () => {
		const state       = EditorState.create({
			doc       : [
				'---',
				'fileClass: 問題点一覧管理票FileClass',
				'プロジェクト名: TMS-MDEditor',
				'---',
				'',
				'# 本文',
			].join('\n'),
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);
		const closingLine = state.doc.line(4);
		const frontMatter = entries.filter((entry) => (
			entry.from >= state.doc.line(1).from
			&& entry.from <= closingLine.to
		));

		expect(frontMatter).toEqual([]);
		expect(() => buildDecorationSet(entries)).not.toThrow();
	});

	it('カーソル行の見出しでは HeaderMark を非表示にしない', () => {
		const state = EditorState.create({
			doc       : '# Title',
			selection : { anchor: 1, head: 1 },
			extensions: [createTmsMarkdownSupport()],
		});

		const entries = collectLineDecorationEntries(state);
		const hidden  = entries.filter((entry) => entry.from === 0 && entry.to === 1);
		expect(hidden.length).toBe(0);
	});

	it('プレビュー行の箇条書きはマーカー文字のみ置換する', () => {
		const state       = EditorState.create({
			doc       : '- item\n- other',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);
		const line2       = state.doc.line(2);
		const previewLine = entries.filter((entry) => (
			entry.from === line2.from
			&& entry.to === line2.from + 1
			&& entry.decoration.spec.widget
		));

		expect(previewLine.length).toBe(1);
	});

	it('プレビュー行の TaskMarker はチェックボックス widget に置換する', () => {
		const state       = EditorState.create({
			doc       : '- [ ] task\n- [x] done',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);
		const line2       = state.doc.line(2);
		const checkbox    = entries.filter((entry) => (
			entry.from === line2.from + 2
			&& entry.to === line2.from + 5
			&& entry.decoration.spec.widget
		));

		expect(checkbox.length).toBe(1);
	});

	it('タスク行では ListMark の • を出さず ListMark〜TaskMarker 直前を隠す', () => {
		const state       = EditorState.create({
			doc       : '- item\n- [ ] task',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);
		const line2       = state.doc.line(2);

		const bulletAtListMark = entries.filter((entry) => (
			entry.from === line2.from
			&& entry.to === line2.from + 1
			&& entry.decoration.spec.widget
		));
		const hiddenPrefix     = entries.filter((entry) => (
			entry.from === line2.from
			&& entry.to === line2.from + 2
			&& !entry.decoration.spec.widget
		));
		const checkbox         = entries.filter((entry) => (
			entry.from === line2.from + 2
			&& entry.to === line2.from + 5
			&& entry.decoration.spec.widget
		));

		expect(bulletAtListMark.length).toBe(0);
		expect(hiddenPrefix.length).toBe(1);
		expect(checkbox.length).toBe(1);
	});

	it('ソース行の TaskMarker はチェックボックスに置換しない', () => {
		const state    = EditorState.create({
			doc       : '- [ ] task\n- [x] done',
			selection : { anchor: 5, head: 5 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries  = collectLineDecorationEntries(state);
		const line1    = state.doc.line(1);
		const checkbox = entries.filter((entry) => (
			entry.from === line1.from + 2
			&& entry.to === line1.from + 5
			&& entry.decoration.spec.widget
		));

		expect(checkbox.length).toBe(0);
	});

	it('コールアウト行に種別クラスを付与し [!type] を隠す', () => {
		const state       = EditorState.create({
			doc       : 'plain\n> [!warning] Caution',
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);
		const line2       = state.doc.line(2);
		const calloutLine = entries.filter((entry) => (
			entry.from === line2.from
			&& entry.decoration.spec.class?.includes('cm-md-callout-warning')
		));
		const hiddenType  = entries.filter((entry) => {
			const text = state.doc.sliceString(entry.from, entry.to);
			return text === '[!warning]' || text.startsWith('[!warning]');
		});

		expect(calloutLine.length).toBe(1);
		expect(hiddenType.length).toBeGreaterThanOrEqual(1);
	});

	it('コードブロック行はアクティブでも cm-md-fenced-code を維持する', () => {
		const fence      = String.fromCharCode(96, 96, 96);
		const doc        = ['plain', fence, 'const value = 1;', fence].join('\n');
		const codeOffset = doc.indexOf('const value');
		const preview    = EditorState.create({
			doc,
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const active     = EditorState.create({
			doc,
			selection : { anchor: codeOffset + 1, head: codeOffset + 1 },
			extensions: [createTmsMarkdownSupport()],
		});

		const previewEntries = collectLineDecorationEntries(preview, collectSourceLineNumbers(preview));
		const activeEntries  = collectLineDecorationEntries(active, collectSourceLineNumbers(active));
		const previewLine    = preview.doc.line(3);
		const activeLine     = active.doc.line(3);

		expect(previewEntries.some((entry) => (
			entry.from === previewLine.from
			&& entry.decoration.spec.class?.includes('cm-md-fenced-code')
		))).toBe(true);
		expect(activeEntries.some((entry) => (
			entry.from === activeLine.from
			&& entry.decoration.spec.class?.includes('cm-md-fenced-code')
		))).toBe(true);
	});

	it('コードブロックの CodeMark はアクティブ行では隠さない', () => {
		const fence      = String.fromCharCode(96, 96, 96);
		const doc        = ['plain', fence, 'const value = 1;', fence].join('\n');
		const fenceLine  = doc.indexOf(fence);
		const state      = EditorState.create({
			doc,
			selection : { anchor: fenceLine + 1, head: fenceLine + 1 },
			extensions: [createTmsMarkdownSupport()],
		});
		const entries    = collectLineDecorationEntries(state, collectSourceLineNumbers(state));
		const opening    = state.doc.line(2);
		const hiddenMark = entries.filter((entry) => (
			entry.from === opening.from
			&& entry.to === opening.to
		));

		expect(entries.some((entry) => (
			entry.from === opening.from
			&& entry.decoration.spec.class?.includes('cm-md-fenced-code')
		))).toBe(true);
		expect(hiddenMark.length).toBe(0);
	});

	it('コールアウト内コードブロックの行頭 > もプレビューでは隠す', () => {
		const fence       = String.fromCharCode(96, 96, 96);
		const state       = EditorState.create({
			doc: [
				'plain',
				'> [!info] info',
				`> ${fence}`,
				'> code line',
				`> ${fence}`,
			].join('\n'),
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);

		// 3〜5 行目（フェンス内）の行頭 `>` が hidden replace されること
		for (const lineNumber of [3, 4, 5]) {
			const line   = state.doc.line(lineNumber);
			const hidden = entries.filter((entry) => (
				entry.from === line.from
				&& entry.to === line.from + 1
			));
			expect(hidden.length, `line ${lineNumber}`).toBeGreaterThanOrEqual(1);
		}
	});

	it('[!info]- は既定で本文を隠し折りたたみボタンを出す', () => {
		const fence       = String.fromCharCode(96, 96, 96);
		const state       = EditorState.create({
			doc: [
				'plain',
				'> [!info]- info',
				`> ${fence}`,
				'> hello',
				`> ${fence}`,
			].join('\n'),
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const sourceLines = collectSourceLineNumbers(state);
		const entries     = collectLineDecorationEntries(state, sourceLines);
		const line2       = state.doc.line(2);
		const foldWidget  = entries.filter((entry) => (
			entry.from >= line2.from
			&& entry.from <= line2.to
			&& entry.decoration.spec.widget
		));
		const collapsed   = entries.filter((entry) => (
			entry.from === line2.to
			&& entry.to > line2.to
			&& entry.decoration.spec.widget
			&& entry.decoration.spec.block !== true
		));
		const titleClass  = entries.filter((entry) => (
			entry.from === line2.from
			&& entry.decoration.spec.class?.includes('cm-md-callout-title')
		));

		expect(foldWidget.length).toBeGreaterThanOrEqual(1);
		expect(collapsed.length).toBe(1);
		expect(titleClass.length).toBe(1);
		expect(() => buildDecorationSet(entries)).not.toThrow();
	});

	it('折りたたみコールアウト本文内の範囲を検出する', () => {
		const state      = EditorState.create({
			doc: [
				'plain',
				'> [!info]- info',
				'> hidden target text',
				'> more',
			].join('\n'),
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const targetFrom = state.doc.toString().indexOf('target');
		const callout    = findCollapsedCalloutContainingRange(
			state,
			targetFrom,
			targetFrom + 'target'.length,
		);

		expect(callout?.calloutFrom).toBe(state.doc.line(2).from);
	});

	it('展開中コールアウト本文内の範囲を検出する', () => {
		const state      = EditorState.create({
			doc: [
				'plain',
				'> [!info]+ info target',
				'> visible target text',
				'> more',
			].join('\n'),
			selection : { anchor: 0, head: 0 },
			extensions: [createTmsMarkdownSupport()],
		});
		const targetFrom = state.doc.toString().indexOf('visible target');
		const callout    = findCalloutContainingRange(
			state,
			targetFrom,
			targetFrom + 'visible target'.length,
		);

		expect(callout?.calloutFrom).toBe(state.doc.line(2).from);
	});

	it('>[!success] でも > [!info] と同じ位置にトグルを置く', () => {
		const spaced = EditorState.create({
			doc        : 'plain\n> [!info]- info\n> body\n',
			selection  : { anchor: 0, head: 0 },
			extensions : [createTmsMarkdownSupport()],
		});
		const tight  = EditorState.create({
			doc        : 'plain\n>[!success]- success\n> body\n',
			selection  : { anchor: 0, head: 0 },
			extensions : [createTmsMarkdownSupport()],
		});

		const spacedEntries = collectLineDecorationEntries(spaced, collectSourceLineNumbers(spaced));
		const tightEntries  = collectLineDecorationEntries(tight, collectSourceLineNumbers(tight));

		const spacedLine = spaced.doc.line(2);
		const tightLine  = tight.doc.line(2);
		const spacedFold = spacedEntries.find((entry) => (
			entry.from >= spacedLine.from
			&& entry.from <= spacedLine.to
			&& entry.from === entry.to
			&& entry.decoration.spec.widget
			&& String(entry.decoration.spec.widget.constructor.name).includes('Fold')
		));
		const tightFold  = tightEntries.find((entry) => (
			entry.from >= tightLine.from
			&& entry.from <= tightLine.to
			&& entry.from === entry.to
			&& entry.decoration.spec.widget
			&& String(entry.decoration.spec.widget.constructor.name).includes('Fold')
		));

		expect(spacedFold).toBeDefined();
		expect(tightFold).toBeDefined();

		/**
		 * タイトル本文の開始オフセットを返す
		 * @param {string} text 行テキスト
		 * @returns {number}
		 */
		const titleStart = (text: string): number => {
			const match = /\][+-]?\s*/.exec(text);
			return match ? match.index + match[0].length : -1;
		};

		expect(spacedFold!.from - spacedLine.from).toBe(titleStart(spacedLine.text));
		expect(tightFold!.from - tightLine.from).toBe(titleStart(tightLine.text));

		const successClass = tightEntries.some((entry) => (
			entry.from === tightLine.from
			&& entry.decoration.spec.class?.includes('cm-md-callout-success')
		));
		expect(successClass).toBe(true);
	});
});
