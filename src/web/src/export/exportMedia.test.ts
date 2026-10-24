/**
 * PDF と印刷の画像ファイル名を検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { exportMediaFileName, rememberExportMedia, type ExportMediaFile } from './exportMedia';

describe('rememberExportMedia', () => {
	it('連番と拡張子の相対パスを返す', () => {
		const media: ExportMediaFile[] = [];
		expect(rememberExportMedia(media, 'E:\\vault\\図.png')).toBe('media/1.png');
		expect(rememberExportMedia(media, 'E:\\vault\\次.jpg')).toBe('media/2.jpg');
		expect(media).toEqual([
			{ name: '1.png', sourcePath: 'E:\\vault\\図.png' },
			{ name: '2.jpg', sourcePath: 'E:\\vault\\次.jpg' },
		]);
	});

	it('同じ絶対パスは 1 枚にまとめる', () => {
		const media: ExportMediaFile[] = [];
		expect(rememberExportMedia(media, 'E:\\vault\\図.png')).toBe('media/1.png');
		expect(rememberExportMedia(media, 'E:\\vault\\図.png')).toBe('media/1.png');
		expect(media).toHaveLength(1);
	});

	it('未対応の拡張子は一覧へ加えない', () => {
		const media: ExportMediaFile[] = [];
		expect(rememberExportMedia(media, 'E:\\vault\\note.md')).toBeNull();
		expect(media).toEqual([]);
	});
});

describe('exportMediaFileName', () => {
	it('0 以下の連番は名前にしない', () => {
		expect(exportMediaFileName(0, 'a.png')).toBeNull();
	});
});
