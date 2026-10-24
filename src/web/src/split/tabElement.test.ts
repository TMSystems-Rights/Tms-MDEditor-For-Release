/**
 * タブ要素がフォーカスを取らず、ドラッグできることを検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { createDraggableTabElement } from './tabElement';

describe('createDraggableTabElement', () => {
	it('フォーカスを奪わない div をネイティブドラッグ可能なタブとして生成する', () => {
		const attributes = new Map<string, string>();
		const element    = {
			tabIndex : 0,
			draggable: false,
			/**
			 * 属性値を記録する
			 * @param name - 属性名
			 * @param value - 記録する値
			 */
			setAttribute(name: string, value: string) {
				attributes.set(name, value);
			},
		} as unknown as HTMLDivElement;

		let createdTagName = '';
		const documentRef  = {
			/**
			 * 生成対象のタグ名を記録する
			 * @param tagName - 要求されたタグ名
			 * @returns テストが用意した要素
			 */
			createElement(tagName: string) {
				createdTagName = tagName;
				return element;
			},
		} as unknown as Pick<Document, 'createElement'>;

		expect(createDraggableTabElement(documentRef, true)).toBe(element);
		expect(createdTagName).toBe('div');
		expect(element.tabIndex).toBe(-1);
		expect(element.draggable).toBe(true);
		expect(attributes.get('role')).toBe('tab');
		expect(attributes.get('aria-selected')).toBe('true');
	});
});
