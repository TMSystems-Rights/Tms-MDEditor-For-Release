/**
 * 行ごとの改行種別をエディタ状態へ載せ、行装飾の class として描く
 * 改行種別の検出は呼び出し側が行い、本ファイルは渡された配列を状態と装飾へ反映する
 * 記号そのものは CSS 疑似要素が描き、本文 DOM へゼロ幅ウィジェットは置かない
 * @file
 */
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import {
	type EditorState,
	type Extension,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from '@codemirror/state';
import type { EolKind } from '../types/app';

// ==============================================
// 行単位 EOL マップ
// ==============================================

/**
 * 行単位の EOL マップをエディタ状態へ反映する Effect
 * 値は行番号順の配列。該当行に改行が無いときは null
 */
export const setLineEolsEffect = StateEffect.define<Array<EolKind | null>>();

/**
 * エディタ状態に保持する行単位 EOL マップ
 * インデックスは行番号から 1 を引いた位置。未設定の行は null
 */
export const lineEolsField = StateField.define<Array<EolKind | null>>({
	/**
	 * マップの初期値を空配列にする
	 * 実データは init か setLineEolsEffect で後から入る
	 * @returns 行がまだ無いときの空配列
	 */
	create() {
		return [];
	},
	/**
	 * setLineEolsEffect があれば、その配列でマップを置き換える
	 * 無ければ編集ではマップを変えない
	 * @param value - 更新前の行単位 EOL。Effect が無いときはこのまま返す
	 * @param transaction - 今回のトランザクション。effects だけを見る
	 * @returns 置き換え後のマップ。Effect が無いときは value
	 */
	update(value, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setLineEolsEffect)) {
				return effect.value;
			}
		}

		return value;
	},
});

// ==============================================
// 行装飾
// ==============================================

/**
 * EOL 種別を、行装飾用の CSS class 文字列へ変換する
 * @param eol - 行の改行種別。class 名の接尾辞にそのまま使う
 * @returns 共通 class と種別 class を空白区切りで並べた文字列
 */
function eolToMarkerClass(eol: EolKind): string {
	return `cm-eol-marker-line cm-eol-marker-${eol}`;
}

/**
 * 行に改行コードマーカーの Decoration を構築する
 * 本文 DOM へゼロ幅ウィジェットを置かず、CSS 疑似要素で記号を描画する
 * @param state - 行装飾の対象文書。lineEolsField が無いときはマーカーを付けない
 * @returns 改行がある行だけの行装飾。改行が無い文書は空
 */
function buildEolDecorations(state: EditorState): DecorationSet {
	const lineEols  = state.field(lineEolsField, false) ?? [];
	const builder   = new RangeSetBuilder<Decoration>();
	const lineCount = state.doc.lines;

	for (let lineNumber = 1; lineNumber <= lineCount; lineNumber += 1) {
		const eol = lineEols[lineNumber - 1] ?? null;
		if (!eol) {
			continue;
		}

		const line = state.doc.line(lineNumber);
		builder.add(
			line.from,
			line.from,
			Decoration.line({ class: eolToMarkerClass(eol) }),
		);
	}

	return builder.finish();
}

/**
 * 改行コード表示用の行装飾
 * EOL マップが変わったときだけ作り直し、通常の編集では既存の装飾を差分へ追従させる
 */
export const eolMarkersField = StateField.define<DecorationSet>({
	/**
	 * 初期の行装飾を、現在の EOL マップから作る
	 * @param state - 初期文書
	 * @returns 開いた直後の行装飾
	 */
	create(state) {
		return buildEolDecorations(state);
	},
	/**
	 * EOL マップの更新時だけ装飾を作り直し、通常の編集では既存の行装飾を変更範囲へ追従させる
	 * 作り直すと装飾オブジェクトの同一性が変わり、入力のたびに行装飾が入れ替わる
	 * @param value - 更新前の装飾
	 * @param transaction - 今回のトランザクション。EOL Effect の有無と文書差分に使う
	 * @returns 作り直した装飾、または差分へ追従させた既存の装飾
	 */
	update(value, transaction) {
		const lineEolsChanged = transaction.effects.some((effect) => effect.is(setLineEolsEffect));
		if (lineEolsChanged) {
			return buildEolDecorations(transaction.state);
		}

		return value.map(transaction.changes);
	},
	/**
	 * 行装飾をエディタの decorations として公開する
	 * @param field - 装飾を保持する StateField
	 * @returns EditorView.decorations へ渡す Extension
	 */
	provide: (field) => EditorView.decorations.from(field),
});

// ==============================================
// 拡張の生成
// ==============================================

/**
 * 改行コード表示の Extension を返す
 * @param initialLineEols - 初期の行単位 EOL。行番号順。呼び出し後に配列を変更しても、状態へはコピー済みの内容だけが残る
 * @returns マップの初期化と行装飾を含む Extension の配列
 */
export function createEolMarkerExtensions(initialLineEols: Array<EolKind | null>): Extension[] {
	return [
		lineEolsField.init(() => [...initialLineEols]),
		eolMarkersField,
	];
}
