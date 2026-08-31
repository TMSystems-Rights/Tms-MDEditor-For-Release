import { describe, expect, it } from 'vitest';
import { analyzeEol, buildTabTitle, buildWindowTitle, formatEolLabel, isLargeFile, normalizeEol } from './format';

describe('format utils', () => {
	it('builds tab title from file path', () => {
		expect(buildTabTitle('C:\\docs\\sample.md')).toBe('sample.md');
		expect(buildTabTitle(null)).toBe('無題');
	});

	it('builds window title with dirty mark', () => {
		expect(buildWindowTitle('sample.md', true)).toBe('*sample.md - TMS-MDEditor');
		expect(buildWindowTitle('sample.md', false)).toBe('sample.md - TMS-MDEditor');
	});

	it('builds window title from full path when available', () => {
		expect(buildWindowTitle('sample.md', false, 'C:\\docs\\sample.md')).toBe('C:\\docs\\sample.md - TMS-MDEditor');
		expect(buildWindowTitle('sample.md', true, 'C:\\docs\\sample.md')).toBe('*C:\\docs\\sample.md - TMS-MDEditor');
	});

	it('formats mixed eol label', () => {
		expect(formatEolLabel('crlf', true)).toBe('CRLF(混在)');
	});

	it('normalizes mixed eol to lf', () => {
		expect(normalizeEol('a\r\nb\nc', 'lf')).toBe('a\nb\nc');
	});

	it('detects large file by threshold', () => {
		expect(isLargeFile(2_112_033, 2 * 1024 * 1024)).toBe(true);
		expect(isLargeFile(undefined, 2 * 1024 * 1024)).toBe(false);
	});

	it('detects mixed eol', () => {
		expect(analyzeEol('a\r\nb\nc')).toEqual({
			primary: 'crlf',
			mixed  : true,
		});
	});
});
