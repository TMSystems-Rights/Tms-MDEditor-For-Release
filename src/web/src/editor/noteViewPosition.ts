import type { EditorView } from '@codemirror/view';

export const NOTE_VIEW_POSITION_SCHEMA_VERSION = 1;

/** 保存するノート数の上限。古い記録から捨てる。 */
export const NOTE_VIEW_POSITION_LIMIT = 200;

const RESTORE_LIMIT_MS      = 4000;
const RESTORE_MIN_TRACK_MS  = 1500;
const RESTORE_STABLE_FRAMES = 8;

const noteViewScrollMeasureKey = {};

/**
 * ノートの表示位置。
 * anchor はビューポート上端にある行塊の文書オフセット。
 * yMargin は「行塊上端 - scrollTop」（CodeMirror の scrollSnapshot と同じ）。
 */
export type NoteViewPosition = {
	anchor: number;
	yMargin: number;
	scrollLeft: number;
	selectionAnchor: number;
	selectionHead: number;
};

export type NoteViewPositionRecord = NoteViewPosition & {
	filePath: string;
	updatedAt: string;
};

export type NoteViewPositionDocument = {
	schemaVersion: typeof NOTE_VIEW_POSITION_SCHEMA_VERSION;
	entries: NoteViewPositionRecord[];
};

type NoteViewScrollMeasure = {
	targetTop: number;
	scrollLeft: number;
	layoutReady: boolean;
} | null;

type ScrollLineBlock = {
	from: number;
	top: number;
	to: number;
	bottom: number;
};

/**
 * 文書長へ収まるオフセットへ切り詰める。
 * @param {number} offset オフセット
 * @param {number} docLength 文書長
 * @returns {number} 0 以上 docLength 以下の整数
 */
export function clampNoteViewOffset(offset: number, docLength: number): number {
	if (!Number.isFinite(offset) || !Number.isFinite(docLength)) return 0;
	return Math.min(Math.max(0, docLength), Math.max(0, Math.trunc(offset)));
}

/**
 * パス比較用のキーを返す。区切りと大文字小文字の差を吸収する。
 * @param {string} filePath ファイルパス
 * @returns {string} 比較キー
 */
export function noteViewPositionKey(filePath: string): string {
	return filePath.trim().replaceAll('/', '\\').toLowerCase();
}

/**
 * 行塊座標から保存用の表示位置を作る。
 * @param {object} input 計測値
 * @param {number} input.scrollTop 縦スクロール
 * @param {number} input.scrollLeft 横スクロール
 * @param {number} input.blockFrom 上端行塊の開始オフセット
 * @param {number} input.blockTop 上端行塊の文書上端
 * @param {number} input.selectionAnchor 選択アンカー
 * @param {number} input.selectionHead 選択ヘッド
 * @param {number} input.docLength 文書長
 * @returns {NoteViewPosition} 表示位置
 */
export function captureNoteViewPositionFromMetrics(input: {
	scrollTop: number;
	scrollLeft: number;
	blockFrom: number;
	blockTop: number;
	selectionAnchor: number;
	selectionHead: number;
	docLength: number;
}): NoteViewPosition {
	const scrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0;
	const blockTop  = Number.isFinite(input.blockTop) ? input.blockTop : 0;
	return {
		anchor         : clampNoteViewOffset(input.blockFrom, input.docLength),
		yMargin        : blockTop - scrollTop,
		scrollLeft     : Number.isFinite(input.scrollLeft) ? Math.max(0, input.scrollLeft) : 0,
		selectionAnchor: clampNoteViewOffset(input.selectionAnchor, input.docLength),
		selectionHead  : clampNoteViewOffset(input.selectionHead, input.docLength),
	};
}

/**
 * 高さマップから、scrollTop を含む行塊を探す。
 * `lineBlockAtHeight` は未実行の計測をその場で走らせるため使わない。
 * @param {EditorView} view エディタ
 * @param {number} scrollTop 縦スクロール
 * @returns {ScrollLineBlock | null} 行塊。高さマップが scrollTop に届いていなければ null
 */
export function findLineBlockAtScrollTop(view: EditorView, scrollTop: number): ScrollLineBlock | null {
	const docLength = view.state.doc.length;
	const origin    = view.lineBlockAt(0);
	if (scrollTop <= origin.top) return origin;

	let low   = 0;
	let high  = docLength;
	let best  = origin;
	let guard = 0;
	while (low <= high && guard < 64) {
		guard      += 1;
		const mid   = Math.min(docLength, Math.max(0, Math.floor((low + high) / 2)));
		const block = view.lineBlockAt(mid);
		if (block.top <= scrollTop) {
			best       = block;
			const next = Math.max(block.to + 1, mid + 1);
			if (next > high) break;
			low = next;
		} else {
			const prev = Math.min(block.from - 1, mid - 1);
			if (prev < low) break;
			high = prev;
		}
	}

	const covers = best.top <= scrollTop && scrollTop < best.bottom;
	const isLast = best.to >= docLength;
	if (!covers && !isLast) return null;
	return best;
}

/**
 * マウント中のエディタから表示位置を読む。
 * @param {EditorView} view エディタ
 * @returns {NoteViewPosition | null} 読めなければ null
 */
export function captureNoteViewPosition(view: EditorView): NoteViewPosition | null {
	const scroller = view.scrollDOM;
	if (!scroller.isConnected) return null;
	const scrollTop = scroller.scrollTop;
	const block     = findLineBlockAtScrollTop(view, scrollTop);
	if (!block) return null;
	const selection = view.state.selection.main;
	return captureNoteViewPositionFromMetrics({
		scrollTop,
		scrollLeft     : scroller.scrollLeft,
		blockFrom      : block.from,
		blockTop       : block.top,
		selectionAnchor: selection.anchor,
		selectionHead  : selection.head,
		docLength      : view.state.doc.length,
	});
}

/**
 * 保存した行アンカーを、現在のレイアウトでの scrollTop へ変換する。
 * @param {number} blockTop 行塊上端
 * @param {number} yMargin 保存時の行上端とスクロール上端の差
 * @param {number} maxScrollTop スクロール可能な最大値
 * @returns {number} scrollTop
 */
export function computeRestoredScrollTop(blockTop: number, yMargin: number, maxScrollTop: number): number {
	const target = restoredScrollRawTarget(blockTop, yMargin);
	const max    = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
	return Math.min(max, Math.max(0, target));
}

/**
 * 保存位置が、いま測れている文書高の中に収まっているかを返す。
 * 収まっていないあいだに追従を終えると、先頭や途中の高さで止まってキャレットも描けない。
 * @param {number} blockTop 行塊上端
 * @param {number} yMargin 保存時の行上端とスクロール上端の差
 * @param {number} maxScrollTop スクロール可能な最大値
 * @returns {boolean} 収まるなら true
 */
export function isRestoredScrollLayoutReady(blockTop: number, yMargin: number, maxScrollTop: number): boolean {
	const max = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
	return restoredScrollRawTarget(blockTop, yMargin) <= max + 1;
}

/**
 * 範囲へ切り詰める前の scrollTop を返す。
 * @param {number} blockTop 行塊上端
 * @param {number} yMargin 保存時の行上端とスクロール上端の差
 * @returns {number} scrollTop
 */
function restoredScrollRawTarget(blockTop: number, yMargin: number): number {
	return (Number.isFinite(blockTop) ? blockTop : 0) - (Number.isFinite(yMargin) ? yMargin : 0);
}

/**
 * 保存位置から、新しい文書へ収まる選択範囲を返す。
 * @param {NoteViewPosition} position 表示位置
 * @param {number} docLength 文書長
 * @returns {{ anchor: number, head: number }} 選択範囲
 */
export function selectionFromNoteViewPosition(position: NoteViewPosition, docLength: number): { anchor: number; head: number } {
	return {
		anchor: clampNoteViewOffset(position.selectionAnchor, docLength),
		head  : clampNoteViewOffset(position.selectionHead, docLength),
	};
}

/**
 * 外部 JSON を検証し、新しい記録を優先して上限内へ正規化する。
 * @param {unknown} value 外部 JSON
 * @returns {NoteViewPositionRecord[]} 記録
 */
export function normalizeNoteViewPositionDocument(value: unknown): NoteViewPositionRecord[] {
	if (!isRecord(value) || value.schemaVersion !== NOTE_VIEW_POSITION_SCHEMA_VERSION || !Array.isArray(value.entries)) return [];
	return mergeNoteViewPositionRecords([], value.entries.flatMap((entry) => {
		const record = normalizeNoteViewPositionRecord(entry);
		return record ? [record] : [];
	}));
}

/**
 * 更新時刻が新しい方を残してマージし、上限を超えた古い記録を捨てる。
 * @param {NoteViewPositionRecord[]} current 既存
 * @param {NoteViewPositionRecord[]} incoming 追加分
 * @param {number} [limit] 上限
 * @returns {NoteViewPositionRecord[]} マージ結果
 */
export function mergeNoteViewPositionRecords(
	current: readonly NoteViewPositionRecord[],
	incoming: readonly NoteViewPositionRecord[],
	limit = NOTE_VIEW_POSITION_LIMIT,
): NoteViewPositionRecord[] {
	const byKey = new Map<string, NoteViewPositionRecord>();
	for (const record of current) byKey.set(noteViewPositionKey(record.filePath), record);
	for (const record of incoming) {
		const key      = noteViewPositionKey(record.filePath);
		const existing = byKey.get(key);
		if (!existing || record.updatedAt >= existing.updatedAt) byKey.set(key, record);
	}
	return trimNoteViewPositionRecords([...byKey.values()], limit);
}

/**
 * 更新が新しい順に上限件数へ切る。
 * @param {NoteViewPositionRecord[]} records 記録
 * @param {number} [limit] 上限
 * @returns {NoteViewPositionRecord[]} 残す記録
 */
export function trimNoteViewPositionRecords(records: readonly NoteViewPositionRecord[], limit = NOTE_VIEW_POSITION_LIMIT): NoteViewPositionRecord[] {
	return [...records].sort((left, right) => {
		if (left.updatedAt === right.updatedAt) return 0;
		return left.updatedAt < right.updatedAt ? 1 : -1;
	}).slice(0, Math.max(0, limit));
}

/**
 * プロセス内の表示位置表。
 */
export class NoteViewPositionMemory {
	private readonly entries = new Map<string, NoteViewPositionRecord>();

	/**
	 * 正規化済みの記録で表を置き換える。
	 * @param {NoteViewPositionRecord[]} records 記録
	 * @returns {void}
	 */
	public replace(records: readonly NoteViewPositionRecord[]): void {
		this.entries.clear();
		for (const record of mergeNoteViewPositionRecords([], records)) {
			this.entries.set(noteViewPositionKey(record.filePath), record);
		}
	}

	/**
	 * パスに対応する表示位置を返す。
	 * @param {string} filePath ファイルパス
	 * @returns {NoteViewPosition | null} 無ければ null
	 */
	public get(filePath: string): NoteViewPosition | null {
		const record = this.entries.get(noteViewPositionKey(filePath));
		if (!record) return null;
		return {
			anchor         : record.anchor,
			yMargin        : record.yMargin,
			scrollLeft     : record.scrollLeft,
			selectionAnchor: record.selectionAnchor,
			selectionHead  : record.selectionHead,
		};
	}

	/**
	 * 表示位置を記録し、上限を超えた古いパスを捨てる。
	 * @param {string} filePath ファイルパス
	 * @param {NoteViewPosition} position 表示位置
	 * @param {string} [updatedAt] 更新時刻
	 * @returns {void}
	 */
	public remember(filePath: string, position: NoteViewPosition, updatedAt = new Date().toISOString()): void {
		const trimmed = filePath.trim();
		if (!trimmed) return;
		this.entries.set(noteViewPositionKey(trimmed), {
			filePath: trimmed,
			updatedAt,
			anchor         : position.anchor,
			yMargin        : position.yMargin,
			scrollLeft     : position.scrollLeft,
			selectionAnchor: position.selectionAnchor,
			selectionHead  : position.selectionHead,
		});
		const kept = trimNoteViewPositionRecords([...this.entries.values()]);
		this.entries.clear();
		for (const record of kept) this.entries.set(noteViewPositionKey(record.filePath), record);
	}

	/**
	 * 保存用ドキュメントを返す。
	 * @returns {NoteViewPositionDocument} ドキュメント
	 */
	public toDocument(): NoteViewPositionDocument {
		return {
			schemaVersion: NOTE_VIEW_POSITION_SCHEMA_VERSION,
			entries      : trimNoteViewPositionRecords([...this.entries.values()]),
		};
	}
}

/**
 * 行高が確定するまで、保存した行アンカーへスクロールを追従させる。
 * ユーザー操作が始まったら追従を終える。
 * @param {EditorView} view エディタ
 * @param {NoteViewPosition} position 表示位置
 * @param {(applied: boolean) => void} onSettled 追従終了時。行高が揃った位置まで戻せたら true
 * @param {() => void} [onLayoutReady] 目標位置が現在の文書高に収まった最初のフレーム
 * @returns {void}
 */
export function restoreNoteViewScroll(
	view: EditorView,
	position: NoteViewPosition,
	onSettled: (applied: boolean) => void,
	onLayoutReady?: () => void,
): void {
	const scroller = view.scrollDOM;
	if (!scroller.isConnected) {
		onSettled(false);
		return;
	}

	let settled             = false;
	let appliedOnce         = false;
	let stableFrames        = 0;
	let lastTarget          = Number.NaN;
	let lastHeight          = Number.NaN;
	let layoutReadyNotified = false;
	const startedAt         = Date.now();

	/**
	 * 追従を終えて購読を外す。
	 * @returns {void}
	 */
	const settle = (): void => {
		if (settled) return;
		settled = true;
		window.clearTimeout(timeoutId);
		scroller.removeEventListener('wheel', onUserScroll, true);
		scroller.removeEventListener('pointerdown', onUserScroll, true);
		view.contentDOM.removeEventListener('keydown', onKeydown, true);
		onSettled(appliedOnce);
	};

	/**
	 * ユーザーのスクロール操作で追従をやめる。
	 * @returns {void}
	 */
	const onUserScroll = (): void => {
		settle();
	};

	/**
	 * 文字入力や移動キーで追従をやめる。修飾キーだけではやめない。
	 * @param {KeyboardEvent} event キー
	 * @returns {void}
	 */
	const onKeydown = (event: KeyboardEvent): void => {
		if (!appliedOnce) return;
		if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') return;
		const movesCaret = event.key === 'ArrowUp'
			|| event.key === 'ArrowDown'
			|| event.key === 'ArrowLeft'
			|| event.key === 'ArrowRight'
			|| event.key === 'PageUp'
			|| event.key === 'PageDown'
			|| event.key === 'Home'
			|| event.key === 'End'
			|| event.key === ' ';
		if ((event.ctrlKey || event.metaKey || event.altKey) && !movesCaret) return;
		settle();
	};

	scroller.addEventListener('wheel', onUserScroll, true);
	scroller.addEventListener('pointerdown', onUserScroll, true);
	view.contentDOM.addEventListener('keydown', onKeydown, true);
	const timeoutId = window.setTimeout(settle, RESTORE_LIMIT_MS);

	/**
	 * 現在の行高でスクロールを合わせ、安定するまで繰り返す。
	 * @returns {void}
	 */
	const step = (): void => {
		if (settled || !scroller.isConnected) {
			settle();
			return;
		}
		if (Date.now() - startedAt >= RESTORE_LIMIT_MS) {
			settle();
			return;
		}

		view.requestMeasure<NoteViewScrollMeasure>({
			key: noteViewScrollMeasureKey,
			/**
			 * 目標 scrollTop を計測する。
			 * @param {EditorView} measuredView エディタ
			 * @returns {NoteViewScrollMeasure} 計測値
			 */
			read(measuredView) {
				const measuredScroller = measuredView.scrollDOM;
				if (!measuredScroller.isConnected || measuredScroller.clientHeight <= 0) return null;
				const anchor      = clampNoteViewOffset(position.anchor, measuredView.state.doc.length);
				const block       = measuredView.lineBlockAt(anchor);
				const maxScroll   = Math.max(0, measuredScroller.scrollHeight - measuredScroller.clientHeight);
				const layoutReady = isRestoredScrollLayoutReady(block.top, position.yMargin, maxScroll);
				// 行高が未確定のあいだ、文書途中のアンカーが先頭へ潰れる。確定するまで待って、先頭を保存しない。
				if (!layoutReady && anchor > 0 && block.top <= 0 && maxScroll <= 1) return null;
				return {
					targetTop : computeRestoredScrollTop(block.top, position.yMargin, maxScroll),
					scrollLeft: Math.max(0, position.scrollLeft),
					layoutReady,
				};
			},
			/**
			 * 計測値をスクロールへ反映する。
			 * @param {NoteViewScrollMeasure} measure 計測値
			 * @param {EditorView} measuredView エディタ
			 * @returns {void}
			 */
			write(measure, measuredView) {
				if (settled || !measuredView.scrollDOM.isConnected) return;
				if (!measure) {
					window.requestAnimationFrame(step);
					return;
				}

				const currentTop    = measuredView.scrollDOM.scrollTop;
				const currentLeft   = measuredView.scrollDOM.scrollLeft;
				const currentHeight = measuredView.scrollDOM.scrollHeight;
				const sameTop       = Math.abs(currentTop - measure.targetTop) <= 1;
				const sameLeft      = Math.abs(currentLeft - measure.scrollLeft) <= 1;
				if (!sameTop || !sameLeft) {
					measuredView.scrollDOM.scrollTop  = measure.targetTop;
					measuredView.scrollDOM.scrollLeft = measure.scrollLeft;
				}

				const unchanged       = Math.abs(measure.targetTop - lastTarget) <= 1;
				const heightUnchanged = Math.abs(currentHeight - lastHeight) <= 1;
				stableFrames          = measure.layoutReady && sameTop && sameLeft && unchanged && heightUnchanged
					? stableFrames + 1
					: 0;
				lastTarget            = measure.targetTop;
				lastHeight            = currentHeight;
				if (measure.layoutReady) {
					appliedOnce = true;
					if (!layoutReadyNotified) {
						layoutReadyNotified = true;
						window.requestAnimationFrame(() => {
							if (!settled) onLayoutReady?.();
						});
					}
				}
				const trackedLongEnough = Date.now() - startedAt >= RESTORE_MIN_TRACK_MS;
				if (trackedLongEnough && stableFrames >= RESTORE_STABLE_FRAMES) {
					settle();
					return;
				}
				window.requestAnimationFrame(step);
			},
		});
	};

	step();
}

/**
 *
 * @param {unknown} value 候補
 * @returns {NoteViewPositionRecord | null} 記録
 */
function normalizeNoteViewPositionRecord(value: unknown): NoteViewPositionRecord | null {
	if (!isRecord(value) || !isNonEmptyString(value.filePath) || !isNonEmptyString(value.updatedAt)) return null;
	if (!isFiniteNumber(value.anchor) || value.anchor < 0) return null;
	if (!isFiniteNumber(value.yMargin)) return null;
	if (!isFiniteNumber(value.scrollLeft) || value.scrollLeft < 0) return null;
	if (!isFiniteNumber(value.selectionAnchor) || value.selectionAnchor < 0) return null;
	if (!isFiniteNumber(value.selectionHead) || value.selectionHead < 0) return null;
	return {
		filePath       : value.filePath.trim(),
		updatedAt      : value.updatedAt,
		anchor         : Math.trunc(value.anchor),
		yMargin        : value.yMargin,
		scrollLeft     : value.scrollLeft,
		selectionAnchor: Math.trunc(value.selectionAnchor),
		selectionHead  : Math.trunc(value.selectionHead),
	};
}

/**
 *
 * @param {unknown} value 値
 * @returns {value is number} 有限数なら true
 */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 *
 * @param {unknown} value 値
 * @returns {value is string} 空でなければ true
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 *
 * @param {unknown} value 値
 * @returns {value is Record<string, unknown>} オブジェクトなら true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
