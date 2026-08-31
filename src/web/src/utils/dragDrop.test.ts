import { describe, expect, it } from 'vitest';
import { isFileDrag } from './dragDrop';

describe('dragDrop utils', () => {
	it('detects file drag from dataTransfer types', () => {
		expect(isFileDrag({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
		expect(isFileDrag({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
		expect(isFileDrag(null)).toBe(false);
	});
});
