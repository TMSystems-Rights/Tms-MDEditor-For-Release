/**
 * タブ要素がフォーカスを取らず、ドラッグできることを検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { createDraggableTabElement } from './tabElement';

describe('createDraggableTabElement', () => {
	it('フォーカスを奪わない div をネイティブドラッグ可能なタブとして生成する', () => {
		// setAttribute が記録する属性。生成後に role と aria-selected を見る
		const attributes = new Map<string, string>();
		// 生成直後の div モック。tabIndex は 0、draggable は false から書き換わる
		const element    = {
			// 生成直後の tabindex。関数が -1 へ変える
			tabIndex: 0,
			// 生成直後はドラッグ不可。関数が true へ変える
			draggable: false,
			/**
			 * 属性値を記録する
			 * @param name - 属性名
			 * @param value - 記録する値
			 */
			setAttribute(name: string, value: string) {
				attributes.set(name, value);
			}
		} as unknown as HTMLDivElement;

		// createElement が受けたタグ名。空のままなら生成していない
		let createdTagName = '';
		// createElement だけを持つ document。実 DOM ではない
		const documentRef  = {
			/**
			 * 生成対象のタグ名を記録する
			 * @param tagName - 要求されたタグ名
			 * @returns テストが用意した要素
			 */
			createElement(tagName: string) {
				createdTagName = tagName;
				return element;
			}
		} as unknown as Pick<Document, 'createElement'>;

		expect(createDraggableTabElement(documentRef, true)).toBe(element);
		expect(createdTagName).toBe('div');
		expect(element.tabIndex).toBe(-1);
		expect(element.draggable).toBe(true);
		expect(attributes.get('role')).toBe('tab');
		expect(attributes.get('aria-selected')).toBe('true');
	});
});
