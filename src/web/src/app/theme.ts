/**
 * エディタの明暗を body のクラスと html の OS 属性へ反映する
 * 設定の保存は持たず、渡されたテーマ文字列と OS の配色だけを見る
 * @file
 */

/**
 * テーマの選択値
 * `system` は OS の配色に追従し、`dark` と `light` は body のクラスで固定する
 */
export type ThemeMode = 'system' | 'dark' | 'light';

/** body に付けるダーク固定クラス。ライト固定クラスとは同時に付けない */
// prettier-ignore
const THEME_CLASS_DARK  = 'tms-mde-theme-dark';

/** body に付けるライト固定クラス。ダーク固定クラスとは同時に付けない */
const THEME_CLASS_LIGHT = 'tms-mde-theme-light';

/** html に付ける OS テーマ属性名。`system` のときだけ値を書く */
// prettier-ignore
const OS_THEME_ATTR     = 'data-os-theme';

/** `OS_THEME_ATTR` のダーク値。ライトのときは属性自体を外す */
// prettier-ignore
const OS_THEME_DARK     = 'dark';

/** 適用中のテーマ。OS 変更の追従判定に使う。初期値は `system` で、実行中は `applyTheme` が更新する */
let currentTheme: ThemeMode = 'system';

/**
 * OS のダークモード設定を html の `data-os-theme` へ反映する
 * ダークなら属性を付け、ライトなら属性を外す。body の固定クラスは変えない
 */
export function syncOsThemeAttribute(): void {
	// OS テーマ属性を書く html 要素。body の固定クラスとは別
	const root = document.documentElement;
	// OS がダークのときだけ data-os-theme を dark にする。ライトのときは属性を外し、light という値は残さない
	if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
		root.setAttribute(OS_THEME_ATTR, OS_THEME_DARK);
		return;
	}

	root.removeAttribute(OS_THEME_ATTR);
}

/**
 * 初回描画前に OS テーマ属性を同期する
 * 反映内容は `syncOsThemeAttribute` と同じで、起動時に一度だけ呼ぶ入口である
 */
export function initOsThemeAttribute(): void {
	syncOsThemeAttribute();
}

/**
 * テーマ設定を body のクラスと html の OS 属性へ反映する
 * `dark` と `light` 以外は `system` として扱い、直前の固定クラスは外してから付け直す
 * @param theme - 設定のテーマ文字列。未知の値は `system` にする
 */
// prettier-ignore
export function applyTheme(theme: string): void {
	// body に反映するテーマ。dark と light 以外は system。OS 追従の判定用に currentTheme へも入れる
	const mode: ThemeMode = theme === 'dark' || theme === 'light' ? theme : 'system';
	currentTheme          = mode;

	document.body.classList.remove(THEME_CLASS_DARK, THEME_CLASS_LIGHT);

	// ダーク固定のときだけダーククラスを付ける。light と system はこの分岐に入らない
	if (mode === 'dark') {
		document.body.classList.add(THEME_CLASS_DARK);
	}
	// ライト固定のときだけライトクラスを付ける。system はどちらのクラスも付けない
	else if (mode === 'light') {
		document.body.classList.add(THEME_CLASS_LIGHT);
	}

	syncOsThemeAttribute();
}

/**
 * OS の配色変更を、`system` 選択中だけ html 属性へ追従させる
 * リスナーは window に残し、解除しない
 */
export function bindThemePreferenceListener(): void {
	// OS の配色が変わったとき、system のときだけ html 属性を追従させる。リスナーは外さない
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
		// 固定の dark か light のときは属性を追従させない。system 以外はここで戻る
		if (currentTheme !== 'system') {
			return;
		}

		syncOsThemeAttribute();
	});
}
