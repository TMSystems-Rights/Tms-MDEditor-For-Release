/**
 * 混在する行末を保ったまま、編集後の本文へマップを合わせることを確認する
 * @file
 */
import { describe, expect, it } from 'vitest';
import { areLineEolsEqual, createUniformLineEols, reconstructWithLineEols, splitPreservingEol, syncLineEols, toCm6Text } from './lineEol';

describe('lineEol utils', () => {
	it('行末マップの内容を比較する', () => {
		expect(areLineEolsEqual(['crlf', null], ['crlf', null])).toBe(true);
		expect(areLineEolsEqual(['crlf', null], ['lf', null])).toBe(false);
		expect(areLineEolsEqual(['crlf'], ['crlf', null])).toBe(false);
	});

	it('roundtrips mixed eol with そのまま保存 semantics', () => {
		// LF と CRLF が混ざる本文。往復でこの文字列へ戻る
		const original = '# test\n\nあああ\nいいい\nううう\n\n\nああああ\r\n\r\na\r\n';
		// 行本文と行末種別を分けた結果。行末は配列で残す
		const split    = splitPreservingEol(original);
		// CodeMirror へ渡す LF 統一の本文
		const cm6Text  = toCm6Text(split.lines, split.eols);
		// 行末マップを戻して組み立てた本文。original と一致する
		const restored = reconstructWithLineEols(cm6Text, split.eols, 'lf');

		expect(restored).toBe(original);
		expect(split.eols).toEqual(['lf', 'lf', 'lf', 'lf', 'lf', 'lf', 'lf', 'crlf', 'crlf', 'crlf']);
	});

	it('keeps line eols by index when only text changes', () => {
		// 行末が CRLF、LF、CRLF の 3 行。本文だけを変える
		const original  = 'a\r\nb\nc\r\n';
		// 編集前の行末マップ
		const split     = splitPreservingEol(original);
		// 編集前の LF 本文。行の対応を取る基準
		const cm6Before = toCm6Text(split.lines, split.eols);
		// 1 行目の文字だけを変えた LF 本文。行数は同じ
		const cm6After  = 'A\nb\nc\n';
		// 行数が変わらないので、元の行末種別を行番号で残す
		const synced    = syncLineEols(split.eols, cm6Before, cm6After, 'lf');
		// 残した行末で組み立てた本文。1 行目だけ大文字
		const restored  = reconstructWithLineEols(cm6After, synced, 'lf');

		expect(restored).toBe('A\r\nb\nc\r\n');
	});

	it('改行が変わらない本文編集では既存の行末マップを再利用する', () => {
		// 再利用できる行末マップ。2 行目は改行を持たない
		const previousEols = ['crlf', null] as const;
		// 1 行目の先頭へ文字を足しただけ。行末の並びは変わらない
		const synced       = syncLineEols([...previousEols], 'a\nb', 'ka\nb', 'lf');

		expect(synced).toEqual(previousEols);
		expect(syncLineEols(synced, 'ka\nb', 'か\nb', 'lf')).toBe(synced);
	});

	it('uses fallback eol for newly inserted lines', () => {
		// 2 行とも CRLF。間に 1 行足す
		const original  = 'a\r\nc\r\n';
		// 編集前の行末マップ。2 件とも crlf
		const split     = splitPreservingEol(original);
		// 編集前の LF 本文
		const cm6Before = toCm6Text(split.lines, split.eols);
		// 中間に b の行を足した LF 本文。新しい行の行末はフォールバック
		const cm6After  = 'a\nb\nc\n';
		// 既存行は crlf のまま、挿入行だけ lf
		const synced    = syncLineEols(split.eols, cm6Before, cm6After, 'lf');
		// 挿入行だけ LF、既存行は CRLF の本文
		const restored  = reconstructWithLineEols(cm6After, synced, 'lf');

		expect(restored).toBe('a\r\nb\nc\r\n');
	});

	it('creates uniform eol map for unify save', () => {
		// 統一保存の対象。行末はまだ LF
		const cm6Text = 'a\nb\n';
		// 全行を CRLF にした行末マップ。行数は本文の行数
		const eols    = createUniformLineEols(cm6Text, 'crlf');
		expect(reconstructWithLineEols(cm6Text, eols, 'crlf')).toBe('a\r\nb\r\n');
	});
});
