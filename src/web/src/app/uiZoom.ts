/**
 * 画面全体の表示倍率を保持し、ホイールとキーボードから変える
 * 設定ファイルへの保存は持たず、変更は登録したリスナーへ通知する
 * @file
 */

/** UI ズームの下限。0.5 は 50% */
// prettier-ignore
const UI_ZOOM_MIN  = 0.5;

/** UI ズームの上限。3 は 300% */
// prettier-ignore
const UI_ZOOM_MAX  = 3;

/** ホイールとキーボードで増減する刻み。0.1 は 10 パーセントポイント */
const UI_ZOOM_STEP = 0.1;

/** 現在の UI ズーム。1 は 100%。実行中は `setUiZoom` が更新する */
let uiZoom = 1;

/**
 * ズームが変わったときに呼ぶ関数
 * 引数は変更後の倍率で、1 が 100%
 */
type UiZoomChangeListener = (zoom: number) => void;

/** 現在の変更リスナー。未登録は null。`bindUiZoom` が差し替える */
let changeListener: UiZoomChangeListener | null = null;

/**
 * UI ズーム倍率をパーセント表記に変換する
 * 小数は四捨五入し、単位の `%` を付ける
 * @param zoom - 倍率。1 が 100%
 * @returns `100%` のような表示文字列
 */
export function formatUiZoomPercent(zoom: number): string {
	return `${Math.round(zoom * 100)}%`;
}

/**
 * 現在の UI ズーム倍率を返す
 * @returns 倍率。1 が 100%。初期値は 1
 */
export function getUiZoom(): number {
	return uiZoom;
}

/**
 * ベースフォントサイズに UI ズームを掛けた px 値を返す
 * 結果は小数第 1 位へ四捨五入する
 * @param baseFontSize - 設定上のエディタフォントサイズ。単位は px
 * @param zoom - 掛ける倍率。省略時は現在の UI ズーム
 * @returns ズーム後のフォントサイズ。単位は px
 */
export function computeZoomedFontSize(baseFontSize: number, zoom: number = uiZoom): number {
	return Math.round(baseFontSize * zoom * 10) / 10;
}

/**
 * UI ズーム倍率を範囲内へ収め、小数第 1 位に丸めて設定する
 * 値が変わらなければリスナーは呼ばない。通知は呼び出し側が行う
 * @param next - 設定したい倍率。範囲外は 0.5〜3 に収める
 * @returns 倍率を変えた場合 true
 */
export function setUiZoom(next: number): boolean {
	// 0.5〜3 に収め、小数第 1 位へ丸めた倍率。現在値と同じなら状態は変えない
	const clamped = Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, Math.round(next * 10) / 10));
	// 丸めた結果が現在と同じときはリスナーを呼ばせず false を返す。範囲外から丸めて同じ値になったときも入る
	if (clamped === uiZoom) {
		return false;
	}

	uiZoom = clamped;
	return true;
}

/**
 * UI ズーム倍率を現在値から増減する
 * 範囲と丸めは `setUiZoom` に従う。リスナーは呼ばない
 * @param delta - 増減量。正が増、負が減。通常は `UI_ZOOM_STEP`
 * @returns 倍率を変えた場合 true
 */
export function adjustUiZoom(delta: number): boolean {
	return setUiZoom(uiZoom + delta);
}

/**
 * 登録済みリスナーへ現在の倍率を渡す
 * リスナーが無いときは何もしない
 */
function notifyUiZoomChange(): void {
	changeListener?.(uiZoom);
}

// prettier-ignore
/**
 * ズームインのキーか判定する
 * Ctrl があり Alt が無いときの `+`、`Add`、`=`。Shift の有無は見ない
 * @param event - 判定するキーイベント
 * @returns ズームインなら true
 */
export function isUiZoomInKey(event: KeyboardEvent): boolean {
	// Ctrl が無い、または Alt があるときはズームインにしない。どちらか一方だけでも対象外
	if (!event.ctrlKey || event.altKey) {
		return false;
	}

	return event.key === '+'
		|| event.key === 'Add'
		|| event.key === '=';
}

// prettier-ignore
/**
 * ズームアウトのキーか判定する
 * Ctrl があり Alt も Shift も無いときの `-`、`Subtract`、`_`
 * @param event - 判定するキーイベント
 * @returns ズームアウトなら true
 */
export function isUiZoomOutKey(event: KeyboardEvent): boolean {
	// Ctrl が無い、Alt がある、Shift がある、のどれかならズームアウトにしない。一つでもあれば対象外
	if (!event.ctrlKey || event.altKey || event.shiftKey) {
		return false;
	}

	return event.key === '-'
		|| event.key === 'Subtract'
		|| event.key === '_';
}

// prettier-ignore
/**
 * ズームを 100% に戻すキーか判定する
 * Ctrl があり Alt も Shift も無いときの `0`
 * @param event - 判定するキーイベント
 * @returns リセットなら true
 */
export function isUiZoomResetKey(event: KeyboardEvent): boolean {
	return event.ctrlKey
		&& !event.altKey
		&& !event.shiftKey
		&& event.key === '0';
}

/**
 * UI ズームを 100% に戻す
 * すでに 100% ならリスナーは呼ばない
 */
export function resetUiZoom(): void {
	// 100% へ変えられたときだけリスナーへ通知する。すでに 100% なら通知しない
	if (setUiZoom(1)) {
		notifyUiZoomChange();
	}
}

// prettier-ignore
/**
 * Ctrl+ホイールと変更通知を登録する
 * リスナーは 1 つだけ保持し、呼ぶたびに置き換える。ホイールリスナーは解除しない
 * @param onChange - 倍率変更時に現在値を受け取る関数。省略時は通知しない
 */
export function bindUiZoom(onChange?: UiZoomChangeListener): void {
	// ----- リスナーの差し替え -----

	changeListener = onChange ?? null;
	notifyUiZoomChange();

	// ----- Ctrl+ホイール -----

	// Ctrl+ホイールで倍率を変える。Ctrl が無いときは何もせず、ページのスクロールを残す
	window.addEventListener('wheel', (event) => {
		// Ctrl が無いホイールはズームにしない。preventDefault も呼ばない
		if (!event.ctrlKey) {
			return;
		}

		event.preventDefault();
		// ホイール上方向（deltaY が負）は拡大、それ以外は縮小。1 段は 0.1。deltaY が 0 のときも縮小
		const delta = event.deltaY < 0 ? UI_ZOOM_STEP : -UI_ZOOM_STEP;
		// 上下限の内側で倍率を変えられたときだけ通知する。端で値が変わらなければ通知しない
		if (adjustUiZoom(delta)) {
			notifyUiZoomChange();
		}
	},
	// ホイールリスナーの登録オプション。既定の Ctrl+ホイールを止められるようにする
	{
		// false 固定。passive だと preventDefault が無視され、ブラウザのズームを止められない
		passive: false
	});
}

/**
 * キーボードによる UI ズームを処理する
 * 対象キーなら既定動作を止め、変えたときだけリスナーを呼ぶ。リセットはすでに 100% でも処理済みとする
 * @param event - キーイベント。対象なら `preventDefault` する
 * @returns ズーム操作として処理した場合 true
 */
export function handleUiZoomKeydown(event: KeyboardEvent): boolean {
	// キーに対応する増減量。拡大は 0.1、縮小は -0.1。リセットと対象外ではこの 0 を使わずに戻る
	let delta = 0;
	// ズームインのキーのときだけ 0.1 増やす。Ctrl 無しや Alt 付きはここに入らない
	if (isUiZoomInKey(event)) {
		// 拡大の 1 段。倍率 0.1
		delta = UI_ZOOM_STEP;
	}
	// ズームアウトのキーだけ 0.1 減らす。ズームインに入らなかったキーだけを見る
	else if (isUiZoomOutKey(event)) {
		// 縮小の 1 段。倍率 -0.1
		delta = -UI_ZOOM_STEP;
	}
	// 100% へ戻すキーだけ既定動作を止める。インでもアウトでもないキーだけを見る。すでに 100% でも処理済みにする
	else if (isUiZoomResetKey(event)) {
		event.preventDefault();
		// 100% へ変えられたときだけ通知する。すでに 100% なら通知せず、このキーは処理済み
		if (setUiZoom(1)) {
			notifyUiZoomChange();
		}

		return true;
	} else {
		return false;
	}

	event.preventDefault();
	// 増減の結果が上下限の内側で変わったときだけ通知する。端に張り付いていれば通知しない
	if (adjustUiZoom(delta)) {
		notifyUiZoomChange();
	}

	return true;
}

export { UI_ZOOM_MIN, UI_ZOOM_MAX, UI_ZOOM_STEP };
