const UI_ZOOM_MIN  = 0.5;
const UI_ZOOM_MAX  = 3;
const UI_ZOOM_STEP = 0.1;

let uiZoom = 1;

type UiZoomChangeListener = (zoom: number) => void;

let changeListener: UiZoomChangeListener | null = null;

/**
 * UI ズーム倍率をパーセント表記に変換する
 * @param {number} zoom 倍率
 * @returns {string}
 */
export function formatUiZoomPercent(zoom: number): string {
	return `${Math.round(zoom * 100)}%`;
}

/**
 * 現在の UI ズーム倍率を返す
 * @returns {number}
 */
export function getUiZoom(): number {
	return uiZoom;
}

/**
 * ベースフォントサイズに UI ズームを適用した px 値を返す
 * @param {number} baseFontSize 設定上のエディタフォントサイズ
 * @param {number | undefined} zoom 倍率（省略時は現在値）
 * @returns {number}
 */
export function computeZoomedFontSize(baseFontSize: number, zoom: number = uiZoom): number {
	return Math.round(baseFontSize * zoom * 10) / 10;
}

/**
 * UI ズーム倍率をクランプして設定する
 * @param {number} next 倍率
 * @returns {boolean} 変更があった場合 true
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
 * UI ズーム倍率を増減する
 * @param {number} delta 増減量
 * @returns {boolean} 変更があった場合 true
 */
export function adjustUiZoom(delta: number): boolean {
	return setUiZoom(uiZoom + delta);
}

/**
 * UI ズーム変更を通知する
 * @returns {void}
 */
function notifyUiZoomChange(): void {
	changeListener?.(uiZoom);
}

/**
 * ズームイン操作か判定する
 * @param {KeyboardEvent} event キーイベント
 * @returns {boolean}
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
 * ズームアウト操作か判定する
 * @param {KeyboardEvent} event キーイベント
 * @returns {boolean}
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
 * ズームリセット操作か判定する
 * @param {KeyboardEvent} event キーイベント
 * @returns {boolean}
 */
export function isUiZoomResetKey(event: KeyboardEvent): boolean {
	return event.ctrlKey
		&& !event.altKey
		&& !event.shiftKey
		&& event.key === '0';
}

/**
 * UI ズームを 100% に戻す
 * @returns {void}
 */
export function resetUiZoom(): void {
	if (setUiZoom(1)) {
		notifyUiZoomChange();
	}
}

/**
 * Ctrl+ホイール / Ctrl+± による UI ズームを登録する
 * @param {UiZoomChangeListener | undefined} onChange 倍率変更時のコールバック
 * @returns {void}
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
 * @param {KeyboardEvent} event キーイベント
 * @returns {boolean} 処理した場合 true
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
