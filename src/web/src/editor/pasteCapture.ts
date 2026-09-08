/**
 * エディタ本文以外（表セル・検索・ダイアログ）の貼り付けを横取りしない
 * @param {ClipboardEvent} event 貼り付けイベント
 * @returns {boolean}
 */
export function shouldSkipEditorPasteCapture(event: ClipboardEvent): boolean {
	const target = event.target;
	if (isFormFieldTarget(target)) {
		return true;
	}

	if (!target || typeof target !== 'object' || typeof (target as { closest?: unknown }).closest !== 'function') {
		return false;
	}

	const element = target as unknown as { closest: (selector: string) => unknown };
	return Boolean(
		element.closest('.cm-md-table')
		|| element.closest('.cm-search')
		|| element.closest('.tms-mde-dialog-backdrop')
		|| element.closest('.tms-mde-settings-backdrop')
	);
}

/**
 * input / textarea への貼り付けか判定する
 * @param {EventTarget | null} target イベント対象
 * @returns {boolean}
 */
function isFormFieldTarget(target: EventTarget | null): boolean {
	if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) {
		return true;
	}

	if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) {
		return true;
	}

	return false;
}
