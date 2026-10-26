/**
 * PDF と印刷の画像ファイル名を検証する
 * @file
 */

import { describe, expect, it } from 'vitest';
import { exportMediaFileName, rememberExportMedia, type ExportMediaFile } from './exportMedia';

describe('rememberExportMedia', () => {
	it('連番と拡張子の相対パスを返す', () => {
		// まだ 1 枚も無い書き出し一覧。呼び出しごとに末尾へ増える
		const media: ExportMediaFile[] = [];
		expect(rememberExportMedia(media, 'E:\\vault\\図.png')).toBe('media/1.png');
		expect(rememberExportMedia(media, 'E:\\vault\\次.jpg')).toBe('media/2.jpg');
		expect(media).toEqual([
			// 1 枚目。連番は 1 から
			{
				// 書き出しファイル名。拡張子は元の png
				name: '1.png',
				// 取り込む絶対パス。相対パスにはしない
				sourcePath: 'E:\\vault\\図.png'
			},
			// 2 枚目。別パスなので連番が進む
			{
				// 書き出しファイル名。拡張子は元の jpg
				name: '2.jpg',
				// 取り込む絶対パス
				sourcePath: 'E:\\vault\\次.jpg'
			}
		]);
	});

	it('同じ絶対パスは 1 枚にまとめる', () => {
		// 同じパスを 2 回渡す一覧。件数は 1 のまま
		const media: ExportMediaFile[] = [];
		expect(rememberExportMedia(media, 'E:\\vault\\図.png')).toBe('media/1.png');
		expect(rememberExportMedia(media, 'E:\\vault\\図.png')).toBe('media/1.png');
		expect(media).toHaveLength(1);
	});

	it('未対応の拡張子は一覧へ加えない', () => {
		// Markdown は画像ではない。一覧は空のまま
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
