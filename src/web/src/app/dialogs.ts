import type { CloseChoice, EncodingKind, EolKind, EolMixedChoice, SaveAsOptions } from '../types/app';
import { formatEncodingLabel, formatEolLabel } from '../utils/format';

const CONTEXT_MENU_GAP             = 4;
const CONTEXT_MENU_VIEWPORT_MARGIN = 4;
const CONTEXT_MENU_DISMISS_EVENT   = 'tms-mde-dismiss-context-menu';

type ContextMenuRect = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

type ContextMenuSize = {
	width: number;
	height: number;
};

type ContextMenuPosition = {
	left: number;
	top: number;
};

export type ContextMenuEntry = {
	id: string;
	label?: string;
	shortcut?: string;
	disabled?: boolean;
	hidden?: boolean;
	separator?: boolean;
};

/**
 * 改行コード混在確認ダイアログを表示する
 * @returns {Promise<EolMixedChoice>} 選択結果
 */
export function showEolMixedDialog(): Promise<EolMixedChoice> {
	return new Promise((resolve) => {
		const backdrop = createBackdrop();

		const dialog     = document.createElement('div');
		dialog.className = 'tms-mde-dialog';
		dialog.innerHTML = `
			<h2 class="tms-mde-dialog-title">改行コードが混在しています</h2>
			<p class="tms-mde-dialog-message">統一して保存しますか？</p>
			<div class="tms-mde-dialog-actions">
				<button type="button" data-choice="crlf">CRLFに統一</button>
				<button type="button" data-choice="lf">LFに統一</button>
				<button type="button" data-choice="keep">そのまま保存</button>
				<button type="button" data-choice="cancel">キャンセル</button>
			</div>
		`;

		/**
		 *
		 */
		const close = (choice: EolMixedChoice): void => {
			backdrop.remove();
			resolve(choice);
		};

		dialog.querySelectorAll('[data-choice]').forEach((button) => {
			button.addEventListener('click', () => {
				close((button as HTMLButtonElement).dataset.choice as EolMixedChoice);
			});
		});

		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * クローズ確認ダイアログを表示する
 * @param {string} title 対象名
 * @returns {Promise<CloseChoice>} 選択結果
 */
export function showCloseConfirmDialog(title: string): Promise<CloseChoice> {
	return new Promise((resolve) => {
		const backdrop = createBackdrop();

		const dialog     = document.createElement('div');
		dialog.className = 'tms-mde-dialog';
		dialog.innerHTML = `
			<h2 class="tms-mde-dialog-title">保存確認</h2>
			<p class="tms-mde-dialog-message">${escapeHtml(title)} の変更を保存しますか？</p>
			<div class="tms-mde-dialog-actions">
				<button type="button" data-choice="save">保存</button>
				<button type="button" data-choice="discard">保存しない</button>
				<button type="button" data-choice="cancel">キャンセル</button>
			</div>
		`;

		/**
		 *
		 */
		const close = (choice: CloseChoice): void => {
			backdrop.remove();
			resolve(choice);
		};

		dialog.querySelectorAll('[data-choice]').forEach((button) => {
			button.addEventListener('click', () => {
				close((button as HTMLButtonElement).dataset.choice as CloseChoice);
			});
		});

		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

type SaveAsDialogOptions = {
	defaultEncoding: EncodingKind;
	defaultEol: EolKind;
};

/**
 * 名前を付けて保存オプションダイアログを表示する
 * @param {SaveAsDialogOptions} options 既定値
 * @returns {Promise<SaveAsOptions | null>} 選択結果
 */
export function showSaveAsOptionsDialog(options: SaveAsDialogOptions): Promise<SaveAsOptions | null> {
	return new Promise((resolve) => {
		const backdrop = createBackdrop();

		const dialog     = document.createElement('div');
		dialog.className = 'tms-mde-dialog';
		dialog.innerHTML = `
			<h2 class="tms-mde-dialog-title">保存オプション</h2>
			<label class="tms-mde-dialog-field">
				<span>文字コード</span>
				<select id="tmsMdeSaveAsEncoding">
					<option value="utf8">UTF-8</option>
					<option value="utf8Bom">UTF-8(BOM)</option>
					<option value="cp932">CP932</option>
					<option value="utf16Le">UTF-16LE</option>
				</select>
			</label>
			<label class="tms-mde-dialog-field">
				<span>改行コード</span>
				<select id="tmsMdeSaveAsEol">
					<option value="crlf">CRLF</option>
					<option value="lf">LF</option>
				</select>
			</label>
			<div class="tms-mde-dialog-actions">
				<button type="button" id="tmsMdeSaveAsOk">保存</button>
				<button type="button" id="tmsMdeSaveAsCancel">キャンセル</button>
			</div>
		`;

		const encodingSelect = dialog.querySelector('#tmsMdeSaveAsEncoding') as HTMLSelectElement;
		const eolSelect      = dialog.querySelector('#tmsMdeSaveAsEol') as HTMLSelectElement;
		encodingSelect.value = options.defaultEncoding;
		eolSelect.value      = options.defaultEol;

		/**
		 *
		 */
		const close = (result: SaveAsOptions | null): void => {
			backdrop.remove();
			resolve(result);
		};

		dialog.querySelector('#tmsMdeSaveAsOk')?.addEventListener('click', () => {
			close({
				encoding: encodingSelect.value as EncodingKind,
				eol: eolSelect.value as EolKind
			});
		});

		dialog.querySelector('#tmsMdeSaveAsCancel')?.addEventListener('click', () => {
			close(null);
		});

		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * 開いているコンテキストメニューをすべて閉じる
 * @returns {void}
 */
export function dismissContextMenus(): void {
	document.querySelectorAll('.tms-mde-context-menu').forEach((element) => {
		element.dispatchEvent(new CustomEvent(CONTEXT_MENU_DISMISS_EVENT));
		element.remove();
	});
}

/**
 * 簡易メニューを表示する
 * @param {HTMLElement} anchor 基準要素
 * @param {ContextMenuEntry[]} items メニュー項目
 * @param {(id: string) => void} onSelect 選択コールバック
 * @returns {void}
 */
export function showContextMenu(anchor: HTMLElement, items: ContextMenuEntry[], onSelect: (id: string) => void): void {
	showContextMenuFromRect(anchor.getBoundingClientRect(), items, onSelect);
}

/**
 * マウス座標を基準にコンテキストメニューを表示する。
 * @param {number} x ビューポートX座標
 * @param {number} y ビューポートY座標
 * @param {ContextMenuEntry[]} items メニュー項目
 * @param {(id: string) => void} onSelect 選択コールバック
 * @returns {void}
 */
export function showContextMenuAtPoint(x: number, y: number, items: ContextMenuEntry[], onSelect: (id: string) => void): void {
	showContextMenuFromRect({ left: x, right: x, top: y, bottom: y }, items, onSelect);
}

/**
 * 非表示項目を除外し、先頭・末尾・連続区切り線を取り除く。
 * @param {ContextMenuEntry[]} items メニュー項目
 * @returns {ContextMenuEntry[]} 表示対象
 */
export function compactContextMenuEntries(items: ContextMenuEntry[]): ContextMenuEntry[] {
	const result: ContextMenuEntry[] = [];
	items.filter((item) => !item.hidden).forEach((item) => {
		if (item.separator) {
			if (result.length === 0 || result.at(-1)?.separator) {
				return;
			}
		}
		result.push(item);
	});

	if (result.at(-1)?.separator) {
		result.pop();
	}
	return result;
}

/**
 * 基準矩形から共通コンテキストメニューを描画する。
 * @param {ContextMenuRect} anchorRect 基準矩形
 * @param {ContextMenuEntry[]} items メニュー項目
 * @param {(id: string) => void} onSelect 選択コールバック
 * @returns {void}
 */
function showContextMenuFromRect(anchorRect: ContextMenuRect, items: ContextMenuEntry[], onSelect: (id: string) => void): void {
	dismissContextMenus();

	const menu     = document.createElement('div');
	menu.className = 'tms-mde-context-menu';
	menu.setAttribute('role', 'menu');

	/**
	 * メニュー外クリックで閉じる
	 * @param {MouseEvent} event マウスイベント
	 * @returns {void}
	 */
	const onOutsideClick = (event: MouseEvent): void => {
		if (!menu.contains(event.target as Node)) {
			cleanup();
		}
	};

	/**
	 * Escape で閉じる
	 * @param {KeyboardEvent} event キーイベント
	 * @returns {void}
	 */
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault();
			cleanup();
		}
	};

	/**
	 * リスナー解除とメニュー削除
	 * @returns {void}
	 */
	const cleanup = (): void => {
		menu.remove();
		document.removeEventListener('mousedown', onOutsideClick, true);
		document.removeEventListener('keydown', onKeyDown, true);
		menu.removeEventListener(CONTEXT_MENU_DISMISS_EVENT, cleanup);
	};

	compactContextMenuEntries(items).forEach((item) => {
		if (item.separator) {
			const separator     = document.createElement('div');
			separator.className = 'tms-mde-context-menu-separator';
			separator.setAttribute('role', 'separator');
			menu.appendChild(separator);
			return;
		}

		const button    = document.createElement('button');
		button.type     = 'button';
		button.disabled = Boolean(item.disabled);
		button.setAttribute('role', 'menuitem');
		const label       = document.createElement('span');
		label.className   = 'tms-mde-context-menu-label';
		label.textContent = item.label ?? item.id;
		button.appendChild(label);
		if (item.shortcut) {
			const shortcut       = document.createElement('span');
			shortcut.className   = 'tms-mde-context-menu-shortcut';
			shortcut.textContent = item.shortcut;
			button.appendChild(shortcut);
		}
		if (!item.disabled) {
			button.addEventListener('click', () => {
				cleanup();
				onSelect(item.id);
			});
		}
		menu.appendChild(button);
	});

	document.body.appendChild(menu);
	const position  = calculateContextMenuPosition(
		anchorRect,
		{ width: menu.offsetWidth, height: menu.offsetHeight },
		{ width: window.innerWidth, height: window.innerHeight }
	);
	menu.style.left = `${position.left}px`;
	menu.style.top  = `${position.top}px`;

	document.addEventListener('mousedown', onOutsideClick, true);
	document.addEventListener('keydown', onKeyDown, true);
	menu.addEventListener(CONTEXT_MENU_DISMISS_EVENT, cleanup);
}

/**
 * 文字コード変更メニューを表示する
 * @param {HTMLElement} anchor 基準要素
 * @param {(encoding: EncodingKind) => void} onSelect 選択コールバック
 * @returns {void}
 */
export function showEncodingMenu(anchor: HTMLElement, onSelect: (encoding: EncodingKind) => void): void {
	showContextMenu(
		anchor,
		[
			{ id: 'utf8', label: formatEncodingLabel('utf8') },
			{ id: 'utf8Bom', label: formatEncodingLabel('utf8Bom') },
			{ id: 'cp932', label: formatEncodingLabel('cp932') },
			{ id: 'utf16Le', label: formatEncodingLabel('utf16Le') }
		],
		(id) => onSelect(id as EncodingKind)
	);
}

/**
 * 指定文字コードで再読込するための選択ダイアログを表示する
 * @param {EncodingKind} defaultEncoding 初期選択
 * @returns {Promise<EncodingKind | null>} 選択結果
 */
export function showReloadEncodingDialog(defaultEncoding: EncodingKind): Promise<EncodingKind | null> {
	return new Promise((resolve) => {
		const backdrop   = createBackdrop();
		const dialog     = document.createElement('div');
		dialog.className = 'tms-mde-dialog';
		dialog.innerHTML = `<h2 class="tms-mde-dialog-title">指定の文字コードで再読込</h2><p class="tms-mde-dialog-message">未保存の変更があるファイルは再読込できません。</p><label class="tms-mde-dialog-field"><span>文字コード</span><select id="tmsMdeReloadEncoding"><option value="utf8">UTF-8</option><option value="utf8Bom">UTF-8(BOM)</option><option value="cp932">CP932</option><option value="utf16Le">UTF-16LE</option></select></label><div class="tms-mde-dialog-actions"><button type="button" id="tmsMdeReloadOk">再読込</button><button type="button" id="tmsMdeReloadCancel">キャンセル</button></div>`;
		const select     = dialog.querySelector('#tmsMdeReloadEncoding') as HTMLSelectElement;
		select.value     = defaultEncoding;
		/**
		 *
		 */
		const close = (result: EncodingKind | null): void => {
			backdrop.remove();
			resolve(result);
		};
		dialog.querySelector('#tmsMdeReloadOk')?.addEventListener('click', () => close(select.value as EncodingKind));
		dialog.querySelector('#tmsMdeReloadCancel')?.addEventListener('click', () => close(null));
		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * 改行コード変換メニューを表示する
 * @param {HTMLElement} anchor 基準要素
 * @param {(eol: EolKind) => void} onSelect 選択コールバック
 * @returns {void}
 */
export function showEolConvertMenu(anchor: HTMLElement, onSelect: (eol: EolKind) => void): void {
	showContextMenu(
		anchor,
		[
			{ id: 'crlf', label: formatEolLabel('crlf', false) },
			{ id: 'lf', label: formatEolLabel('lf', false) }
		],
		(id) => onSelect(id as EolKind)
	);
}

/**
 * エラーメッセージを表示する
 * @param {string} message メッセージ
 * @returns {void}
 */
export function showErrorMessage(message: string): void {
	window.alert(message);
}

/**
 * コンテキストメニューの表示位置を算出する
 * @param {ContextMenuRect} anchorRect 基準要素の矩形
 * @param {ContextMenuSize} menuSize メニュー寸法
 * @param {ContextMenuSize} viewportSize ビューポート寸法
 * @returns {ContextMenuPosition} 表示位置
 */
export function calculateContextMenuPosition(anchorRect: ContextMenuRect, menuSize: ContextMenuSize, viewportSize: ContextMenuSize): ContextMenuPosition {
	const maxLeft = viewportSize.width - menuSize.width - CONTEXT_MENU_VIEWPORT_MARGIN;
	const left    = clamp(anchorRect.left, CONTEXT_MENU_VIEWPORT_MARGIN, Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, maxLeft));

	const belowTop = anchorRect.bottom + CONTEXT_MENU_GAP;
	const aboveTop = anchorRect.top - menuSize.height - CONTEXT_MENU_GAP;
	const maxTop   = viewportSize.height - menuSize.height - CONTEXT_MENU_VIEWPORT_MARGIN;

	if (belowTop <= maxTop) {
		return { left, top: belowTop };
	}

	if (aboveTop >= CONTEXT_MENU_VIEWPORT_MARGIN) {
		return { left, top: aboveTop };
	}

	return {
		left,
		top: clamp(belowTop, CONTEXT_MENU_VIEWPORT_MARGIN, Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, maxTop))
	};
}

/**
 * 数値を指定範囲内に丸める
 * @param {number} value 対象値
 * @param {number} min 最小値
 * @param {number} max 最大値
 * @returns {number} 丸めた値
 */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * バックドロップ要素を生成する
 * @returns {HTMLDivElement} バックドロップ
 */
function createBackdrop(): HTMLDivElement {
	const backdrop     = document.createElement('div');
	backdrop.className = 'tms-mde-dialog-backdrop';
	return backdrop;
}

/**
 * HTML をエスケープする
 * @param {string} value 文字列
 * @returns {string} エスケープ結果
 */
function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
