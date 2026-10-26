/**
 * コールアウトの折りたたみ上書きを、blockquote 開始位置をキーにエディタ状態へ保持する
 * 永続化はせず、記法の既定値との合成は isCalloutCollapsed が行う
 * @file
 */
import { StateEffect, StateField } from '@codemirror/state';

/**
 * 1件のコールアウトについて、折りたたみを上書きする StateEffect
 * value.from は blockquote の開始位置、value.collapsed は折りたたみ中なら true
 */
export const setCalloutFoldEffect = StateEffect.define<{ from: number; collapsed: boolean }>();

/**
 * コールアウト開始位置から折りたたみ上書きへの対応
 * ドキュメント変更時は位置を mapPos で追従し、上書きが無い位置は記法の既定に任せる
 */
export const calloutFoldField = StateField.define<Map<number, boolean>>({
	/**
	 * 上書きの無い空の対応表を返す
	 * @returns 開始位置をキーにする Map。初期は空
	 */
	create() {
		return new Map();
	},
	/**
	 * 文書変更で位置を追従し、同じトランザクションの上書き Effect を反映する
	 * 変化が無ければ元の Map を返す
	 * @param value - 更新前の上書き。キーは blockquote 開始位置
	 * @param transaction - 文書変更と setCalloutFoldEffect を含むトランザクション
	 * @returns 追従と上書きを反映した Map。変化が無ければ value
	 */
	update(value, transaction) {
		// 追従または上書きを反映する対応表。変化が無ければ null のままで、元の Map を返す
		let next: Map<number, boolean> | null = null;

		// ----- 文書変更の位置追従 -----
		// 文書が変わったときだけ開始位置を追従する。変わっていなければ既存のキーを維持する
		if (transaction.docChanged) {
			next = new Map();
			for (const [from, collapsed] of value) {
				next.set(transaction.changes.mapPos(from, 1), collapsed);
			}
		}

		// ----- 折りたたみ上書きの反映 -----
		for (const effect of transaction.effects) {
			// 折りたたみ上書き以外の Effect は対応表を変えない
			if (!effect.is(setCalloutFoldEffect)) {
				continue;
			}

			// 文書変更が無く、最初の上書きを受けるときだけ元の Map をコピーする。既にコピー済みなら作り直さない
			if (!next) {
				next = new Map(value);
			}

			next.set(effect.value.from, effect.value.collapsed);
		}

		return next ?? value;
	}
});

/**
 * 折りたたみ中かを、ユーザ上書き、無ければ記法の既定から決める
 * foldDefault が none のときは上書きを見ず、常に展開とする
 * @param overrides - 開始位置から折りたたみ上書きへの対応。calloutFoldField の値
 * @param calloutFrom - 対象コールアウトの blockquote 開始位置
 * @param foldDefault - 記法上の既定。none は折りたためない
 * @returns 折りたたみ中なら true。none は常に false
 */
export function isCalloutCollapsed(overrides: Map<number, boolean>, calloutFrom: number, foldDefault: 'none' | 'collapsed' | 'expanded'): boolean {
	// 記法が折りたたみ不可なら上書きを見ない。常に展開とする
	if (foldDefault === 'none') {
		return false;
	}

	// ユーザ上書きがある位置だけその値を使う。無い位置は記法の既定へ進む
	if (overrides.has(calloutFrom)) {
		return overrides.get(calloutFrom) === true;
	}

	return foldDefault === 'collapsed';
}
