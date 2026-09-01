import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	applyCodeFontFamily,
	buildCodeFontCss,
	CODE_FONT_STYLE_ID,
	DEFAULT_CODE_FONT_FAMILY,
	sanitizeCssFontFamily,
} from './codeFont';
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
		tagName     : 'STYLE',
		textContent : '',
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

describe('sanitizeCssFontFamily', () => {
	it('空文字は既定値を返す', () => {
		expect(sanitizeCssFontFamily('')).toBe(DEFAULT_CODE_FONT_FAMILY);
		expect(sanitizeCssFontFamily('   ')).toBe(DEFAULT_CODE_FONT_FAMILY);
		expect(sanitizeCssFontFamily(null)).toBe(DEFAULT_CODE_FONT_FAMILY);
	});

	it('波括弧と改行を除去する', () => {
		expect(sanitizeCssFontFamily('Consolas; }\nbody { color: red')).toBe('Consolas; body color: red');
	});
});

describe('buildCodeFontCss', () => {
	it('CSS 変数へフォントを書き出す', () => {
		expect(buildCodeFontCss('"BIZ UDゴシック", monospace')).toBe(
			':root { --tms-mde-font-mono: "BIZ UDゴシック", monospace; }',
		);
	});

	it('セレクタを差し替えられる', () => {
		expect(buildCodeFontCss('Consolas', '.tms-mde-export-root')).toBe(
			'.tms-mde-export-root { --tms-mde-font-mono: Consolas; }',
		);
	});
});

describe('applyCodeFontFamily', () => {
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

		applyCodeFontFamily('"HackGen Console NF", monospace');

		expect(dom.head.children[0]?.id).toBe(CODE_FONT_STYLE_ID);
		expect(dom.head.children[0]?.textContent).toBe(
			'.tms-mde-editor-host { --tms-mde-font-mono: "HackGen Console NF", monospace; }',
		);
		expect(dom.head.children[1]).toBe(snippet);
	});

	it('既存の style は位置を保ったまま更新する', () => {
		applyCodeFontFamily('Consolas');
		const snippet = createStyleNode();
		snippet.setAttribute(CSS_SNIPPET_STYLE_ATTRIBUTE, '');
		dom.head.appendChild(snippet);

		applyCodeFontFamily('Meiryo');

		expect(dom.head.children.map((child) => child.id || 'snippet')).toEqual([CODE_FONT_STYLE_ID, 'snippet']);
		expect(dom.head.children[0]?.textContent).toBe('.tms-mde-editor-host { --tms-mde-font-mono: Meiryo; }');
	});
});
