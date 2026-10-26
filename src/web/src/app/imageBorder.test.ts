/**
 * 画像枠線の色の検証と、CSS 変数を style 要素へ入れることを検証する
 * @file
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyImageBorder, buildImageBorderCss, DEFAULT_IMAGE_BORDER, IMAGE_BORDER_STYLE_ID, isCssHexColor, resolveImageBorder, sanitizeCssHexColor, toColorInputValue } from './imageBorder';
import { CSS_SNIPPET_STYLE_ATTRIBUTE } from '../settings/cssSnippets';

/** テストが style 要素の代わりに使う、属性と本文を記録するノード */
type StyleNode = {
	/** 要素 id。未設定のモックは空文字 */
	id: string;
	/** 大文字のタグ名。このモックは STYLE 固定 */
	tagName: string;
	/** style 要素へ書いた CSS 本文 */
	textContent: string;
	/** 属性値を返す。無いときは null */
	getAttribute: (name: string) => string | null;
	/** 属性を Map へ記録する */
	setAttribute: (name: string, value: string) => void;
	/** 属性名から値への対応 */
	attributes: Map<string, string>;
};

/** document.head の代わり。子の並びと、スニペット style の検索だけを持つ */
type HeadDom = {
	/** 子要素。並びが挿入順 */
	children: StyleNode[];
	/** 子を末尾へ足して、足した要素を返す */
	appendChild: (node: StyleNode) => StyleNode;
	/** 参照要素の前へ入れる。参照が無いときは末尾 */
	insertBefore: (node: StyleNode, reference: StyleNode) => StyleNode;
	/** セレクタに合う最初の子。このモックはスニペット style だけを探す */
	querySelector: (selector: string) => StyleNode | null;
};

/** document の代わり。head と、id 検索、style の生成だけを持つ */
type DocumentDom = {
	/** document.head のモック */
	head: HeadDom;
	/** id が一致する子。無いときは null */
	getElementById: (id: string) => StyleNode | null;
	/** style 以外のタグ名では例外を投げる */
	createElement: (tagName: string) => StyleNode;
};

/**
 * style 要素の簡易モックを生成する
 * 属性は Map に記録し、本文は textContent に置く
 * @param id - 要素 id。省略時は空文字
 * @returns 属性を記録できる style モック
 */
function createStyleNode(id = ''): StyleNode {
	const attributes      = new Map<string, string>();
	const node: StyleNode = {
		id,
		tagName: 'STYLE',
		textContent: '',
		attributes,
		/**
		 * 属性を取得する
		 * @param name - 属性名
		 * @returns 記録した値。無いときは null
		 */
		getAttribute: (name) => attributes.get(name) ?? null,
		/**
		 * 属性を設定する
		 * @param name - 属性名
		 * @param value - 記録する値
		 */
		setAttribute: (name, value) => {
			attributes.set(name, value);
		}
	};
	return node;
}

/**
 * document.head の簡易モックを生成する
 * @returns head と要素生成を持つ document モック
 */
function createDocumentDom(): DocumentDom {
	const head: HeadDom = {
		children: [],
		/**
		 * 子を末尾へ追加する
		 * @param node - 追加する要素
		 * @returns 追加した要素
		 */
		appendChild: (node) => {
			head.children.push(node);
			return node;
		},
		/**
		 * 参照要素の前へ挿入する
		 * 参照が子に無いときは末尾へ足す
		 * @param node - 挿入する要素
		 * @param reference - この要素の前に入れる
		 * @returns 挿入した要素
		 */
		insertBefore: (node, reference) => {
			const index = head.children.indexOf(reference);
			if (index < 0) {
				head.children.push(node);
			} else {
				head.children.splice(index, 0, node);
			}
			return node;
		},
		/**
		 * セレクタに合う最初の要素を返す
		 * このモックが探すのは、スニペット属性の付いた style だけ
		 * @param selector - CSS セレクタ
		 * @returns 一致した子。無いときは null
		 */
		querySelector: (selector) => {
			if (selector === `style[${CSS_SNIPPET_STYLE_ATTRIBUTE}]`) {
				return head.children.find((child) => child.getAttribute(CSS_SNIPPET_STYLE_ATTRIBUTE) !== null) ?? null;
			}
			return null;
		}
	};

	return {
		head,
		/**
		 * id から要素を取得する
		 * @param id - 要素 id
		 * @returns id が一致する子。無いときは null
		 */
		getElementById: (id) => head.children.find((child) => child.id === id) ?? null,
		/**
		 * 要素を生成する
		 * style 以外のタグはテストの想定外なので例外にする
		 * @param tagName - 生成するタグ名。このモックは style だけを受け付ける
		 * @returns 生成した style モック
		 * @throws {Error} style 以外のタグ名
		 */
		createElement: (tagName) => {
			if (tagName !== 'style') {
				throw new Error(`unexpected tag: ${tagName}`);
			}
			return createStyleNode();
		}
	};
}

describe('isCssHexColor', () => {
	it('16進カラーだけを許可する', () => {
		expect(isCssHexColor('#888')).toBe(true);
		expect(isCssHexColor('#888888')).toBe(true);
		expect(isCssHexColor('#88888880')).toBe(true);
		expect(isCssHexColor('red')).toBe(false);
		expect(isCssHexColor('url(x)')).toBe(false);
	});
});

describe('sanitizeCssHexColor', () => {
	it('空と不正値を既定へ戻す', () => {
		expect(sanitizeCssHexColor('', DEFAULT_IMAGE_BORDER.color)).toBe(DEFAULT_IMAGE_BORDER.color);
		expect(sanitizeCssHexColor('red', DEFAULT_IMAGE_BORDER.color)).toBe(DEFAULT_IMAGE_BORDER.color);
		expect(sanitizeCssHexColor('', '', true)).toBe('');
	});
});

describe('toColorInputValue', () => {
	it('3桁と8桁を color input 向けに変換する', () => {
		expect(toColorInputValue('#abc', '#888888')).toBe('#aabbcc');
		expect(toColorInputValue('#11223344', '#888888')).toBe('#112233');
	});
});

describe('resolveImageBorder', () => {
	it('範囲外の太さは既定値にする', () => {
		expect(resolveImageBorder({ width: 99, hoverWidth: -1 })).toEqual(DEFAULT_IMAGE_BORDER);
	});
});

describe('buildImageBorderCss', () => {
	it('空のホバー色はテーマのアクセントを使う', () => {
		expect(buildImageBorderCss(DEFAULT_IMAGE_BORDER, '.tms-mde-editor-host')).toBe('.tms-mde-editor-host { --tms-mde-image-border-width: 1px; --tms-mde-image-border-color: #888888; --tms-mde-image-border-hover-width: 3px; --tms-mde-image-border-hover-color: var(--tms-mde-color-primary); }');
	});

	it('指定色を書き出す', () => {
		expect(
			buildImageBorderCss(
				{
					width: 2,
					color: '#444444',
					hoverWidth: 5,
					hoverColor: '#2563eb'
				},
				'.tms-mde-export-root'
			)
		).toContain('--tms-mde-image-border-hover-color: #2563eb;');
	});
});

describe('applyImageBorder', () => {
	let dom: DocumentDom;

	beforeEach(() => {
		dom = createDocumentDom();
		vi.stubGlobal('document', dom);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('スニペットより前へ style を挿入する', () => {
		const snippet = createStyleNode();
		snippet.setAttribute(CSS_SNIPPET_STYLE_ATTRIBUTE, '');
		dom.head.appendChild(snippet);

		applyImageBorder(DEFAULT_IMAGE_BORDER);

		expect(dom.head.children[0]?.id).toBe(IMAGE_BORDER_STYLE_ID);
		expect(dom.head.children[0]?.textContent).toContain('--tms-mde-image-border-width: 1px;');
		expect(dom.head.children[1]).toBe(snippet);
	});
});
