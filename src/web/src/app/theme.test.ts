import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { applyTheme, syncOsThemeAttribute } from './theme';

type ThemeDom = {
	documentElement: {
		getAttribute: (name: string) => string | null;
		setAttribute: (name: string, value: string) => void;
		removeAttribute: (name: string) => void;
	};
	body: {
		classList: {
			add: (name: string) => void;
			remove: (...names: string[]) => void;
			contains: (name: string) => boolean;
		};
	};
};

/**
 * テーマ反映テスト用の簡易 DOM モックを生成する
 * @returns {ThemeDom}
 */
function createThemeDom(): ThemeDom {
	const htmlAttrs   = new Map<string, string>();
	const bodyClasses = new Set<string>();

	return {
		documentElement: {
			/**
			 * html 属性を取得する
			 * @param {string} name 属性名
			 * @returns {string | null}
			 */
			getAttribute: (name) => htmlAttrs.get(name) ?? null,
			/**
			 * html 属性を設定する
			 * @param {string} name 属性名
			 * @param {string} value 属性値
			 * @returns {void}
			 */
			setAttribute: (name, value) => {
				htmlAttrs.set(name, value);
			},
			/**
			 * html 属性を削除する
			 * @param {string} name 属性名
			 * @returns {void}
			 */
			removeAttribute: (name) => {
				htmlAttrs.delete(name);
			},
		},
		body: {
			classList: {
				/**
				 * body にクラスを追加する
				 * @param {string} name クラス名
				 * @returns {void}
				 */
				add: (name) => {
					bodyClasses.add(name);
				},
				/**
				 * body からクラスを削除する
				 * @param {...string} names クラス名
				 * @returns {void}
				 */
				remove: (...names) => {
					for (const name of names) {
						bodyClasses.delete(name);
					}
				},
				/**
				 * body が指定クラスを持つか判定する
				 * @param {string} name クラス名
				 * @returns {boolean}
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
			 * @returns {{ matches: boolean }}
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
