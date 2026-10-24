/**
 * 画面全体の表示倍率を保持し、ホイールとキーボードから変える
 * 設定ファイルへの保存は持たず、変更は登録したリスナーへ通知する
 * @file
 */

/** UI ズームの下限。0.5 は 50% */
const UI_ZOOM_MIN  = 0.5;

/** UI ズームの上限。3 は 300% */
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
	const clamped = Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, Math.round(next * 10) / 10));
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

/**
 * ズームインのキーか判定する
 * Ctrl があり Alt が無いときの `+`、`Add`、`=`。Shift の有無は見ない
 * @param event - 判定するキーイベント
 * @returns ズームインなら true
 */
export function isUiZoomInKey(event: KeyboardEvent): boolean {
	if (!event.ctrlKey || event.altKey) {
		return false;
	}

	return event.key === '+'
		|| event.key === 'Add'
		|| event.key === '=';
}

/**
 * ズームアウトのキーか判定する
 * Ctrl があり Alt も Shift も無いときの `-`、`Subtract`、`_`
 * @param event - 判定するキーイベント
 * @returns ズームアウトなら true
 */
export function isUiZoomOutKey(event: KeyboardEvent): boolean {
	if (!event.ctrlKey || event.altKey || event.shiftKey) {
		return false;
	}

	return event.key === '-'
		|| event.key === 'Subtract'
		|| event.key === '_';
}

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
	if (setUiZoom(1)) {
		notifyUiZoomChange();
	}
}

/**
 * Ctrl+ホイールと変更通知を登録する
 * リスナーは 1 つだけ保持し、呼ぶたびに置き換える。ホイールリスナーは解除しない
 * @param onChange - 倍率変更時に現在値を受け取る関数。省略時は通知しない
 */
export function bindUiZoom(onChange?: UiZoomChangeListener): void {
	changeListener = onChange ?? null;
	notifyUiZoomChange();

	window.addEventListener('wheel', (event) => {
		if (!event.ctrlKey) {
			return;
		}

		event.preventDefault();
		const delta = event.deltaY < 0 ? UI_ZOOM_STEP : -UI_ZOOM_STEP;
		if (adjustUiZoom(delta)) {
			notifyUiZoomChange();
		}
	}, { passive: false });
}

/**
 * キーボードによる UI ズームを処理する
 * 対象キーなら既定動作を止め、変えたときだけリスナーを呼ぶ。リセットはすでに 100% でも処理済みとする
 * @param event - キーイベント。対象なら `preventDefault` する
 * @returns ズーム操作として処理した場合 true
 */
export function handleUiZoomKeydown(event: KeyboardEvent): boolean {
	let delta = 0;
	if (isUiZoomInKey(event)) {
		delta = UI_ZOOM_STEP;
	} else if (isUiZoomOutKey(event)) {
		delta = -UI_ZOOM_STEP;
	} else if (isUiZoomResetKey(event)) {
		event.preventDefault();
		if (setUiZoom(1)) {
			notifyUiZoomChange();
		}

		return true;
	} else {
		return false;
	}

	event.preventDefault();
	if (adjustUiZoom(delta)) {
		notifyUiZoomChange();
	}

	return true;
}

export { UI_ZOOM_MIN, UI_ZOOM_MAX, UI_ZOOM_STEP };
