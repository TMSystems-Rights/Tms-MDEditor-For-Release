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
	// 貼り付け先。フォーム部品なら本文の取り込みから外す
	const target = event.target;
	// input または textarea なら、本文用の取り込みをしない
	if (isFormFieldTarget(target)) {
		return true;
	}

	// 対象が無い、オブジェクトでない、または closest が関数でないときは内側判定ができない。いずれか一つでも本文側へ返し、スキップしない
	if (!target || typeof target !== 'object' || typeof (target as { closest?: unknown }).closest !== 'function') {
		return false;
	}

	// 親要素を辿れる対象。表、検索欄、ダイアログの内側かを見る
	const element = target as unknown as { closest: (selector: string) => unknown };
	// 既知の UI の内側なら本文の取り込みをしない。どれにも属さなければ false
	return Boolean(element.closest('.cm-md-table') || element.closest('.cm-search') || element.closest('.tms-mde-dialog-backdrop') || element.closest('.tms-mde-settings-backdrop'));
}

/**
 * input または textarea への貼り付けかを判定する
 * ホストに HTMLInputElement が無いときは instanceof を使わず、フォーム部品ではないとする
 * @param target - 貼り付けイベントの対象。null のときはフォーム部品ではない
 * @returns input または textarea のとき true
 */
function isFormFieldTarget(target: EventTarget | null): boolean {
	// コンストラクタがあり、かつ対象がそのインスタンスのときだけ input とみなす。型が無い環境だけではフォーム部品にしない
	if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) {
		return true;
	}

	// コンストラクタがあり、かつ対象がそのインスタンスのときだけ textarea とみなす。どちらか一方だけでは true にしない
	if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) {
		return true;
	}

	return false;
}
