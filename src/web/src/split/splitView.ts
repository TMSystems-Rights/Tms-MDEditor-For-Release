import { Annotation, EditorState, Transaction } from '@codemirror/state';

export type SplitDirection = 'horizontal' | 'vertical';

export const splitSynchronization = Annotation.define<boolean>();

const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

/**
 * 境界位置を安全な分割比率へ変換する
 * @param {number} pointerPosition ポインターの座標
 * @param {number} containerStart コンテナー開始座標
 * @param {number} containerSize コンテナー寸法
 * @returns {number} 0.2〜0.8 の分割比率
 */
export function calculateSplitRatio(
	pointerPosition: number,
	containerStart: number,
	containerSize: number,
): number {
	if (!Number.isFinite(containerSize) || containerSize <= 0) {
		return 0.5;
	}

	const ratio = (pointerPosition - containerStart) / containerSize;
	return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

/**
 * 同期元トランザクションの本文変更を別ペイン用トランザクションへ変換する
 * @param {Transaction} source 同期元トランザクション
 * @param {EditorState} targetState 同期先の現在状態
 * @returns {Transaction | null} 本文変更がない場合 null
 */
export function createSynchronizedTransaction(
	source: Transaction,
	targetState: EditorState,
): Transaction | null {
	if (!source.docChanged) {
		return null;
	}

	return targetState.update({
		changes: source.changes,
		annotations: [
			splitSynchronization.of(true),
			Transaction.addToHistory.of(false),
		],
	});
}
