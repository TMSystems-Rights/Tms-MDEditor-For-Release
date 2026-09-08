import { describe, expect, it } from 'vitest';
import { shouldSkipEditorPasteCapture } from './pasteCapture';

/**
 * @param {string[]} selectors closest が一致するセレクタ
 * @returns {ClipboardEvent}
 */
function pasteEvent(selectors: string[]): ClipboardEvent {
	return {
		target: {
			/**
			 * @param {string} selector セレクタ
			 * @returns {object | null}
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
