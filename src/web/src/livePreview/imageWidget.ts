/**
 * プレビューの画像をウィジェットで描き、読み込んだ Data URL をプロセス内にキャッシュする
 * 幅のノートへの保存は imageResize へ渡し、このファイルは表示と読み込みの境界を持つ
 * @file
 */
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { BRIDGE_METHOD, invokeBridge } from '../bridge';
import type { DecorationEntry } from './inlineDecorations';
import { rememberCellImageWidth, recallCellImageWidth } from './cellImageWidthMemory';
import { applyImageDisplayWidth, applyImageWidthByPath, applyImageWidthOnDocumentLine } from './imageResize';

// ----------------------------------------------
// ラッパに束縛する参照
// ----------------------------------------------
/** 画像ラッパからパスへの対応。要素が捨てられると消える */
const imageWrapPaths      = new WeakMap<HTMLElement, string>();
/** 表セルなど、DOM から EditorView を引けないときの束縛 */
const imageWrapViews      = new WeakMap<HTMLElement, EditorView>();
/** 表セル専用の幅の書き戻し。無ければ imageResize の通常経路 */
const imageWrapPersisters = new WeakMap<HTMLElement, (width: number) => boolean>();

/**
 * 画像ラッパに保持したパスを返す
 * @param wrap - ラッパ
 * @returns 画像ラッパに保持したパス
 */
export function getImageWrapPath(wrap: HTMLElement): string {
	return imageWrapPaths.get(wrap) ?? wrap.dataset.imagePath ?? '';
}

/**
 * 表セルなど findFromDOM が使えない場所へ EditorView を束縛する
 * @param wrap - ラッパ
 * @param view - エディタ
 */
export function bindImageWrapEditorView(wrap: HTMLElement, view: EditorView): void {
	imageWrapViews.set(wrap, view);
}

/**
 * 表セル専用の幅書き戻しを束縛する
 * @param wrap - ラッパ
 * @param persist - 書き戻し
 */
export function bindImageResizePersister(wrap: HTMLElement, persist: (width: number) => boolean): void {
	imageWrapPersisters.set(wrap, persist);
}

/** 画像参照の種類。URL、絶対パス、ノート相対、Wiki 埋め込み */
export type ImageSourceKind = 'url' | 'absolute' | 'relative' | 'embed';

/** 1枚の画像を描くための参照と表示サイズ。幅の保存前の値 */
export type ImageSpec = {
	/** サイズ指定を除いた alt。空でもよい */
	alt: string;
	/** 記法に書かれたパスまたは URL。解決前 */
	raw: string;
	/** 参照の種類。読み込み方を決める */
	kind: ImageSourceKind;
	/** ドキュメントファイルの絶対パス（相対・埋め込み解決用） */
	documentPath: string | null;
	/** リモート URL を読むか。false のときは読み込まない */
	loadRemoteImages: boolean;
	/** 表示幅（px）。指定が無ければ null */
	width: number | null;
	/** 表示高さ（px）。幅だけなら null */
	height: number | null;
	/** 表セル内など、posAtDOM が使えないときのソース位置 */
	sourceFrom?: number;
	/** 記法の終了位置 */
	sourceTo?: number;
};

/** ホストが返した画像読み込み結果。失敗時は ok が false */
type ReadImageResult = {
	/** Data URL を返せたら true */
	ok: boolean;
	/** 読み込んだ Data URL。失敗時は未設定 */
	dataUrl?: string;
	/** 解決したファイルパス。失敗時は未設定 */
	resolvedPath?: string;
	/** 失敗理由。成功時は未設定 */
	error?: string;
};

/** キャッシュキーから Data URL。失敗は入れない。実行中だけ持つ */
const imageCache = new Map<string, string>();

/**
 * 画像ソースの種別を判定する
 * @param raw - 生のパス / URL
 * @returns 画像ソースの種別を判定する
 */
export function classifyImageSource(raw: string): ImageSourceKind {
	// 前後空白を除いた参照。判定はこれだけを見る
	const trimmed = raw.trim();
	// http(s) か data URL はリモートまたは埋め込み URL
	if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
		return 'url';
	}

	// Windows 絶対パス / UNC / ルート相対（/foo）以外の drive 付き
	// ドライブレターか UNC は絶対パス。相対解決しない
	if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
		return 'absolute';
	}

	return 'relative';
}

/**
 * キャッシュキーを生成する
 * @param spec - 画像仕様
 * @returns キャッシュキー
 */
function cacheKeyFor(spec: ImageSpec): string {
	return `${spec.kind}|${spec.documentPath ?? ''}|${spec.raw}`;
}

/**
 * ローカル画像を Data URL として読み込む
 * @param spec - 画像仕様
 * @returns ローカル画像を Data URL として読み込む。無ければ null
 */
async function loadLocalImageDataUrl(spec: ImageSpec): Promise<string | null> {
	// 種別、文書パス、参照を含むキャッシュキー
	const key    = cacheKeyFor(spec);
	// 同じキーの Data URL。無ければ undefined
	const cached = imageCache.get(key);
	// 一度読めた画像はホストへ再要求しない
	if (cached) {
		return cached;
	}

	try {
		// ホストが返した読み込み結果。失敗は ok が false
		const result = await invokeBridge<ReadImageResult>(BRIDGE_METHOD.fileReadImageAsDataUrl, {
			// 埋め込み以外のパス。埋め込みは embed へ渡す
			path: spec.kind === 'embed' ? undefined : spec.raw,
			// Wiki 埋め込みの参照。それ以外は渡さない
			embed: spec.kind === 'embed' ? spec.raw : undefined,
			// 相対解決に使う文書パス。未保存なら undefined
			documentPath: spec.documentPath ?? undefined
		});
		// 失敗、または Data URL が無い結果はキャッシュしない。どちらか一方でも null
		if (!result.ok || !result.dataUrl) {
			return null;
		}

		imageCache.set(key, result.dataUrl);
		return result.dataUrl;
	} catch {
		return null;
	}
}

/**
 * 絶対パスの埋め込みは未保存でも解決できる
 * @param spec - 画像仕様
 * @returns 絶対パスの埋め込みは未保存でも解決できるなら true
 */
function needsDocumentPath(spec: ImageSpec): boolean {
	// ノート相対は文書パスが無いと解決できない
	if (spec.kind === 'relative') {
		return true;
	}

	// 埋め込みのうち、絶対パスでないものだけ文書パスが要る。どちらか一方では要らない
	if (spec.kind === 'embed' && classifyImageSource(spec.raw) !== 'absolute') {
		return true;
	}

	return false;
}

// ----------------------------------------------
// 画像の描画
// ----------------------------------------------
/**
 * 画像ウィジェット
 */
export class ImageWidget extends WidgetType {
	/** 描く画像の参照とサイズ。生成後は別インスタンスへ作り直す */
	readonly spec: ImageSpec;

	/**
	 * @param spec - 画像仕様
	 */
	constructor(spec: ImageSpec) {
		super();
		this.spec = spec;
	}

	/**
	 * @param other - 比較対象
	 * @returns 同一なら true
	 */
	eq(other: WidgetType): boolean {
		// 別種のウィジェットは同じ画像にしない
		if (!(other instanceof ImageWidget)) {
			return false;
		}

		return other.spec.alt === this.spec.alt && other.spec.raw === this.spec.raw && other.spec.kind === this.spec.kind && other.spec.documentPath === this.spec.documentPath && other.spec.loadRemoteImages === this.spec.loadRemoteImages && other.spec.width === this.spec.width && other.spec.height === this.spec.height && other.spec.sourceFrom === this.spec.sourceFrom && other.spec.sourceTo === this.spec.sourceTo;
	}

	/**
	 * @param view - エディタ（表セルから渡す／CodeMirror が渡す）。省略可
	 * @returns 生成した要素
	 */
	toDOM(view?: EditorView): HTMLElement {
		// 画像とハンドルを入れる枠。編集はさせない
		const wrap     = document.createElement('span');
		wrap.className = 'cm-md-image-wrap';
		wrap.setAttribute('contenteditable', 'false');
		// ソース開始が分かっているときだけ、書き戻し用に覚える
		if (this.spec.sourceFrom !== undefined) {
			wrap.dataset.sourceFrom = String(this.spec.sourceFrom);
		}

		// ソース終端が分かっているときだけ、書き戻しの範囲に使う
		if (this.spec.sourceTo !== undefined) {
			wrap.dataset.sourceTo = String(this.spec.sourceTo);
		}

		wrap.dataset.imagePath = this.spec.raw.replaceAll('\\', '/');
		imageWrapPaths.set(wrap, this.spec.raw);
		// 表セルなど、DOM から view を引けないときだけ束縛する
		if (view) {
			imageWrapViews.set(wrap, view);
		}

		// 表示する画像。読み込み前は src を置かない
		const img     = document.createElement('img');
		img.className = 'cm-md-image';
		img.alt       = this.spec.alt || this.spec.raw;
		img.title     = this.spec.raw;
		img.draggable = false;
		applyImageDisplayStyle(img, this.spec);

		// 読めないときの代わり。初期はパスだけ
		const placeholder       = document.createElement('span');
		placeholder.className   = 'cm-md-image-fallback';
		placeholder.textContent = this.spec.raw;

		// 幅を変える右下ハンドル。画像が無いときは出さない
		const handle     = document.createElement('span');
		handle.className = 'cm-md-image-resize';
		handle.title     = 'ドラッグしてサイズを変更';
		handle.setAttribute('aria-hidden', 'true');
		bindImageResizeHandle(wrap, img, handle);

		/**
		 * 破損プレースホルダを表示する
		 * @param message - 追加メッセージ。省略可
		 */
		const showFallback = (message?: string): void => {
			img.remove();
			handle.remove();
			placeholder.textContent = message ? `${this.spec.raw}（${message}）` : this.spec.raw;
			// まだ枠に無いときだけ、代わりの表示を足す
			if (!placeholder.isConnected) {
				wrap.appendChild(placeholder);
			}
		};

		// URL はホストを通さず、ブラウザへ直接読ませる
		if (this.spec.kind === 'url') {
			// リモート読み込みがオフの URL は画像を出さない
			if (!this.spec.loadRemoteImages) {
				showFallback('リモート画像オフ');
				return wrap;
			}

			img.src = this.spec.raw;
			// 読み込み失敗のときだけ、パスと理由を代わりに出す
			img.addEventListener('error', () => showFallback('読み込み失敗'));
			wrap.append(img, handle);
			return wrap;
		}

		// 文書パスが必要で、かつ未保存のときは解決できない。どちらか一方では読む
		if (needsDocumentPath(this.spec) && !this.spec.documentPath) {
			showFallback('未保存のため解決不可');
			return wrap;
		}

		wrap.appendChild(placeholder);
		void loadLocalImageDataUrl(this.spec).then((dataUrl) => {
			// Data URL が無い画像は見つからなかったものとして出す
			if (!dataUrl) {
				showFallback('見つかりません');
				return;
			}

			img.src = dataUrl;
			applyImageDisplayStyle(img, this.spec);
			// 読み込み後にもう一度、自然サイズが分かった状態で幅を当てる
			img.addEventListener('load', () => applyImageDisplayStyle(img, this.spec));
			// 読めない Data URL はパスと理由へ替える
			img.addEventListener('error', () => showFallback('読み込み失敗'));
			placeholder.replaceWith(img);
			wrap.appendChild(handle);
		});

		return wrap;
	}

	/**
	 * @returns 見積もった高さ
	 */
	get estimatedHeight(): number {
		return this.spec.width ? Math.max(80, Math.round(this.spec.width * 0.6)) : 120;
	}

	/**
	 * クリックでキャレットを記法上へ置かない（ソース展開でハンドルが消えるのを防ぐ）
	 * @returns クリックでキャレットを記法上へ置かない（ソース展開でハンドルが消えるのを防ぐ）なら true
	 */
	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * 指定幅があれば適用し、未指定なら既定キャップを使う
 * @param img - 画像
 * @param spec - 仕様
 */
function applyImageDisplayStyle(img: HTMLImageElement, spec: ImageSpec): void {
	// 記法の幅。正の指定が無ければ、同じパスで覚えたセル幅。どちらも無ければ 0 か null
	const width = spec.width && spec.width > 0 ? spec.width : recallCellImageWidth(spec.raw);
	// 正の幅があるときだけ固定し、無いときは既定の上限へ戻す
	if (width && width > 0) {
		img.classList.add('is-sized');
		img.style.width     = `${width}px`;
		img.style.height    = spec.height && spec.height > 0 ? `${spec.height}px` : 'auto';
		img.style.maxWidth  = '100%';
		img.style.maxHeight = 'none';
		return;
	}

	img.classList.remove('is-sized');
	img.style.width     = '';
	img.style.height    = '';
	img.style.maxWidth  = '';
	img.style.maxHeight = '';
}

/**
 * 右下ハンドルのドラッグで幅を変え、mouseup でソースへ書き戻す
 * @param wrap - ラッパ
 * @param img - 画像
 * @param handle - ハンドル
 */
function bindImageResizeHandle(wrap: HTMLElement, img: HTMLImageElement, handle: HTMLElement): void {
	// ドラッグ中なら true。二重開始を止める
	let dragging = false;

	/**
	 * ハンドルのドラッグを開始する
	 * @param clientX - 開始 X
	 * @param pointerId - Pointer Capture 用 ID。省略可
	 */
	const startDrag = (clientX: number, pointerId?: number): void => {
		// すでにドラッグ中の開始は無視する
		if (dragging) {
			return;
		}

		dragging         = true;
		// 開始時の画面 X。移動量の基準
		const startX     = clientX;
		// 開始時の幅（px）。まだ 0 なら 120
		const startWidth = img.getBoundingClientRect().width || img.naturalWidth || 120;
		// これ以上広げない幅（px）。内容幅が無ければ 720、下限は 80
		const maxWidth   = Math.max(80, wrap.closest('.cm-content')?.clientWidth ?? 720);
		// 最後に表示した幅（px）。離したときに書き戻す
		let lastWidth    = startWidth;
		// 2px 以上動いたら true。クリックだけでは書き戻さない
		let moved        = false;
		// 終了処理を一度だけにするための印
		let finished     = false;

		// Pointer Events のときだけ、ハンドルへキャプチャを取る
		if (pointerId !== undefined) {
			try {
				handle.setPointerCapture(pointerId);
			} catch {
				// Pointer Capture 非対応環境では document 追跡に落とす
			}
		}

		/**
		 * ドラッグ中の幅を更新する
		 * @param moveX - ポインタ X
		 */
		const applyMove = (moveX: number): void => {
			// 下限 24、上限 maxWidth に収めた次の幅（px）
			const next = Math.min(maxWidth, Math.max(24, startWidth + (moveX - startX)));
			// 開始幅から 2px 以上離れたときだけ、書き戻す対象にする
			if (Math.abs(next - startWidth) >= 2) {
				moved = true;
			}

			lastWidth = next;
			img.classList.add('is-sized');
			img.style.width     = `${next}px`;
			img.style.height    = 'auto';
			img.style.maxWidth  = '100%';
			img.style.maxHeight = 'none';
		};

		/**
		 * ドラッグ終了時にソースへ書き戻す
		 */
		const finish = (): void => {
			// 終了は一度だけ。離すイベントが重なっても二重に書かない
			if (finished) {
				return;
			}

			finished = true;
			dragging = false;
			window.removeEventListener('pointermove', onPointerMove, true);
			window.removeEventListener('pointerup', finish, true);
			window.removeEventListener('pointercancel', finish, true);
			window.removeEventListener('mousemove', onMouseMove, true);
			window.removeEventListener('mouseup', finish, true);
			document.removeEventListener('pointerup', finish, true);
			document.removeEventListener('mouseup', finish, true);
			handle.removeEventListener('lostpointercapture', finish);
			// キャプチャを取ったときだけ、まだ持っていれば解放する
			if (pointerId !== undefined) {
				try {
					// まだキャプチャを持っているときだけ解放する
					if (handle.hasPointerCapture(pointerId)) {
						handle.releasePointerCapture(pointerId);
					}
				} catch {
					// Pointer Capture 非対応環境では解放不要
				}
			}

			// ほとんど動いていないドラッグはソースへ書かない
			if (!moved) {
				return;
			}

			persistImageResizeWidth(wrap, lastWidth);
		};

		/**
		 * @param moveEvent - ポインタ移動
		 */
		const onPointerMove = (moveEvent: PointerEvent): void => {
			applyMove(moveEvent.clientX);
		};

		/**
		 * @param moveEvent - マウス移動
		 */
		const onMouseMove = (moveEvent: MouseEvent): void => {
			applyMove(moveEvent.clientX);
		};

		window.addEventListener('pointermove', onPointerMove, true);
		// 離す、またはキャンセルで幅を書き戻す
		window.addEventListener('pointerup', finish, true);
		// ポインタがキャンセルされたときも同じ終了にする
		window.addEventListener('pointercancel', finish, true);
		// Pointer Events が無い環境の移動
		window.addEventListener('mousemove', onMouseMove, true);
		// Pointer Events が無い環境の離す
		window.addEventListener('mouseup', finish, true);
		// ウィンドウ外で離したときの取りこぼし
		document.addEventListener('pointerup', finish, true);
		document.addEventListener('mouseup', finish, true);
		// キャプチャを失ったときもドラッグを終える
		handle.addEventListener('lostpointercapture', finish);
	};

	// 左ボタンのポインタ押下だけドラッグを始める
	handle.addEventListener('pointerdown', (event) => {
		// 左ボタン以外は幅を変えない
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		startDrag(event.clientX, event.pointerId);
	});
	// Pointer Events が無い環境の左ボタン押下
	handle.addEventListener('mousedown', (event) => {
		// 左ボタン以外は幅を変えない
		if (event.button !== 0) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		startDrag(event.clientX);
	});
}

/**
 * ドラッグ結果を Markdown へ書き戻す
 * 表セルでは findFromDOM が失敗しても、束縛した view / 書き戻しでソースへ残す
 * @param wrap - 画像ラッパ
 * @param width - 幅
 * @returns 更新したか
 */
export function persistImageResizeWidth(wrap: HTMLElement, width: number): boolean {
	// ラッパに束縛したパス。無ければ空文字
	const path      = getImageWrapPath(wrap);
	// 画像が入っている表セル。表の外なら null
	const tableCell = wrap.closest<HTMLElement>('[data-table-row]');
	// セルの行番号。セルが無ければ NaN
	const row       = Number(tableCell?.dataset.tableRow);
	// セルの列番号。セルが無ければ NaN
	const column    = Number(tableCell?.dataset.tableColumn);
	rememberCellImageWidth(
		path,
		width,
		Number.isInteger(row) && Number.isInteger(column)
			? {
				// 幅を覚える行。整数のときだけ渡す
				row,
				// 幅を覚える列。整数のときだけ渡す
				column
			}
			: undefined
	);

	// 表セル専用の書き戻し。無ければ undefined
	const persist = imageWrapPersisters.get(wrap);
	// 専用の書き戻しが成功したか。無ければ false
	let wrote     = persist?.(width) ?? false;
	// 束縛した view。無ければ DOM から探す。どちらも無ければ null
	const view    = imageWrapViews.get(wrap) ?? EditorView.findFromDOM(wrap);
	// まだ書いておらず、かつ view があるときだけ通常の幅更新を試す。どちらか一方では試さない
	if (!wrote && view) {
		// dataset の開始位置。未設定なら undefined
		const sourceFrom = wrap.dataset.sourceFrom;
		// dataset の終端。未設定なら undefined
		const sourceTo   = wrap.dataset.sourceTo;
		// 開始位置。空文字や未設定は NaN
		let pos          = sourceFrom !== undefined && sourceFrom !== '' ? Number(sourceFrom) : NaN;
		// 開始位置が数値でないときだけ、DOM から文書位置を取る
		if (!Number.isFinite(pos)) {
			try {
				pos = view.posAtDOM(wrap);
			} catch {
				pos = NaN;
			}
		}

		// 記法の終端。空文字や未設定は undefined
		const end = sourceTo !== undefined && sourceTo !== '' ? Number(sourceTo) : undefined;
		wrote     = applyImageWidthByPath(view, path, width, Number.isFinite(pos) ? pos : undefined) || (Number.isFinite(pos) && applyImageWidthOnDocumentLine(view, pos, width)) || (Number.isFinite(pos) && applyImageDisplayWidth(view, pos, width, Number.isFinite(end) ? end : undefined));
	}

	wrap.dispatchEvent(
		new CustomEvent('tms-mde-table-image-resized', {
			// 表ウィジェットまで届かせる
			bubbles: true,
			// 書き戻した幅と、ソースを更新できたか
			detail: {
				// 表示幅（px）
				width,
				// ソースへ書けたら true
				persisted: wrote
			}
		})
	);
	return wrote;
}

/**
 * 画像ノードをウィジェットへ置換する
 * @param entries - エントリ配列
 * @param from - 開始位置
 * @param to - 終了位置
 * @param spec - 画像仕様
 */
export function pushImageReplace(entries: DecorationEntry[], from: number, to: number, spec: ImageSpec): void {
	// 空範囲は置換しない
	if (from >= to) {
		return;
	}

	// 記法全体を画像ウィジェットへ置き換える
	entries.push({
		// 記法の開始
		from,
		// 記法の終端
		to,
		// 画像ウィジェット。同じ仕様なら再利用する
		decoration: Decoration.replace({
			// この仕様を描くウィジェット
			widget: new ImageWidget(spec)
		})
	});
}
