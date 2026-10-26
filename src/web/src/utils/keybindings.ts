/**
 * キー入力と設定のショートカット文字列を突き合わせる
 * キー割り当て自体の保存は持たない
 * @file
 */

/**
 * キーイベントが指定ショートカットに一致するか判定する
 * 修飾キーの過不足は不一致。`+` 区切りの最後がキー名で、`-` `=` `\` 空白 数字は物理キーも見る
 * @param event - 判定するキーイベント
 * @param shortcut - `Ctrl+Shift+S` のような設定値。区切りは `+`
 * @returns 修飾キーとキーが一致する場合 true
 */
export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
	// + 区切りを小文字へ揃えた部品。空の設定は空文字 1 つになる
	const parts      = shortcut.split('+').map((part) => part.trim().toLowerCase());
	// 最後の部品。修飾名ではなく、押されたキーの設定名
	const key        = parts[parts.length - 1];
	// 部品に ctrl があるか。無いときは Ctrl が押されていてはならない
	const needsCtrl  = parts.includes('ctrl');
	// 部品に shift があるか
	const needsShift = parts.includes('shift');
	// 部品に alt があるか
	const needsAlt   = parts.includes('alt');

	// 比較に使う event.key。1 文字も名前キーも小文字にする
	const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();

	// 要求した Ctrl の有無と実際が違う。この時点で不一致
	if (needsCtrl !== event.ctrlKey) {
		return false;
	}

	// 要求した Shift の有無と実際が違う。Ctrl は上で揃っている
	if (needsShift !== event.shiftKey) {
		return false;
	}

	// 要求した Alt の有無と実際が違う。Ctrl と Shift は上で揃っている
	if (needsAlt !== event.altKey) {
		return false;
	}

	// 設定も入力も Tab のときだけ一致。どちらか一方では次の判定へ進む
	if (key === 'tab' && eventKey === 'tab') {
		return true;
	}

	// 設定が \ で、入力が \ か | のときだけ一致。設定が \ でなければ入らない
	if (key === '\\' && (eventKey === '\\' || eventKey === '|')) {
		return true;
	}

	// 設定が - で、Minus か - か _ のときだけ一致。設定が - でなければ入らない
	if (key === '-' && (event.code === 'Minus' || eventKey === '-' || eventKey === '_')) {
		return true;
	}

	// 設定が = かつ物理キーが Equal のときだけ一致。文字の = だけでは入らない
	if (key === '=' && event.code === 'Equal') {
		return true;
	}

	// 設定が space かつ入力が空白のときだけ一致。どちらか一方では一致にしない
	if (key === 'space' && event.key === ' ') {
		return true;
	}

	// 設定が 1 桁で、その数字キーか 0 のときに出る ) のときだけ一致。数字でなければ入らない
	if (/^\d$/.test(key) && (event.code === `Digit${key}` || (key === '0' && eventKey === ')'))) {
		return true;
	}

	return eventKey === key;
}

/**
 * キー入力から設定保存用のショートカット文字列を生成する
 * 修飾キー単体、正規化できないキー、修飾なしのファンクション以外は null
 * @param event - 記録するキーイベント。物理キーを優先する
 * @returns `Ctrl+Shift+U` のような文字列。保存できない入力は null
 */
export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
	// 修飾キーだけの入力は、ショートカットとして保存できない
	if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
		return null;
	}

	// 保存用のキー名。物理キーを優先し、変換できないときは null
	const key = normalizeEventKey(event);
	// 保存名が無いキーは記録しない
	if (!key) {
		return null;
	}

	// 押されている修飾の並び。無ければファンクション以外は捨てる
	const parts: string[] = [];
	// Ctrl が押されているときだけ設定名へ載せる
	if (event.ctrlKey) {
		parts.push('Ctrl');
	}
	// Shift が押されているときだけ載せる。Ctrl が無くても載せる
	if (event.shiftKey) {
		parts.push('Shift');
	}
	// Alt が押されているときだけ載せる
	if (event.altKey) {
		parts.push('Alt');
	}

	// 修飾が無く、F1〜F12 でもない。文字キー単体は保存しない。どちらか一方が欠けるとここへ入らない
	if (parts.length === 0 && !/^F([1-9]|1[0-2])$/.test(key)) {
		return null;
	}

	parts.push(key);
	return parts.join('+');
}

/**
 * 競合比較用にショートカットを正規化する
 * 大小文字と並びを無視できるよう、小文字にして部品をソートする
 * @param shortcut - 比較するショートカット。区切りは `+`
 * @returns 小文字・ソート済みの比較用文字列
 */
export function normalizeShortcut(shortcut: string): string {
	return shortcut
		.split('+')
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean)
		.sort()
		.join('+');
}

/**
 * 指定ショートカットと競合するコマンドキーを返す
 * 編集中のコマンド自身は競合に含めない。表記順が違っても同じ割り当てとみなす
 * @param keybindings - コマンドキーからショートカット文字列への対応
 * @param currentKey - いま編集しているコマンドキー。結果から除く
 * @param shortcut - 割り当てようとしているショートカット
 * @returns 同じ割り当てを持つ他コマンドのキー。無ければ空配列
 */
export function findShortcutConflicts(keybindings: Record<string, string>, currentKey: string, shortcut: string): string[] {
	// 大小と並びを揃えた比較用の割り当て。空文字もそのまま比べる
	const normalized = normalizeShortcut(shortcut);
	return Object.entries(keybindings)
		.filter(([key, value]) => key !== currentKey && normalizeShortcut(value) === normalized)
		.map(([key]) => key);
}

/**
 * Windows でアプリまで届かないことがある既知の予約キーか判定する
 * 現在の対象は `Ctrl+Shift+0` だけ。表記順は問わない
 * @param shortcut - 判定するショートカット
 * @returns 既知の予約キーなら true
 */
export function isKnownWindowsReservedShortcut(shortcut: string): boolean {
	return normalizeShortcut(shortcut) === normalizeShortcut('Ctrl+Shift+0');
}

/**
 * 物理キーコードを優先し、キーボード配列に左右されない設定名へ変換する
 * 文字キーは大文字、空白は `Space`、保存できないキーは null
 * @param event - 変換するキーイベント。`code` を `key` より優先する
 * @returns 設定へ保存するキー名。変換できないときは null
 */
function normalizeEventKey(event: KeyboardEvent): string | null {
	// ----- 物理キーを優先 -----
	// 文字キーは code の Key を除いた大文字。キーボード配列に依存しない
	if (/^Key[A-Z]$/.test(event.code)) {
		return event.code.slice(3);
	}
	// 数字キーは Digit を除いた数字。Shift で記号になっていても数字のまま
	if (/^Digit\d$/.test(event.code)) {
		return event.code.slice(5);
	}
	// 物理キーが Minus。文字の - と _ を同じ設定名にする
	if (event.code === 'Minus') {
		return '-';
	}
	// 物理キーが Equal。文字の = を配列に依存させない
	if (event.code === 'Equal') {
		return '=';
	}
	// 物理キーが Backslash。配列によって | になるキーも \ として保存する
	if (event.code === 'Backslash') {
		return '\\';
	}

	// ----- 文字キーへのフォールバック -----
	// 空白は Space。code が Space でない入力も同じ名前にする
	if (event.key === ' ') {
		return 'Space';
	}
	// 1 文字で、上の物理キーに当てはまらなかったもの。大文字で保存する
	if (event.key.length === 1) {
		return event.key.toUpperCase();
	}
	// F1〜F12。修飾が無くても保存できる名前
	if (/^F([1-9]|1[0-2])$/i.test(event.key)) {
		return event.key.toUpperCase();
	}

	// ----- 名前付きキー -----
	// 保存できる名前付きキー。値は設定へ書く表記で、DOM の key と綴りを揃える
	const namedKeys: Record<string, string> = {
		// 改行。修飾と組んだときだけ保存される
		Enter: 'Enter',
		// タブ移動。Tab 同士の比較は matchesShortcut 側でも行う
		Tab: 'Tab',
		// キャンセル。修飾と組んだ割り当てに使う
		Escape: 'Escape',
		// キャレット前の削除
		Backspace: 'Backspace',
		// キャレット後の削除
		Delete: 'Delete',
		// 行頭、または文書の先頭側へ移動するキー
		Home: 'Home',
		// 行末、または文書の末尾側へ移動するキー
		End: 'End',
		// 前のページへ移動するキー
		PageUp: 'PageUp',
		// 次のページへ移動するキー
		PageDown: 'PageDown',
		// 上方向への移動
		ArrowUp: 'ArrowUp',
		// 下方向への移動
		ArrowDown: 'ArrowDown',
		// 左方向への移動
		ArrowLeft: 'ArrowLeft',
		// 右方向への移動
		ArrowRight: 'ArrowRight'
	};

	return namedKeys[event.key] ?? null;
}
