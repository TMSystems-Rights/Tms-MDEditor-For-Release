/**
 * 開いているノートの表示位置を、パスをキーにして保持する
 * 保存先の読み書きは持たず、渡された記録とエディタのスクロール位置を変換する
 * 行高が確定するまでの追従は、呼び出し側が終了コールバックで受け取る
 * @file
 */
import type { EditorView } from '@codemirror/view';
import { getCollapsedHeadingFroms } from './headingFold';

/** 表示位置ドキュメントの版。2 は折りたたみ見出しの位置を含む */
export const NOTE_VIEW_POSITION_SCHEMA_VERSION = 2;

/** 保存するノート数の上限。古い記録から捨てる */
export const NOTE_VIEW_POSITION_LIMIT = 200;

/** 復元の追従を打ち切るまでの時間（ms）。超えたらその時点の位置で終える */
const RESTORE_LIMIT_MS      = 4000;
/** 追従を終えてよい最短時間（ms）。これより前は、安定しても終えない */
const RESTORE_MIN_TRACK_MS  = 1500;
/** 目標位置と高さが連続して一致したフレーム数。この回数で追従を終える */
const RESTORE_STABLE_FRAMES = 8;

/** requestMeasure の同一キー。連続する復元計測を 1 本にまとめる */
const noteViewScrollMeasureKey = {};

/**
 * ノートの表示位置
 * anchor はビューポート上端にある行塊の文書オフセット
 * yMargin は「行塊上端 - scrollTop」（CodeMirror の scrollSnapshot と同じ）
 */
export type NoteViewPosition = {
	/** 上端行塊の文書オフセット。0 以上、文書長以下 */
	anchor: number;
	/** 行塊上端から scrollTop を引いた差（px）。負のときは行塊が上端より上 */
	yMargin: number;
	/** 横スクロール量（px）。0 未満にはしない */
	scrollLeft: number;
	/** 選択の anchor（文書オフセット） */
	selectionAnchor: number;
	/** 選択の head（文書オフセット） */
	selectionHead: number;
	/** 折りたたみ中の見出し先頭。スキーマ 1 の記録には無く、空配列として読む */
	collapsedHeadingFroms: number[];
};

/**
 * パスと更新時刻を付けた表示位置の記録
 * 同じパスは更新時刻が新しい方だけを残す
 */
export type NoteViewPositionRecord = NoteViewPosition & {
	/** ノートのファイルパス。比較前の表記を保持する */
	filePath: string;
	/** 記録した時刻。ISO 8601。新しい方を残す */
	updatedAt: string;
};

/**
 * 保存先へ書く表示位置ドキュメント
 * 版が 1 または 2 でない JSON は空の記録として読む
 */
export type NoteViewPositionDocument = {
	/** ドキュメントの版。現在は 2 */
	schemaVersion: typeof NOTE_VIEW_POSITION_SCHEMA_VERSION;
	/** パスごとの記録。件数は NOTE_VIEW_POSITION_LIMIT 以下 */
	entries: NoteViewPositionRecord[];
};

/**
 * 復元中の 1 フレームの計測結果
 * スクロール領域が無い、または行高が未確定で先頭へ潰れているときは null
 */
type NoteViewScrollMeasure = {
	/** 復元先の scrollTop（px）。最大スクロール量を超えない */
	targetTop: number;
	/** 復元先の横スクロール量（px）。0 未満にはしない */
	scrollLeft: number;
	/** 目標が、いま測れている文書高に収まっているとき true */
	layoutReady: boolean;
} | null;

/**
 * 高さマップ上の行塊
 * `lineBlockAt` の戻りを、復元と記録で同じ形にしたもの
 */
type ScrollLineBlock = {
	/** 行塊先頭の文書オフセット（含む） */
	from: number;
	/** 行塊上端（px） */
	top: number;
	/** 行塊末尾の文書オフセット（含まない） */
	to: number;
	/** 行塊下端（px） */
	bottom: number;
};

/**
 * 文書長へ収まるオフセットへ切り詰める
 * @param offset - 収める文書オフセット。非数は 0 にする
 * @param docLength - 文書の文字数。非数のときは 0 を返す
 * @returns 0 以上、文書長以下の整数
 */
export function clampNoteViewOffset(offset: number, docLength: number): number {
	// オフセットか文書長のどちらかが非数なら、収める位置が無いので 0。どちらか一方でも 0
	if (!Number.isFinite(offset) || !Number.isFinite(docLength)) return 0;
	return Math.min(Math.max(0, docLength), Math.max(0, Math.trunc(offset)));
}

/**
 * パス比較用のキーを返す。区切りと大文字小文字の差を吸収する
 * @param filePath - 比較するパス。前後の空白を除き、スラッシュはバックスラッシュへ揃える
 * @returns 区切りと大文字小文字を吸収した比較キー
 */
export function noteViewPositionKey(filePath: string): string {
	return filePath.trim().replaceAll('/', '\\').toLowerCase();
}

/**
 * 行塊座標から保存用の表示位置を作る
 * @param input - 計測値
 * @param input.scrollTop - 縦スクロール
 * @param input.scrollLeft - 横スクロール
 * @param input.blockFrom - 上端行塊の開始オフセット
 * @param input.blockTop - 上端行塊の文書上端
 * @param input.selectionAnchor - 選択アンカー
 * @param input.selectionHead - 選択ヘッド
 * @param input.docLength - 文書長
 * @param input.collapsedHeadingFroms - 折りたたみ中の見出し位置。未指定時は空配列
 * @returns 保存する表示位置。非数のスクロールは 0 として扱う
 */
export function captureNoteViewPositionFromMetrics(input: { scrollTop: number; scrollLeft: number; blockFrom: number; blockTop: number; selectionAnchor: number; selectionHead: number; docLength: number; collapsedHeadingFroms?: readonly number[] }): NoteViewPosition {
	// 縦スクロール（px）。非数は 0 として、行塊上端との差を計算する
	const scrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0;
	// 行塊上端（px）。非数は 0。scrollTop との差が yMargin
	const blockTop  = Number.isFinite(input.blockTop) ? input.blockTop : 0;
	return {
		anchor: clampNoteViewOffset(input.blockFrom, input.docLength),
		yMargin: blockTop - scrollTop,
		scrollLeft: Number.isFinite(input.scrollLeft) ? Math.max(0, input.scrollLeft) : 0,
		selectionAnchor: clampNoteViewOffset(input.selectionAnchor, input.docLength),
		selectionHead: clampNoteViewOffset(input.selectionHead, input.docLength),
		collapsedHeadingFroms: normalizeHeadingFroms(input.collapsedHeadingFroms, input.docLength)
	};
}

/**
 * 高さマップから、scrollTop を含む行塊を探す
 * `lineBlockAtHeight` は未実行の計測をその場で走らせるため使わない
 * @param view - エディタ
 * @param scrollTop - 縦スクロール
 * @returns 行塊。高さマップが scrollTop に届いていなければ null
 */
export function findLineBlockAtScrollTop(view: EditorView, scrollTop: number): ScrollLineBlock | null {
	// 文書の文字数。探索範囲の右端。空文書は 0
	const docLength = view.state.doc.length;
	// 文書先頭の行塊。scrollTop がこの上端以下なら、高さマップを辿らずここを上端行とする
	const origin    = view.lineBlockAt(0);
	// スクロールが先頭行塊の上端より進んでいない。負の scrollTop もここ
	if (scrollTop <= origin.top) return origin;

	// 探索の左端（文字）。これより前は、scrollTop より上と分かった範囲。開始時は文書先頭
	let low   = 0;
	// 探索の右端（文字）。これより後は見ない。空文書は 0
	let high  = docLength;
	// scrollTop 以上に届いた最後の行塊。まだ届いていなければ先頭行
	let best  = origin;
	// 探索を進めた回数。while の上限に達すると打ち切る
	let guard = 0;
	while (low <= high && guard < 64) {
		// 探索回数を 1 進める。同じ範囲の繰り返しで抜けなくなるのを、while 側の上限で止める
		guard      += 1;
		// 左右端の中央（文字）。文書の外には出さない。空文書は 0
		const mid   = Math.min(docLength, Math.max(0, Math.floor((low + high) / 2)));
		// 中央の文字を含む行塊。上端が scrollTop の上下どちらにあるかで、次に探す側が決まる
		const block = view.lineBlockAt(mid);
		// 行塊の上端が scrollTop 以下。この行は候補になり、次は右側を探す。上端がまだ下なら入らない
		if (block.top <= scrollTop) {
			// いままでで最も下まで届いた行塊。右側を探し終えても、ここが候補として残る
			best       = block;
			// この行塊の次の文字。mid が塊の途中でも、同じ塊を繰り返さないよう 1 文字は進める
			const next = Math.max(block.to + 1, mid + 1);
			// 次の位置が右端を超えた。これより下に未探索は残っていない
			if (next > high) break;
			// 次の探索は、この行塊の直後から
			low = next;
		} else {
			// 行塊が scrollTop より下にある。左隣から上側を探す。mid より戻らないときは 1 文字戻す
			const prev = Math.min(block.from - 1, mid - 1);
			// 戻した位置が左端より前。これより上に未探索は残っていない
			if (prev < low) break;
			// 次の探索は、この行塊の直前まで
			high = prev;
		}
	}

	// 候補の高さが scrollTop を含むか。上端以上かつ下端未満。どちらか一方が欠けると false
	const covers = best.top <= scrollTop && scrollTop < best.bottom;
	// 文書末尾の行塊か。末尾は下端が scrollTop を超えていなくても、届いていれば採用する
	const isLast = best.to >= docLength;
	// 高さが届いておらず、末尾行でもないときだけ、行塊が無いとみなす。どちらか一方でも候補を返す
	if (!covers && !isLast) return null;
	return best;
}

/**
 * マウント中のエディタから表示位置を読む
 * @param view - エディタ
 * @returns 読めなければ null
 */
export function captureNoteViewPosition(view: EditorView): NoteViewPosition | null {
	// スクロール要素。未接続なら高さが無く、位置を記録しない
	const scroller = view.scrollDOM;
	// DOM に繋がっていないビューは scrollTop が信頼できないので記録しない
	if (!scroller.isConnected) return null;
	// 現在の縦スクロール（px）。上端行塊を決める
	const scrollTop = scroller.scrollTop;
	// scrollTop を含む行塊。高さマップが届いていなければ null
	const block     = findLineBlockAtScrollTop(view, scrollTop);
	// 行塊が取れなければ、保存できる上端が無い
	if (!block) return null;
	// 主選択。anchor と head を記録する
	const selection = view.state.selection.main;
	return captureNoteViewPositionFromMetrics({
		scrollTop,
		scrollLeft: scroller.scrollLeft,
		blockFrom: block.from,
		blockTop: block.top,
		selectionAnchor: selection.anchor,
		selectionHead: selection.head,
		docLength: view.state.doc.length,
		collapsedHeadingFroms: readCollapsedHeadingFroms(view)
	});
}

/**
 * 保存した行アンカーを、現在のレイアウトでの scrollTop へ変換する
 * @param blockTop - 行塊上端
 * @param yMargin - 保存時の行上端とスクロール上端の差
 * @param maxScrollTop - スクロール可能な最大値
 * @returns scrollTop
 */
export function computeRestoredScrollTop(blockTop: number, yMargin: number, maxScrollTop: number): number {
	// 切り詰める前の scrollTop（px）。行上端から保存時の余白を引く。入力が非数なら 0 扱いで、結果は負にもなる
	const target = restoredScrollRawTarget(blockTop, yMargin);
	// 書ける最大 scrollTop（px）。非数や負は 0。これを超える目標はここへ収める
	const max    = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
	return Math.min(max, Math.max(0, target));
}

/** 実EditorStateから折りたたみ状態を読み、簡易テストビューなど未構成状態では空として扱う */
function readCollapsedHeadingFroms(view: EditorView): number[] {
	try {
		return getCollapsedHeadingFroms(view.state);
	} catch {
		return [];
	}
}

/**
 * 保存位置が、いま測れている文書高の中に収まっているかを返す
 * 収まっていないあいだに追従を終えると、先頭や途中の高さで止まってキャレットも描けない
 * @param blockTop - 行塊上端
 * @param yMargin - 保存時の行上端とスクロール上端の差
 * @param maxScrollTop - スクロール可能な最大値
 * @returns 収まるなら true
 */
export function isRestoredScrollLayoutReady(blockTop: number, yMargin: number, maxScrollTop: number): boolean {
	// いま書ける最大 scrollTop（px）。非数や負は 0。目標がこれ以下なら、行高は測れている
	const max = Number.isFinite(maxScrollTop) ? Math.max(0, maxScrollTop) : 0;
	return restoredScrollRawTarget(blockTop, yMargin) <= max + 1;
}

/**
 * 範囲へ切り詰める前の scrollTop を返す
 * @param blockTop - 行塊上端
 * @param yMargin - 保存時の行上端とスクロール上端の差
 * @returns scrollTop
 */
function restoredScrollRawTarget(blockTop: number, yMargin: number): number {
	return (Number.isFinite(blockTop) ? blockTop : 0) - (Number.isFinite(yMargin) ? yMargin : 0);
}

/**
 * 保存位置から、新しい文書へ収まる選択範囲を返す
 * @param position - 表示位置
 * @param docLength - 文書長
 * @returns } 選択範囲
 */
export function selectionFromNoteViewPosition(position: NoteViewPosition, docLength: number): { anchor: number; head: number } {
	return {
		anchor: clampNoteViewOffset(position.selectionAnchor, docLength),
		head: clampNoteViewOffset(position.selectionHead, docLength)
	};
}

/**
 * 外部 JSON を検証し、新しい記録を優先して上限内へ正規化する
 * @param value - 外部 JSON
 * @returns 記録
 */
export function normalizeNoteViewPositionDocument(value: unknown): NoteViewPositionRecord[] {
	if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== NOTE_VIEW_POSITION_SCHEMA_VERSION) || !Array.isArray(value.entries)) return [];
	const includeCollapsedHeadings = value.schemaVersion >= NOTE_VIEW_POSITION_SCHEMA_VERSION;
	return mergeNoteViewPositionRecords(
		[],
		value.entries.flatMap((entry) => {
			const record = normalizeNoteViewPositionRecord(entry, includeCollapsedHeadings);
			return record ? [record] : [];
		})
	);
}

/**
 * 更新時刻が新しい方を残してマージし、上限を超えた古い記録を捨てる
 * @param current - 既存
 * @param incoming - 追加分
 * @param limit - 上限。未指定時は NOTE_VIEW_POSITION_LIMIT
 * @returns マージ結果
 */
export function mergeNoteViewPositionRecords(current: readonly NoteViewPositionRecord[], incoming: readonly NoteViewPositionRecord[], limit = NOTE_VIEW_POSITION_LIMIT): NoteViewPositionRecord[] {
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
 * 更新が新しい順に上限件数へ切る
 * @param records - 記録
 * @param limit - 上限。未指定時は NOTE_VIEW_POSITION_LIMIT
 * @returns 残す記録
 */
export function trimNoteViewPositionRecords(records: readonly NoteViewPositionRecord[], limit = NOTE_VIEW_POSITION_LIMIT): NoteViewPositionRecord[] {
	return [...records]
		.sort((left, right) => {
			if (left.updatedAt === right.updatedAt) return 0;
			return left.updatedAt < right.updatedAt ? 1 : -1;
		})
		.slice(0, Math.max(0, limit));
}

/**
 * プロセス内の表示位置表
 */
export class NoteViewPositionMemory {
	/** パスキーから記録への表。remember のたびに上限へ切り詰める */
	private readonly entries = new Map<string, NoteViewPositionRecord>();

	/**
	 * 正規化済みの記録で表を置き換える
	 * @param records - 置き換える記録。不正な重複は新しい時刻の方を残してから入れる
	 */
	public replace(records: readonly NoteViewPositionRecord[]): void {
		this.entries.clear();
		for (const record of mergeNoteViewPositionRecords([], records)) {
			this.entries.set(noteViewPositionKey(record.filePath), record);
		}
	}

	/**
	 * パスに対応する表示位置を返す
	 * @param filePath - 探すノートのパス。区切りと大文字小文字は比較時に吸収する
	 * @returns 表示位置。記録が無ければ null。折りたたみ位置はコピーして返す
	 */
	public get(filePath: string): NoteViewPosition | null {
		const record = this.entries.get(noteViewPositionKey(filePath));
		if (!record) return null;
		return {
			anchor: record.anchor,
			yMargin: record.yMargin,
			scrollLeft: record.scrollLeft,
			selectionAnchor: record.selectionAnchor,
			selectionHead: record.selectionHead,
			collapsedHeadingFroms: [...record.collapsedHeadingFroms]
		};
	}

	/**
	 * 表示位置を記録し、上限を超えた古いパスを捨てる
	 * @param filePath - 記録するノートのパス。空白だけなら記録しない
	 * @param position - 表示位置
	 * @param updatedAt - 更新時刻。ISO 8601。未指定時は現在時刻
	 */
	public remember(filePath: string, position: NoteViewPosition, updatedAt = new Date().toISOString()): void {
		const trimmed = filePath.trim();
		if (!trimmed) return;
		this.entries.set(noteViewPositionKey(trimmed), {
			filePath: trimmed,
			updatedAt,
			anchor: position.anchor,
			yMargin: position.yMargin,
			scrollLeft: position.scrollLeft,
			selectionAnchor: position.selectionAnchor,
			selectionHead: position.selectionHead,
			collapsedHeadingFroms: [...position.collapsedHeadingFroms]
		});
		const kept = trimNoteViewPositionRecords([...this.entries.values()]);
		this.entries.clear();
		for (const record of kept) this.entries.set(noteViewPositionKey(record.filePath), record);
	}

	/**
	 * 保存用ドキュメントを返す
	 * @returns ドキュメント
	 */
	public toDocument(): NoteViewPositionDocument {
		return {
			schemaVersion: NOTE_VIEW_POSITION_SCHEMA_VERSION,
			entries: trimNoteViewPositionRecords([...this.entries.values()])
		};
	}
}

/**
 * 行高が確定するまで、保存した行アンカーへスクロールを追従させる
 * ユーザー操作が始まったら追従を終える
 * @param view - エディタ
 * @param position - 表示位置
 * @param onSettled - 追従終了時。行高が揃った位置まで戻せたら true
 * @param onLayoutReady - 目標位置が現在の文書高に収まった最初のフレームで呼ぶ。未指定時は通知しない
 */
export function restoreNoteViewScroll(view: EditorView, position: NoteViewPosition, onSettled: (applied: boolean) => void, onLayoutReady?: () => void): void {
	// スクロール要素。未接続なら高さが無く、追従を始めない
	const scroller = view.scrollDOM;
	// DOM に繋がっていないビューは scrollTop を書けない
	if (!scroller.isConnected) {
		onSettled(false);
		return;
	}

	// 追従を終えたか。true のあとは計測も終了コールバックも繰り返さない
	let settled             = false;
	// 目標位置へ一度でも書けたか。書けていないあいだはキー操作で追従をやめない
	let appliedOnce         = false;
	// 目標と高さが同じだった連続フレーム数。揃う前は 0
	let stableFrames        = 0;
	// 直前フレームの目標 scrollTop（px）。未計測は NaN で、同じとはみなさない
	let lastTarget          = Number.NaN;
	// 直前フレームの scrollHeight（px）。未計測は NaN
	let lastHeight          = Number.NaN;
	// 行高が収まった通知を出したか。false のあいだだけ onLayoutReady を呼ぶ
	let layoutReadyNotified = false;
	// 追従を始めた時刻（ms）。制限時間と最短追従時間の起点
	const startedAt         = Date.now();

	/**
	 * 追従を終えて購読を外す
	 * 既に終えていれば、コールバックは再度呼ばない
	 */
	const settle = (): void => {
		// すでに終えていれば、解除とコールバックを重ねない
		if (settled) return;
		// 終了済み。以降の計測とタイマーは何もしない
		settled = true;
		window.clearTimeout(timeoutId);
		scroller.removeEventListener('wheel', onUserScroll, true);
		scroller.removeEventListener('pointerdown', onUserScroll, true);
		view.contentDOM.removeEventListener('keydown', onKeydown, true);
		onSettled(appliedOnce);
	};

	/**
	 * ユーザーのホイールまたはポインタ操作で追従をやめる
	 */
	const onUserScroll = (): void => {
		settle();
	};

	/**
	 * 文字入力や移動キーで追従をやめる。修飾キーだけではやめない
	 * @param event - キー。修飾キーだけでは追従をやめない
	 */
	const onKeydown = (event: KeyboardEvent): void => {
		// まだ一度もスクロールを書けていない。復元途中のキーでは追従をやめない
		if (!appliedOnce) return;
		// 修飾キー自体の押下。キャレットは動かないので追従を続ける。どれでもないキーは次の判定へ進む
		if (event.key === 'Control' || event.key === 'Shift' || event.key === 'Alt' || event.key === 'Meta') return;
		// キャレットかスクロールが動くキーか。修飾と一緒でも追従をやめる対象。これら以外は false
		const movesCaret = event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'PageUp' || event.key === 'PageDown' || event.key === 'Home' || event.key === 'End' || event.key === ' ';
		// Ctrl、Meta、Alt のいずれかがあり、かつキャレットが動くキーでないときだけ追従を続ける。修飾が無い、または移動キーならやめに進む
		if ((event.ctrlKey || event.metaKey || event.altKey) && !movesCaret) return;
		settle();
	};

	// ホイール操作が始まったら、保存位置への追従をやめる
	scroller.addEventListener('wheel', onUserScroll, true);
	// ポインタを押したら、保存位置への追従をやめる
	scroller.addEventListener('pointerdown', onUserScroll, true);
	// 文字入力や移動キーで追従をやめる。修飾キーだけではやめない
	view.contentDOM.addEventListener('keydown', onKeydown, true);
	// 制限時間で追従を打ち切る。安定する前でも終了を通知する
	const timeoutId = window.setTimeout(settle, RESTORE_LIMIT_MS);

	/**
	 * 現在の行高でスクロールを合わせ、安定するか制限時間まで繰り返す
	 */
	const step = (): void => {
		// 終了済み、またはスクロール要素が外れた。どちらか一方でも計測しない
		if (settled || !scroller.isConnected) {
			settle();
			return;
		}
		// 開始から制限時間を過ぎた。安定を待たずに終える
		if (Date.now() - startedAt >= RESTORE_LIMIT_MS) {
			settle();
			return;
		}

		// 行高を測ってから scrollTop を書く。同じキーの計測は 1 本にまとまる
		view.requestMeasure<NoteViewScrollMeasure>({
			// 連続する復元計測を同じ計測として扱うキー
			key: noteViewScrollMeasureKey,
			/**
			 * 目標 scrollTop を計測する
			 * @param measuredView - 計測するエディタ。未接続や高さが 0 のときは測らない
			 * @returns 復元先のスクロール。行高が未確定で先頭へ潰れているときは null
			 */
			read(measuredView) {
				// 計測時点のスクロール要素。外れているか高さが 0 なら、書ける位置が無い
				const measuredScroller = measuredView.scrollDOM;
				// 未接続、または表示高さが 0。どちらか一方でも測らない
				if (!measuredScroller.isConnected || measuredScroller.clientHeight <= 0) return null;
				// 保存した行アンカー（文字）。文書長を超える値は末尾へ収める
				const anchor      = clampNoteViewOffset(position.anchor, measuredView.state.doc.length);
				// アンカーを含む行塊。上端が目標 scrollTop の基準
				const block       = measuredView.lineBlockAt(anchor);
				// いま書ける最大 scrollTop（px）。文書高が表示以下なら 0
				const maxScroll   = Math.max(0, measuredScroller.scrollHeight - measuredScroller.clientHeight);
				// 目標が現在の文書高に収まるか。収まらないあいだは先頭へ潰れている可能性がある
				const layoutReady = isRestoredScrollLayoutReady(block.top, position.yMargin, maxScroll);
				// 行高が未確定で、途中のアンカーが先頭へ潰れ、スクロール余地も無い。一つでも欠けると、測れた値を返す
				if (!layoutReady && anchor > 0 && block.top <= 0 && maxScroll <= 1) return null;
				// このフレームで書くスクロール。行高が未確定のときは read が null を返し、ここまで来ない
				return {
					// 書き込む縦位置（px）。文書高を超える目標は最大値へ収める
					targetTop: computeRestoredScrollTop(block.top, position.yMargin, maxScroll),
					// 書き込む横位置（px）。負の保存値は 0
					scrollLeft: Math.max(0, position.scrollLeft),
					// 目標が現在の文書高に収まったか。false のあいだは安定したと数えない
					layoutReady
				};
			},
			/**
			 * 計測値をスクロールへ反映する
			 * @param measure - 計測結果。null のときは次のフレームで測り直す
			 * @param measuredView - スクロールを書くエディタ。破棄済みなら何もしない
			 */
			write(measure, measuredView) {
				// 終了済み、または計測後にスクロール要素が外れた。どちらか一方でも書かない
				if (settled || !measuredView.scrollDOM.isConnected) return;
				// 行高が未確定で計測が無い。次のフレームで測り直す
				if (!measure) {
					// 次の描画で、同じ追従をやり直す
					window.requestAnimationFrame(step);
					return;
				}

				// いまの縦位置（px）。目標との差が 1px 以内なら書き直さない
				const currentTop    = measuredView.scrollDOM.scrollTop;
				// いまの横位置（px）。目標との差が 1px 以内なら書き直さない
				const currentLeft   = measuredView.scrollDOM.scrollLeft;
				// いまの文書高（px）。直前フレームと比べ、行高がまだ動いているかを見る
				const currentHeight = measuredView.scrollDOM.scrollHeight;
				// 縦位置が目標と 1px 以内か。超えていれば書き直す
				const sameTop       = Math.abs(currentTop - measure.targetTop) <= 1;
				// 横位置が目標と 1px 以内か。超えていれば書き直す
				const sameLeft      = Math.abs(currentLeft - measure.scrollLeft) <= 1;
				// 縦か横のどちらかが 1px を超えてずれているときだけ書く。両方揃っているときは書かない
				if (!sameTop || !sameLeft) {
					// 目標の縦位置（px）。最大値へ収めた計測値
					measuredView.scrollDOM.scrollTop  = measure.targetTop;
					// 目標の横位置（px）。負の保存値は計測側で 0 になっている
					measuredView.scrollDOM.scrollLeft = measure.scrollLeft;
				}

				// 目標 scrollTop が直前フレームと 1px 以内か。直前が NaN のときは違って見える
				const unchanged       = Math.abs(measure.targetTop - lastTarget) <= 1;
				// 文書高が直前フレームと 1px 以内か。直前が NaN のときは違って見える
				const heightUnchanged = Math.abs(currentHeight - lastHeight) <= 1;
				// 行高が収まり、縦横が目標どおりで、目標も高さも直前と同じときだけ連続数を足す。一つでも欠けると 0 に戻す
				stableFrames          = measure.layoutReady && sameTop && sameLeft && unchanged && heightUnchanged ? stableFrames + 1 : 0;
				// このフレームの目標（px）。次の比較に使う
				lastTarget            = measure.targetTop;
				// このフレームの文書高（px）。次の比較に使う
				lastHeight            = currentHeight;
				// 目標が文書高に収まった。一度書けたことにし、最初のフレームだけ準備完了を通知する
				if (measure.layoutReady) {
					// 書けたあとのキー操作は、ユーザー操作として追従をやめる
					appliedOnce = true;
					// 通知は最初の 1 回だけ。すでに出していれば次のフレームを予約しない
					if (!layoutReadyNotified) {
						// このフレームで通知を予約した。同じ追従では二度呼ばない
						layoutReadyNotified = true;
						// 描画後に、まだ追従中なら準備完了を通知する
						window.requestAnimationFrame(() => {
							// 通知までに追従が終わっていたら呼ばない
							if (!settled) onLayoutReady?.();
						});
					}
				}
				// 最短追従時間を過ぎたか。過ぎる前は安定しても終えない
				const trackedLongEnough = Date.now() - startedAt >= RESTORE_MIN_TRACK_MS;
				// 最短時間を過ぎ、かつ安定フレームが揃ったときだけ終える。どちらか一方だけでは続ける
				if (trackedLongEnough && stableFrames >= RESTORE_STABLE_FRAMES) {
					settle();
					return;
				}
				// まだ安定していない。次の描画で測り直す
				window.requestAnimationFrame(step);
			}
		});
	};

	// 最初の計測を始める。安定するか、制限時間か、ユーザー操作まで繰り返す
	step();
}

/**
 * 外部入力の 1 件を、記録として読めるか検証する
 * 必須の数値やパスが欠けていれば捨てる
 * @param value - JSON の 1 要素。オブジェクトでなければ記録にしない
 * @param includeCollapsedHeadings - true のとき見出し位置を残す。スキーマ 1 では false で、空配列にする
 * @returns 検証できた記録。必須項目が欠けていれば null
 */
function normalizeNoteViewPositionRecord(value: unknown, includeCollapsedHeadings: boolean): NoteViewPositionRecord | null {
	if (!isRecord(value) || !isNonEmptyString(value.filePath) || !isNonEmptyString(value.updatedAt)) return null;
	if (!isFiniteNumber(value.anchor) || value.anchor < 0) return null;
	if (!isFiniteNumber(value.yMargin)) return null;
	if (!isFiniteNumber(value.scrollLeft) || value.scrollLeft < 0) return null;
	if (!isFiniteNumber(value.selectionAnchor) || value.selectionAnchor < 0) return null;
	if (!isFiniteNumber(value.selectionHead) || value.selectionHead < 0) return null;
	return {
		filePath: value.filePath.trim(),
		updatedAt: value.updatedAt,
		anchor: Math.trunc(value.anchor),
		yMargin: value.yMargin,
		scrollLeft: value.scrollLeft,
		selectionAnchor: Math.trunc(value.selectionAnchor),
		selectionHead: Math.trunc(value.selectionHead),
		collapsedHeadingFroms: includeCollapsedHeadings ? normalizeHeadingFroms(value.collapsedHeadingFroms, Number.MAX_SAFE_INTEGER) : []
	};
}

/** 外部入力の見出し位置を、重複のない非負整数へ正規化する */
function normalizeHeadingFroms(value: unknown, docLength: number): number[] {
	if (!Array.isArray(value)) return [];
	const max = Number.isFinite(docLength) ? Math.max(0, Math.trunc(docLength)) : Number.MAX_SAFE_INTEGER;
	return [...new Set(value.filter((entry): entry is number => Number.isInteger(entry) && entry >= 0 && entry <= max).map((entry) => Math.trunc(entry)))].sort((left, right) => left - right);
}

/**
 * 値が有限の数値かを判定する
 * @param value - 検査する値。NaN と無限大は数値として扱わない
 * @returns 有限の number のとき true
 */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 空白以外を含む文字列かを判定する
 * @param value - 検査する値。文字列でないときは false
 * @returns trim して空でなければ true
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 配列でないオブジェクトかを判定する
 * @param value - 検査する値。null と配列は記録の入れ物にしない
 * @returns プレーンなオブジェクトのとき true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
