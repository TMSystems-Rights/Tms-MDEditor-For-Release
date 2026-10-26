/**
 * コード用フォントの CSS 生成と、style 要素をスニペットより前へ入れることを検証する
 * @file
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCodeFontFamily, buildCodeFontCss, CODE_FONT_STYLE_ID, DEFAULT_CODE_FONT_FAMILY, sanitizeCssFontFamily } from './codeFont';
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
		expect(buildCodeFontCss('"BIZ UDゴシック", monospace')).toBe(':root { --tms-mde-font-mono: "BIZ UDゴシック", monospace; }');
	});

	it('セレクタを差し替えられる', () => {
		expect(buildCodeFontCss('Consolas', '.tms-mde-export-root')).toBe('.tms-mde-export-root { --tms-mde-font-mono: Consolas; }');
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
		expect(dom.head.children[0]?.textContent).toBe('.tms-mde-editor-host { --tms-mde-font-mono: "HackGen Console NF", monospace; }');
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
