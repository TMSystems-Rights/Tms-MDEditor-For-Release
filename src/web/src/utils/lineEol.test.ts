import { describe, expect, it } from 'vitest';
import {
	createUniformLineEols,
	reconstructWithLineEols,
	splitPreservingEol,
	syncLineEols,
	toCm6Text,
} from './lineEol';

describe('lineEol utils', () => {
	it('roundtrips mixed eol with そのまま保存 semantics', () => {
		const original = '# test\n\nあああ\nいいい\nううう\n\n\nああああ\r\n\r\na\r\n';
		const split    = splitPreservingEol(original);
		const cm6Text  = toCm6Text(split.lines, split.eols);
		const restored = reconstructWithLineEols(cm6Text, split.eols, 'lf');

		expect(restored).toBe(original);
		expect(split.eols).toEqual([
			'lf', 'lf', 'lf', 'lf', 'lf', 'lf', 'lf', 'crlf', 'crlf', 'crlf',
		]);
	});

	it('keeps line eols by index when only text changes', () => {
		const original  = 'a\r\nb\nc\r\n';
		const split     = splitPreservingEol(original);
		const cm6Before = toCm6Text(split.lines, split.eols);
		const cm6After  = 'A\nb\nc\n';
		const synced    = syncLineEols(split.eols, cm6Before, cm6After, 'lf');
		const restored  = reconstructWithLineEols(cm6After, synced, 'lf');

		expect(restored).toBe('A\r\nb\nc\r\n');
	});

	it('uses fallback eol for newly inserted lines', () => {
		const original  = 'a\r\nc\r\n';
		const split     = splitPreservingEol(original);
		const cm6Before = toCm6Text(split.lines, split.eols);
		const cm6After  = 'a\nb\nc\n';
		const synced    = syncLineEols(split.eols, cm6Before, cm6After, 'lf');
		const restored  = reconstructWithLineEols(cm6After, synced, 'lf');

		expect(restored).toBe('a\r\nb\nc\r\n');
	});

	it('creates uniform eol map for unify save', () => {
		const cm6Text = 'a\nb\n';
		const eols    = createUniformLineEols(cm6Text, 'crlf');
		expect(reconstructWithLineEols(cm6Text, eols, 'crlf')).toBe('a\r\nb\r\n');
	});
});
