import { describe, expect, it } from 'vitest';
import {
	findShortcutConflicts,
	isKnownWindowsReservedShortcut,
	matchesShortcut,
	normalizeShortcut,
	shortcutFromKeyboardEvent,
} from './keybindings';

/**
 * @param {Partial<KeyboardEvent>} partial 部分イベント
 * @returns {KeyboardEvent}
 */
function createKeyEvent(partial: {
	key: string;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
	code?: string;
}): KeyboardEvent {
	return {
		key      : partial.key,
		code     : partial.code ?? '',
		ctrlKey  : partial.ctrlKey ?? false,
		shiftKey : partial.shiftKey ?? false,
		altKey   : partial.altKey ?? false,
	} as KeyboardEvent;
}

describe('keybindings', () => {
	it('Ctrl+E は表示モード切替ショートカットと一致する', () => {
		expect(matchesShortcut(createKeyEvent({ key: 'e', ctrlKey: true }), 'Ctrl+E')).toBe(true);
		expect(matchesShortcut(createKeyEvent({ key: 'E', ctrlKey: true }), 'Ctrl+E')).toBe(true);
	});

	it('修飾キー不足・余分は不一致', () => {
		expect(matchesShortcut(createKeyEvent({ key: 'e' }), 'Ctrl+E')).toBe(false);
		expect(matchesShortcut(createKeyEvent({ key: 'e', ctrlKey: true, shiftKey: true }), 'Ctrl+E')).toBe(false);
	});

	it('設定値の別ショートカットも判定できる', () => {
		expect(matchesShortcut(
			createKeyEvent({ key: 'm', ctrlKey: true, shiftKey: true }),
			'Ctrl+Shift+M',
		)).toBe(true);
	});

	it('Ctrl+R を置換ショートカットとして判定できる', () => {
		expect(matchesShortcut(createKeyEvent({ key: 'r', ctrlKey: true }), 'Ctrl+R')).toBe(true);
		expect(matchesShortcut(createKeyEvent({ key: 'R', ctrlKey: true }), 'Ctrl+R')).toBe(true);
	});

	it('F3 と Shift+F3 を別の検索操作として判定できる', () => {
		expect(matchesShortcut(createKeyEvent({ key: 'F3' }), 'F3')).toBe(true);
		expect(matchesShortcut(createKeyEvent({ key: 'F3', shiftKey: true }), 'Shift+F3')).toBe(true);
		expect(matchesShortcut(createKeyEvent({ key: 'F3', shiftKey: true }), 'F3')).toBe(false);
	});

	it('分割ビューの既定ショートカットを判定できる', () => {
		expect(matchesShortcut(
			createKeyEvent({ key: '_', code: 'Minus', ctrlKey: true, shiftKey: true }),
			'Ctrl+Shift+-',
		)).toBe(true);
		expect(matchesShortcut(
			createKeyEvent({ key: '=', code: 'Minus', ctrlKey: true, shiftKey: true }),
			'Ctrl+Shift+-',
		)).toBe(true);
		expect(matchesShortcut(
			createKeyEvent({ key: '|', ctrlKey: true, shiftKey: true }),
			'Ctrl+Shift+\\',
		)).toBe(true);
		expect(matchesShortcut(
			createKeyEvent({ key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }),
			'Ctrl+Shift+U',
		)).toBe(true);
	});

	it('キー入力を設定保存形式へ変換できる', () => {
		expect(shortcutFromKeyboardEvent(createKeyEvent({
			key     : 'U',
			code    : 'KeyU',
			ctrlKey : true,
			shiftKey: true,
		}))).toBe('Ctrl+Shift+U');
		expect(shortcutFromKeyboardEvent(createKeyEvent({
			key     : '_',
			code    : 'Minus',
			ctrlKey : true,
			shiftKey: true,
		}))).toBe('Ctrl+Shift+-');
		expect(shortcutFromKeyboardEvent(createKeyEvent({
			key     : '+',
			code    : 'Equal',
			ctrlKey : true,
			shiftKey: true,
		}))).toBe('Ctrl+Shift+=');
		expect(shortcutFromKeyboardEvent(createKeyEvent({ key: 'F3' }))).toBe('F3');
		expect(shortcutFromKeyboardEvent(createKeyEvent({ key: 'a', code: 'KeyA' }))).toBeNull();
	});

	it('Equal と Space の物理キーを判定できる', () => {
		expect(matchesShortcut(
			createKeyEvent({ key: '+', code: 'Equal', ctrlKey: true, shiftKey: true }),
			'Ctrl+Shift+=',
		)).toBe(true);
		expect(matchesShortcut(
			createKeyEvent({ key: ' ', code: 'Space', ctrlKey: true }),
			'Ctrl+Space',
		)).toBe(true);
	});

	it('表記順にかかわらずショートカット競合を検出する', () => {
		expect(normalizeShortcut('Shift+Ctrl+U')).toBe(normalizeShortcut('Ctrl+Shift+U'));
		expect(findShortcutConflicts({
			unsplit: 'Ctrl+Shift+U',
			find   : 'Ctrl+F',
		}, 'find', 'Shift+Ctrl+U')).toEqual(['unsplit']);
	});

	it('Windows予約キー Ctrl+Shift+0 を警告対象にする', () => {
		expect(isKnownWindowsReservedShortcut('Shift+Ctrl+0')).toBe(true);
		expect(isKnownWindowsReservedShortcut('Ctrl+Shift+U')).toBe(false);
	});
});
