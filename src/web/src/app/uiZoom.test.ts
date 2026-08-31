import { describe, expect, it, beforeEach } from 'vitest';
import {
	adjustUiZoom,
	computeZoomedFontSize,
	formatUiZoomPercent,
	getUiZoom,
	handleUiZoomKeydown,
	isUiZoomInKey,
	isUiZoomOutKey,
	setUiZoom,
	UI_ZOOM_MAX,
	UI_ZOOM_MIN,
} from './uiZoom';

describe('uiZoom', () => {
	beforeEach(() => {
		setUiZoom(1);
	});

	it('setUiZoom は範囲内にクランプする', () => {
		expect(setUiZoom(UI_ZOOM_MIN - 0.5)).toBe(true);
		expect(getUiZoom()).toBe(UI_ZOOM_MIN);

		expect(setUiZoom(UI_ZOOM_MAX + 1)).toBe(true);
		expect(getUiZoom()).toBe(UI_ZOOM_MAX);
	});

	it('adjustUiZoom は 0.1 刻みで増減する', () => {
		expect(adjustUiZoom(0.1)).toBe(true);
		expect(getUiZoom()).toBe(1.1);
	});

	it('computeZoomedFontSize はベースサイズに倍率を掛ける', () => {
		setUiZoom(1.2);
		expect(computeZoomedFontSize(15)).toBe(18);
	});

	it('formatUiZoomPercent はパーセント表記を返す', () => {
		expect(formatUiZoomPercent(1)).toBe('100%');
		expect(formatUiZoomPercent(1.1)).toBe('110%');
		expect(formatUiZoomPercent(0.5)).toBe('50%');
	});

	it('isUiZoomInKey / isUiZoomOutKey を判定する', () => {
		expect(isUiZoomInKey({ ctrlKey: true, altKey: false, key: '=' } as KeyboardEvent)).toBe(true);
		expect(isUiZoomOutKey({ ctrlKey: true, altKey: false, key: '-' } as KeyboardEvent)).toBe(true);
		expect(isUiZoomOutKey({
			ctrlKey : true,
			altKey  : false,
			shiftKey: true,
			key     : '_',
		} as KeyboardEvent)).toBe(false);
	});

	it('handleUiZoomKeydown は Ctrl+= でズームインする', () => {
		const event = {
			ctrlKey : true,
			altKey  : false,
			shiftKey: false,
			key     : '=',
			/**
			 * 既定のキー処理を抑止する（テスト用スタブ）
			 * @returns {void}
			 */
			preventDefault() {},
		} as KeyboardEvent;

		expect(handleUiZoomKeydown(event)).toBe(true);
		expect(getUiZoom()).toBe(1.1);
	});
});
