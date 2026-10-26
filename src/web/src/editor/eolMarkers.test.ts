/**
 * 改行マーカーの行装飾が、通常編集では同一オブジェクトを保ち、マップ更新時だけ入れ替わることを検証する
 * 画面への描画は持たず、DecorationSet の範囲と同一性だけを見る
 * @file
 */
import { EditorState } from '@codemirror/state';
import { type Decoration, type DecorationSet } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createEolMarkerExtensions, eolMarkersField, setLineEolsEffect } from './eolMarkers';

/**
 * テストが比較する行装飾の範囲
 * 本番の Decoration そのものではなく、between で取り出した位置とオブジェクトだけを持つ
 */
type DecorationRange = {
	/** 装飾先頭の文書オフセット（含む） */
	from: number;
	/** 装飾末尾の文書オフセット（含まない） */
	to: number;
	/** 比較する装飾オブジェクト。通常編集では更新前と同一である */
	value: Decoration;
};

/**
 * DecorationSet を、文書全体の範囲配列へ展開する
 * @param decorations - 展開する装飾集合
 * @param length - 文書長。0 からこの位置までを between の範囲にする
 * @returns 出現順の装飾範囲。装飾が無いときは空配列
 */
function collectDecorations(decorations: DecorationSet, length: number): DecorationRange[] {
	// between が渡す範囲を出現順に積む。装飾が無いときは空のまま
	const result: DecorationRange[] = [];
	decorations.between(0, length, (from, to, value) => {
		// 比較用に位置と装飾オブジェクトだけを残す
		result.push({
			// 装飾先頭。文書オフセットで、この位置を含む
			from,
			// 装飾末尾。文書オフセットで、この位置は含まない
			to,
			// 同一性を見る装飾。通常編集では更新前後で同じオブジェクト
			value
		});
	});
	return result;
}

describe('eolMarkers', () => {
	it('通常の本文入力では行末 Decoration を再生成せずマップする', () => {
		// 空行だけの文書。行末マーカーを 1 つ付ける
		const initial = EditorState.create({
			// 改行 1 つ。マーカーの対象行
			doc: '\n',
			// 行末種別に CRLF を置いた拡張。描画はしない
			extensions: createEolMarkerExtensions(['crlf'])
		});
		// 入力前の装飾。通常編集ではこのオブジェクトが残る
		const before  = collectDecorations(initial.field(eolMarkersField), initial.doc.length);
		// 先頭へ 1 文字足したあとの状態。行末種別の更新は含まない
		const next    = initial.update({
			// 本文だけの変更。行末マップの effect は含めない
			changes: {
				// 挿入位置。文書先頭で、範囲の置換ではない
				from: 0,
				// 足す 1 文字。行は増えない
				insert: 'k'
			}
		}).state;
		// マップ後の装飾。before と value が同一であることを見る
		const after   = collectDecorations(next.field(eolMarkersField), next.doc.length);

		expect(before).toHaveLength(1);
		expect(after).toHaveLength(1);
		expect(after[0].from).toBe(0);
		expect(after[0].value).toBe(before[0].value);
	});

	it('行末マップの更新時はウィジェットを再構築する', () => {
		// 1 文字と改行。行末種別を差し替える前の文書
		const initial = EditorState.create({
			// 1 行だけの本文
			doc: 'a\n',
			// 更新前の行末種別。CRLF
			extensions: createEolMarkerExtensions(['crlf'])
		});
		// 差し替え前の装飾。更新後は別オブジェクトになる
		const before  = collectDecorations(initial.field(eolMarkersField), initial.doc.length);
		// 行末種別だけを LF へ更新した状態。本文は変えない
		const next    = initial.update({ effects: setLineEolsEffect.of(['lf']) }).state;
		// 再構築後の装飾。before と value が異なることを見る
		const after   = collectDecorations(next.field(eolMarkersField), next.doc.length);

		expect(after).toHaveLength(1);
		expect(after[0].value).not.toBe(before[0].value);
	});
});
