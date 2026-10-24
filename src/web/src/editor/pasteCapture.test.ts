/**
 * 貼り付けの横取り判定を、closest の一致だけで検証する
 * 実 DOM は使わず、セレクタ一致を模した target を渡す
 * @file
 */
import { describe, expect, it } from 'vitest';
import { shouldSkipEditorPasteCapture } from './pasteCapture';

/**
 * closest が指定セレクタに一致する貼り付けイベントを作る
 * @param selectors - closest が空でない値を返すセレクタ。空配列のときはどの UI にも属さない
 * @returns target.closest だけを持つ ClipboardEvent のモック
 */
function pasteEvent(selectors: string[]): ClipboardEvent {
	return {
		target: {
			/**
			 * セレクタが引数の一覧に含まれるときだけ、空オブジェクトを返す
			 * @param selector - 判定する CSS セレクタ
			 * @returns 一致したとき空オブジェクト。不一致は null
			 */
			closest(selector: string) {
				return selectors.includes(selector) ? {} : null;
			},
		},
	} as unknown as ClipboardEvent;
}

describe('pasteCapture', () => {
	it('表セルと検索欄では横取りしない', () => {
		expect(shouldSkipEditorPasteCapture(pasteEvent(['.cm-md-table']))).toBe(true);
		expect(shouldSkipEditorPasteCapture(pasteEvent(['.cm-search']))).toBe(true);
		expect(shouldSkipEditorPasteCapture(pasteEvent(['.tms-mde-settings-backdrop']))).toBe(true);
	});

	it('エディタ本文では横取りする', () => {
		expect(shouldSkipEditorPasteCapture(pasteEvent([]))).toBe(false);
	});
});
