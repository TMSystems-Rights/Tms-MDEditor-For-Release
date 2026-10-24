/**
 * テーマクラスと、OS の配色属性の付け外しを検証する
 * @file
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { applyTheme, syncOsThemeAttribute } from './theme';

/** テーマ適用先の html と body だけを持つ document */
type ThemeDom = {
	/** html 要素の属性操作 */
	documentElement: {
		/** 属性値を返す。無いときは null */
		getAttribute: (name: string) => string | null;
		/** 属性を記録する */
		setAttribute: (name: string, value: string) => void;
		/** 属性を外す */
		removeAttribute: (name: string) => void;
	};
	/** body のクラス操作 */
	body: {
		/** 付いているクラスの集合 */
		classList: {
			/** クラスを足す */
			add: (name: string) => void;
			/** クラスを外す */
			remove: (...names: string[]) => void;
			/** クラスが付いていれば true */
			contains: (name: string) => boolean;
		};
	};
};

/**
 * テーマ反映テスト用の簡易 DOM モックを生成する
 * @returns クラスと属性を記録する document モック
 */
function createThemeDom(): ThemeDom {
	const htmlAttrs   = new Map<string, string>();
	const bodyClasses = new Set<string>();

	return {
		documentElement: {
			/**
			 * html 属性を取得する
			 * @param name - 属性名
			 * @returns 記録した値。無いときは null
			 */
			getAttribute: (name) => htmlAttrs.get(name) ?? null,
			/**
			 * html 属性を設定する
			 * @param name - 属性名
			 * @param value - 記録する値
			 */
			setAttribute: (name, value) => {
				htmlAttrs.set(name, value);
			},
			/**
			 * html 属性を削除する
			 * @param name - 外す属性名
			 */
			removeAttribute: (name) => {
				htmlAttrs.delete(name);
			},
		},
		body: {
			classList: {
				/**
				 * body にクラスを追加する
				 * @param name - 追加するクラス名
				 */
				add: (name) => {
					bodyClasses.add(name);
				},
				/**
				 * body からクラスを削除する
				 * @param names - 外すクラス名。複数指定できる
				 */
				remove: (...names) => {
					for (const name of names) {
						bodyClasses.delete(name);
					}
				},
				/**
				 * body が指定クラスを持つか判定する
				 * @param name - 調べるクラス名
				 * @returns 付いていれば true
				 */
				contains: (name) => bodyClasses.has(name),
			},
		},
	};
}

describe('theme', () => {
	let dom: ThemeDom;
	let prefersDark = false;

	beforeEach(() => {
		dom         = createThemeDom();
		prefersDark = false;
		vi.stubGlobal('document', dom);
		vi.stubGlobal('window', {
			/**
			 * prefers-color-scheme のモックを返す
			 * @returns OS がダークなら matches が true
			 */
			matchMedia: () => ({ matches: prefersDark }),
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('applyTheme(dark) は body にダーククラスを付ける', () => {
		applyTheme('dark');
		expect(dom.body.classList.contains('tms-mde-theme-dark')).toBe(true);
	});

	it('applyTheme(light) は body にライトクラスを付ける', () => {
		applyTheme('light');
		expect(dom.body.classList.contains('tms-mde-theme-light')).toBe(true);
	});

	it('applyTheme(system) は OS ダーク時に data-os-theme を付ける', () => {
		prefersDark = true;
		applyTheme('system');
		expect(dom.body.classList.contains('tms-mde-theme-dark')).toBe(false);
		expect(dom.documentElement.getAttribute('data-os-theme')).toBe('dark');
	});

	it('syncOsThemeAttribute は OS ライト時に data-os-theme を外す', () => {
		dom.documentElement.setAttribute('data-os-theme', 'dark');
		syncOsThemeAttribute();
		expect(dom.documentElement.getAttribute('data-os-theme')).toBeNull();
	});
});
