/**
 * 分割ビューの比率と、ペイン間で本文変更だけを写すトランザクションを作る
 * ペインの木構造は持たない
 * @file
 */
import { Annotation, EditorState, Transaction } from '@codemirror/state';

/**
 * 分割の向き
 * `horizontal` は上下、`vertical` は左右
 */
export type SplitDirection = 'horizontal' | 'vertical';

/**
 * 同期で作ったトランザクションであることを示す印
 * true のトランザクションは、相手ペインへ再送しない
 */
export const splitSynchronization = Annotation.define<boolean>();

/** 分割比率の下限。これより狭いペインは作らない */
const MIN_SPLIT_RATIO = 0.2;

/** 分割比率の上限。先のペインがこの値を超えない */
const MAX_SPLIT_RATIO = 0.8;

/**
 * 境界位置を安全な分割比率へ変換する
 * 容器の寸法が有限かつ正でないときは 0.5 を返す
 * @param pointerPosition - ポインターの座標。`containerStart` と同じ軸
 * @param containerStart - 容器の開始座標。同じ軸
 * @param containerSize - 容器の寸法。0 以下や非数は中央比率になる
 * @returns 0.2〜0.8 の分割比率。先のペインが占める割合
 */
export function calculateSplitRatio(pointerPosition: number, containerStart: number, containerSize: number): number {
	// 寸法が有限でない、または 0 以下。比率が定義できないので中央にする
	if (!Number.isFinite(containerSize) || containerSize <= 0) {
		return 0.5;
	}

	// 容器開始からの位置を寸法で割った割合。この直後で 0.2〜0.8 に切る
	const ratio = (pointerPosition - containerStart) / containerSize;
	return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/**
 * 同期元トランザクションの本文変更を別ペイン用トランザクションへ変換する
 * 選択は写さず、履歴にも残さない。本文が変わっていなければ null
 * @param source - 同期元のトランザクション。本文変更が無いものは写さない
 * @param targetState - 同期先の現在状態。この状態に対する更新を返す
 * @returns 本文変更を写したトランザクション。本文変更が無いときは null
 */
export function createSynchronizedTransaction(source: Transaction, targetState: EditorState): Transaction | null {
	// 本文が変わっていない同期は、相手ペインへ写さない
	if (!source.docChanged) {
		return null;
	}

	// 相手ペインの本文だけを更新する。選択は写さない
	return targetState.update({
		// 同期元と同じ本文差分
		changes: source.changes,
		// 再送を止める印と、履歴へ残さない印。片方だけだと分割がループするか undo に載る
		annotations: [splitSynchronization.of(true), Transaction.addToHistory.of(false)]
	});
}
