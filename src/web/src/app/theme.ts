export type ThemeMode = 'system' | 'dark' | 'light';

const THEME_CLASS_DARK  = 'tms-mde-theme-dark';
const THEME_CLASS_LIGHT = 'tms-mde-theme-light';
const OS_THEME_ATTR     = 'data-os-theme';
const OS_THEME_DARK     = 'dark';

let currentTheme: ThemeMode = 'system';

/**
 * OS のダークモード設定を html 属性へ反映する（system 用）
 * @returns {void}
 */
export function syncOsThemeAttribute(): void {
	const root = document.documentElement;
	if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
		root.setAttribute(OS_THEME_ATTR, OS_THEME_DARK);
		return;
	}

	root.removeAttribute(OS_THEME_ATTR);
}

/**
 * 初回描画前用に OS テーマ属性を同期する
 * @returns {void}
 */
export function initOsThemeAttribute(): void {
	syncOsThemeAttribute();
}

/**
 * テーマ設定を body / html へ反映する
 * @param {string} theme テーマ設定
 * @returns {void}
 */
export function applyTheme(theme: string): void {
	const mode: ThemeMode = theme === 'dark' || theme === 'light' ? theme : 'system';
	currentTheme          = mode;

	document.body.classList.remove(THEME_CLASS_DARK, THEME_CLASS_LIGHT);

	if (mode === 'dark') {
		document.body.classList.add(THEME_CLASS_DARK);
	} else if (mode === 'light') {
		document.body.classList.add(THEME_CLASS_LIGHT);
	}

	syncOsThemeAttribute();
}

/**
 * system 選択時に OS テーマ変更を追従する
 * @returns {void}
 */
export function bindThemePreferenceListener(): void {
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
		if (currentTheme !== 'system') {
			return;
		}

		syncOsThemeAttribute();
	});
}
