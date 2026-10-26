/**
 * キャレット正規化が、行末のクランプ、assoc、goalColumn、IME 中のスキップを守ることを検証する
 * エディタの描画は持たず、EditorState 上の選択だけを見る
 * @file
 */
import { EditorState, EditorSelection } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { normalizeCaretRange, normalizeCaretSelection } from './caretNormalize';

describe('caretNormalize', () => {
	it('行末を超える head を当該行の line.to にクランプする', () => {
		// 1 行だけの文書。行末より右の head を戻す
		const state = EditorState.create({ doc: 'abc' });
		// クランプ先の行。1 始まり
		const line  = state.doc.line(1);
		// 行末より 10 文字右。文書内には無い位置
		const bad   = EditorSelection.cursor(line.to + 10);
		// クランプ後の範囲。head は line.to、assoc は -1
		const next  = normalizeCaretRange(state, bad);

		expect(next?.head).toBe(line.to);
		expect(next?.assoc).toBe(-1);
	});

	it('行末キャレットは assoc=-1（EOL マーカーより左）にする', () => {
		// 2 行の文書。1 行目の行末が対象
		const state  = EditorState.create({ doc: 'heading\nnext' });
		// 行末を見る行。次の行には動かない
		const line   = state.doc.line(1);
		// 行末にいるが assoc が 1。マーカーより右に見える側
		const atEnd  = EditorSelection.cursor(line.to, 1);
		// 正規化後。不要なら null
		const next   = normalizeCaretRange(state, atEnd);
		// next が null のときは入力のまま比べる。このケースでは null にならない
		const result = next ?? atEnd;

		expect(result.head).toBe(line.to);
		expect(result.assoc).toBe(-1);
	});

	it('goalColumn は短行でも保持する（縦移動の列記憶）', () => {
		// 2 文字の短行。画面上の列 40 は行末を超える
		const state = EditorState.create({ doc: 'ab' });
		// 行末の位置を取る行
		const line  = state.doc.line(1);
		// 行末キャレットに列記憶 40 を付けた選択。assoc は既に -1
		const wide  = EditorSelection.cursor(line.to, -1, undefined, 40);
		// 変更が無ければ null。列記憶を消す更新はしない
		const next  = normalizeCaretRange(state, wide);

		expect(next).toBeNull();
		expect(wide.goalColumn).toBe(40);
	});

	it('normalizeCaretSelection は変更不要なら null', () => {
		// 行の途中で assoc が -1 のキャレット。正規化の対象外
		const state = EditorState.create({
			// 1 行の本文
			doc: 'abc',
			// 2 文字目。行末でも行頭でもない
			selection: EditorSelection.cursor(1, -1)
		});
		expect(normalizeCaretSelection(state)).toBeNull();
	});

	it('IME composition 中は行頭キャレットを正規化しない', () => {
		// 空文書の行頭。assoc が -1 でも、IME 中は直さない
		const state = EditorState.create({
			// 空の本文。行頭と行末が同じ位置
			doc: '',
			// 行頭なのに assoc が -1。IME でなければ 1 へ戻す
			selection: EditorSelection.cursor(0, -1)
		});

		// 第 2 引数 true は IME 中。補正しない
		expect(normalizeCaretSelection(state, true)).toBeNull();
		expect(normalizeCaretSelection(state)?.main.assoc).toBe(1);
	});
});
