import { describe, expect, it } from 'vitest';
import { resolveTableMaxWidth } from './tableMaxWidth';

describe('表の最大幅', () => {
	it('表示中の編集領域から余白を引いた幅になる', () => {
		expect(resolveTableMaxWidth({
			visibleRight   : 800,
			contentLeft    : 120,
			scrollLeft     : 0,
			horizontalInset: 16,
		})).toBe(664);
	});

	it('横スクロールしても表示幅は変わらない', () => {
		const atStart  = resolveTableMaxWidth({
			visibleRight   : 800,
			contentLeft    : 120,
			scrollLeft     : 0,
			horizontalInset: 16,
		});
		const scrolled = resolveTableMaxWidth({
			visibleRight   : 800,
			contentLeft    : 40,
			scrollLeft     : 80,
			horizontalInset: 16,
		});
		expect(scrolled).toBe(atStart);
	});

	it('端数は切り下げ、負の幅は 0 にする', () => {
		expect(resolveTableMaxWidth({
			visibleRight   : 200.9,
			contentLeft    : 10,
			scrollLeft     : 0,
			horizontalInset: 0.2,
		})).toBe(190);
		expect(resolveTableMaxWidth({
			visibleRight   : 10,
			contentLeft    : 40,
			scrollLeft     : 0,
			horizontalInset: 8,
		})).toBe(0);
	});
});
