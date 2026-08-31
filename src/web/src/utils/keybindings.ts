/**
 * キーイベントが指定ショートカットに一致するか判定する
 * @param {KeyboardEvent} event キーイベント
 * @param {string} shortcut ショートカット文字列
 * @returns {boolean} 一致する場合 true
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
 * キー入力から設定保存用のショートカット文字列を生成する。
 * @param {KeyboardEvent} event キーイベント
 * @returns {string | null} ショートカット。修飾キー単体などは null
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
 * 競合比較用にショートカットを正規化する。
 * @param {string} shortcut ショートカット
 * @returns {string} 正規化値
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
 * 指定ショートカットと競合するコマンドキーを返す。
 * @param {Record<string, string>} keybindings キーバインド
 * @param {string} currentKey 編集中コマンドキー
 * @param {string} shortcut 候補
 * @returns {string[]} 競合コマンドキー
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
 * Windows でアプリまで届かないことがある既知の予約キーか判定する。
 * @param {string} shortcut ショートカット
 * @returns {boolean} 既知の予約キーなら true
 */
export function isKnownWindowsReservedShortcut(shortcut: string): boolean {
	return normalizeShortcut(shortcut) === normalizeShortcut('Ctrl+Shift+0');
}

/**
 *
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
