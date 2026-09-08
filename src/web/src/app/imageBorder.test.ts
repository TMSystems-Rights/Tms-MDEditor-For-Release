import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyImageBorder,
	buildImageBorderCss,
	DEFAULT_IMAGE_BORDER,
	IMAGE_BORDER_STYLE_ID,
	isCssHexColor,
	resolveImageBorder,
	sanitizeCssHexColor,
	toColorInputValue,
} from './imageBorder';
import { CSS_SNIPPET_STYLE_ATTRIBUTE } from '../settings/cssSnippets';

type StyleNode = {
	id: string;
	tagName: string;
	textContent: string;
	getAttribute: (name: string) => string | null;
	setAttribute: (name: string, value: string) => void;
	attributes: Map<string, string>;
};

type HeadDom = {
	children: StyleNode[];
	appendChild: (node: StyleNode) => StyleNode;
	insertBefore: (node: StyleNode, reference: StyleNode) => StyleNode;
	querySelector: (selector: string) => StyleNode | null;
};

type DocumentDom = {
	head: HeadDom;
	getElementById: (id: string) => StyleNode | null;
	createElement: (tagName: string) => StyleNode;
};

/**
 * style 要素の簡易モックを生成する
 * @param {string} [id] 要素 id
 * @returns {StyleNode}
 */
function createStyleNode(id = ''): StyleNode {
	const attributes      = new Map<string, string>();
	const node: StyleNode = {
		id,
		tagName    : 'STYLE',
		textContent: '',
		attributes,
		/**
		 * 属性を取得する
		 * @param {string} name 属性名
		 * @returns {string | null}
		 */
		getAttribute: (name) => attributes.get(name) ?? null,
		/**
		 * 属性を設定する
		 * @param {string} name 属性名
		 * @param {string} value 属性値
		 * @returns {void}
		 */
		setAttribute: (name, value) => {
			attributes.set(name, value);
		},
	};
	return node;
}

/**
 * document.head の簡易モックを生成する
 * @returns {DocumentDom}
 */
function createDocumentDom(): DocumentDom {
	const head: HeadDom = {
		children: [],
		/**
		 * 子を末尾へ追加する
		 * @param {StyleNode} node 追加する要素
		 * @returns {StyleNode}
		 */
		appendChild: (node) => {
			head.children.push(node);
			return node;
		},
		/**
		 * 参照要素の前へ挿入する
		 * @param {StyleNode} node 挿入する要素
		 * @param {StyleNode} reference 参照要素
		 * @returns {StyleNode}
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
		 * @param {string} selector セレクタ
		 * @returns {StyleNode | null}
		 */
		querySelector: (selector) => {
			if (selector === `style[${CSS_SNIPPET_STYLE_ATTRIBUTE}]`) {
				return head.children.find((child) => child.getAttribute(CSS_SNIPPET_STYLE_ATTRIBUTE) !== null) ?? null;
			}
			return null;
		},
	};

	return {
		head,
		/**
		 * id から要素を取得する
		 * @param {string} id 要素 id
		 * @returns {StyleNode | null}
		 */
		getElementById: (id) => head.children.find((child) => child.id === id) ?? null,
		/**
		 * 要素を生成する
		 * @param {string} tagName タグ名
		 * @returns {StyleNode}
		 */
		createElement: (tagName) => {
			if (tagName !== 'style') {
				throw new Error(`unexpected tag: ${tagName}`);
			}
			return createStyleNode();
		},
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
		expect(buildImageBorderCss(DEFAULT_IMAGE_BORDER, '.tms-mde-editor-host')).toBe(
			'.tms-mde-editor-host { --tms-mde-image-border-width: 1px; --tms-mde-image-border-color: #888888; --tms-mde-image-border-hover-width: 3px; --tms-mde-image-border-hover-color: var(--tms-mde-color-primary); }',
		);
	});

	it('指定色を書き出す', () => {
		expect(buildImageBorderCss({
			width     : 2,
			color     : '#444444',
			hoverWidth: 5,
			hoverColor: '#2563eb',
		}, '.tms-mde-export-root')).toContain('--tms-mde-image-border-hover-color: #2563eb;');
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
