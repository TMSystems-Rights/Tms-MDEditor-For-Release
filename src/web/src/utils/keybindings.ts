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
	const parts      = shortcut.split('+').map((part) => part.trim().toLowerCase());
	const key        = parts[parts.length - 1];
	const needsCtrl  = parts.includes('ctrl');
	const needsShift = parts.includes('shift');
	const needsAlt   = parts.includes('alt');

	const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();

	if (needsCtrl !== event.ctrlKey) {
		return false;
	}

	if (needsShift !== event.shiftKey) {
		return false;
	}

	if (needsAlt !== event.altKey) {
		return false;
	}

	if (key === 'tab' && eventKey === 'tab') {
		return true;
	}

	if (key === '\\' && (eventKey === '\\' || eventKey === '|')) {
		return true;
	}

	if (key === '-' && (event.code === 'Minus' || eventKey === '-' || eventKey === '_')) {
		return true;
	}

	if (key === '=' && event.code === 'Equal') {
		return true;
	}

	if (key === 'space' && event.key === ' ') {
		return true;
	}

	if (/^\d$/.test(key) && (
		event.code === `Digit${key}`
		|| (key === '0' && eventKey === ')')
	)) {
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
	if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
		return null;
	}

	const key = normalizeEventKey(event);
	if (!key) {
		return null;
	}

	const parts: string[] = [];
	if (event.ctrlKey) {
		parts.push('Ctrl');
	}
	if (event.shiftKey) {
		parts.push('Shift');
	}
	if (event.altKey) {
		parts.push('Alt');
	}

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
export function findShortcutConflicts(
	keybindings: Record<string, string>,
	currentKey: string,
	shortcut: string,
): string[] {
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
	if (/^Key[A-Z]$/.test(event.code)) {
		return event.code.slice(3);
	}
	if (/^Digit\d$/.test(event.code)) {
		return event.code.slice(5);
	}
	if (event.code === 'Minus') {
		return '-';
	}
	if (event.code === 'Equal') {
		return '=';
	}
	if (event.code === 'Backslash') {
		return '\\';
	}
	if (event.key === ' ') {
		return 'Space';
	}
	if (event.key.length === 1) {
		return event.key.toUpperCase();
	}
	if (/^F([1-9]|1[0-2])$/i.test(event.key)) {
		return event.key.toUpperCase();
	}

	const namedKeys: Record<string, string> = {
		Enter    : 'Enter',
		Tab      : 'Tab',
		Escape   : 'Escape',
		Backspace: 'Backspace',
		Delete   : 'Delete',
		Home     : 'Home',
		End      : 'End',
		PageUp   : 'PageUp',
		PageDown : 'PageDown',
		ArrowUp  : 'ArrowUp',
		ArrowDown: 'ArrowDown',
		ArrowLeft: 'ArrowLeft',
		ArrowRight: 'ArrowRight',
	};

	return namedKeys[event.key] ?? null;
}
