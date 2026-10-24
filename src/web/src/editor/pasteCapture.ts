/**
 * エディタ本文以外で起きた貼り付けを、本文用の取り込みから外す判定を持つ
 * 貼り付けの実行は持たず、呼び出し側がスキップするかどうかだけを返す
 * @file
 */

/**
 * 表セル、検索欄、ダイアログ、input、textarea への貼り付けなら、本文用の取り込みをスキップする
 * @param event - 判定対象の貼り付け。target がフォーム部品か、既知の UI の内側かを見る
 * @returns 本文用の取り込みを行わないとき true
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
 * input または textarea への貼り付けかを判定する
 * ホストに HTMLInputElement が無いときは instanceof を使わず、フォーム部品ではないとする
 * @param target - 貼り付けイベントの対象。null のときはフォーム部品ではない
 * @returns input または textarea のとき true
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
