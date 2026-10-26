/**
 * 保存確認や文字コード選択のダイアログと、コンテキストメニューを出す
 * 設定の保存は持たず、選択結果を Promise かコールバックで返す
 * @file
 */
import type { CloseChoice, EncodingKind, EolKind, EolMixedChoice, SaveAsOptions } from '../types/app';
import { formatEncodingLabel, formatEolLabel } from '../utils/format';

/** メニューと基準要素の間隔。単位は CSS ピクセル */
// prettier-ignore
const CONTEXT_MENU_GAP             = 4;

/** メニューをビューポート端から離す余白。単位は CSS ピクセル */
const CONTEXT_MENU_VIEWPORT_MARGIN = 4;

/** 開いているメニューをまとめて閉じるためのカスタムイベント名 */
// prettier-ignore
const CONTEXT_MENU_DISMISS_EVENT   = 'tms-mde-dismiss-context-menu';

/**
 * メニューの基準にする矩形
 * 点で開くときは左右と上下を同じ座標にする
 */
type ContextMenuRect = {
	/** 左端。単位は CSS ピクセル */
	left: number;
	/** 右端。単位は CSS ピクセル */
	right: number;
	/** 上端。単位は CSS ピクセル */
	top: number;
	/** 下端。単位は CSS ピクセル */
	bottom: number;
};

/**
 * メニューまたはビューポートの大きさ
 * 位置計算では幅と高さだけを使う
 */
type ContextMenuSize = {
	/** 幅。単位は CSS ピクセル */
	width: number;
	/** 高さ。単位は CSS ピクセル */
	height: number;
};

/**
 * メニューを置く左上
 * ビューポート座標で、はみ出すときは内側へ寄せた値
 */
type ContextMenuPosition = {
	/** 左端。単位は CSS ピクセル */
	left: number;
	/** 上端。単位は CSS ピクセル */
	top: number;
};

/**
 * コンテキストメニューの 1 項目
 * 区切り線は `separator` だけで、ラベルは無くてよい
 */
export type ContextMenuEntry = {
	/** 選択時に返す ID。区切り線でも一意にする */
	id: string;
	/** 項目の文言。省略時は ID を出す */
	label?: string;
	/** 右端に出すショートカット。無い項目は未設定 */
	shortcut?: string;
	/** 押せない状態にするか。未設定は押せる */
	disabled?: boolean;
	/** メニューから除くか。未設定は表示する */
	hidden?: boolean;
	/** 区切り線か。未設定は通常項目 */
	separator?: boolean;
};

/**
 * 新規表ダイアログで確定した大きさ
 * 見出し行は `dataRows` に含めない
 */
export type InsertTableOptions = {
	/** 列数。1〜50 */
	columns: number;
	/** 見出しを除くデータ行数。0〜100 */
	dataRows: number;
};

/**
 * 改行コード混在確認ダイアログを表示する
 * ボタンを押すまで Promise は解決しない。キャンセルは保存を中止する選択として返す
 * @returns 統一先、混在のまま保存、またはキャンセル
 */
// prettier-ignore
export function showEolMixedDialog(): Promise<EolMixedChoice> {
	return new Promise((resolve) => {
		// ダイアログの背面。選択が終わるまで後ろの操作を遮る。close が文書から外す。この時点ではまだ body に無い
		const backdrop = createBackdrop();

		// 統一先を選ぶダイアログ。ボタンの data-choice が crlf、lf、keep、cancel
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
		 * モーダル DOM を必ず片付けてから、選択結果で待機中の処理を再開する
		 * @param choice - ボタンが表す統一先、そのまま保存、またはキャンセル
		 */
		const close = (choice: EolMixedChoice): void => {
			backdrop.remove();
			resolve(choice);
		};

		dialog.querySelectorAll('[data-choice]').forEach((button) => {
			// 押したボタンの data-choice で Promise を解決する。値は crlf、lf、keep、cancel のいずれか
			button.addEventListener('click', () => {
				close((button as HTMLButtonElement).dataset.choice as EolMixedChoice);
			});
		});

		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * 未保存の変更を閉じる前の確認ダイアログを表示する
 * 保存、破棄、キャンセルのいずれかで Promise を解決する
 * @param title - 確認文に出す対象名。HTML として埋め込む前にエスケープする
 * @returns 保存するか、破棄するか、閉じるのをやめるか
 */
// prettier-ignore
export function showCloseConfirmDialog(title: string): Promise<CloseChoice> {
	return new Promise((resolve) => {
		// ダイアログの背面。選択が終わるまで後ろの操作を遮る。close が文書から外す。この時点ではまだ body に無い
		const backdrop = createBackdrop();

		// 保存、破棄、キャンセルを選ぶダイアログ。対象名はエスケープしてから文言へ埋め込む
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
		 * 二重操作を避けるためダイアログを先に破棄し、閉じ方を呼び出し元へ返す
		 * @param choice - 保存、破棄、またはキャンセル
		 */
		const close = (choice: CloseChoice): void => {
			backdrop.remove();
			resolve(choice);
		};

		dialog.querySelectorAll('[data-choice]').forEach((button) => {
			// 押したボタンの data-choice で Promise を解決する。値は save、discard、cancel のいずれか
			button.addEventListener('click', () => {
				close((button as HTMLButtonElement).dataset.choice as CloseChoice);
			});
		});

		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * 名前を付けて保存するダイアログの初期値
 * パスの選択は含まない
 */
type SaveAsDialogOptions = {
	/** 開いたときに選んでおく文字コード */
	defaultEncoding: EncodingKind;
	/** 開いたときに選んでおく改行 */
	defaultEol: EolKind;
};

/**
 * 名前を付けて保存する文字コードと改行を選ばせる
 * キャンセルは null。選んだ値の妥当性は選択肢に限定する
 * @param options - ダイアログを開いたときの初期選択
 * @returns 保存に使う文字コードと改行。キャンセルは null
 */
// prettier-ignore
export function showSaveAsOptionsDialog(options: SaveAsDialogOptions): Promise<SaveAsOptions | null> {
	return new Promise((resolve) => {
		// ダイアログの背面。選択が終わるまで後ろの操作を遮る。close が文書から外す。この時点ではまだ body に無い
		const backdrop = createBackdrop();

		// 文字コードと改行を選ぶダイアログ。パスの選択は含まない
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

		// 文字コードの select。選択肢は UTF-8、BOM 付き、CP932、UTF-16LE。初期値は開いたときの指定
		const encodingSelect = dialog.querySelector('#tmsMdeSaveAsEncoding') as HTMLSelectElement;
		// 改行の select。選択肢は CRLF と LF。初期値は開いたときの指定
		const eolSelect      = dialog.querySelector('#tmsMdeSaveAsEol') as HTMLSelectElement;
		encodingSelect.value = options.defaultEncoding;
		eolSelect.value      = options.defaultEol;

		/**
		 * キャンセルを null として返しつつ、どの終了経路でも背景要素を残さない
		 * @param result - 選んだ保存オプション。キャンセルは null
		 */
		const close = (result: SaveAsOptions | null): void => {
			backdrop.remove();
			resolve(result);
		};

		// 保存を、選んだ文字コードと改行で解決する。ダイアログは close が先に外す
		dialog.querySelector('#tmsMdeSaveAsOk')?.addEventListener('click', () => {
			// 保存に使う文字コードと改行。パスはダイアログの外で決める
			close({
				// 文字コード select の値。選択肢は 4 種で、それ以外は入らない
				encoding: encodingSelect.value as EncodingKind,
				// 改行 select の値。CRLF か LF
				eol: eolSelect.value as EolKind
			});
		});

		// キャンセルは null。文字コードも改行も返さない
		dialog.querySelector('#tmsMdeSaveAsCancel')?.addEventListener('click', () => {
			close(null);
		});

		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * 新規表の列数とデータ行数を入力する
 * 列は 1〜50、データ行は 0〜100 に収める。キャンセルは null
 * @returns 挿入する表の大きさ。キャンセルは null
 */
// prettier-ignore
export function showInsertTableDialog(): Promise<InsertTableOptions | null> {
	return new Promise((resolve) => {
		// ダイアログの背面。選択が終わるまで後ろの操作を遮る。close が文書から外す。この時点ではまだ body に無い
		const backdrop   = createBackdrop();
		// 列数とデータ行数を入れるダイアログ。見出し行は行数に含めない
		const dialog     = document.createElement('div');
		dialog.className = 'tms-mde-dialog';
		dialog.innerHTML = `
			<h2 class="tms-mde-dialog-title">表を挿入</h2>
			<label class="tms-mde-dialog-field">
				<span>列数</span>
				<input id="tmsMdeInsertTableColumns" type="number" min="1" max="50" value="3" />
			</label>
			<label class="tms-mde-dialog-field">
				<span>データ行数（見出し行を除く）</span>
				<input id="tmsMdeInsertTableRows" type="number" min="0" max="100" value="2" />
			</label>
			<div class="tms-mde-dialog-actions">
				<button type="button" id="tmsMdeInsertTableOk">挿入</button>
				<button type="button" id="tmsMdeInsertTableCancel">キャンセル</button>
			</div>
		`;
		// 列数の入力。初期値は 3。確定時に 1〜50 の整数へ収める
		const columns    = dialog.querySelector('#tmsMdeInsertTableColumns') as HTMLInputElement;
		// 見出しを除くデータ行数の入力。初期値は 2。確定時に 0〜100 の整数へ収める
		const rows       = dialog.querySelector('#tmsMdeInsertTableRows') as HTMLInputElement;
		/**
		 * 背景を外してから、表の大きさかキャンセルを返す
		 * @param result - 収めた列数と行数。キャンセルは null
		 */
		const close      = (result: InsertTableOptions | null): void => {
			backdrop.remove();
			resolve(result);
		};
		/**
		 * 入力を整数の許容範囲へ収めてからダイアログを閉じる
		 * 数値でない列は 1、行は 0 として扱う
		 */
		const submit     = (): void => {
			// 1〜50 に収めた列数。空や数値でない入力は 1。小数は切り捨て。単位は列
			const columnCount = clamp(Math.floor(Number(columns.value) || 1), 1, 50);
			// 0〜100 に収めたデータ行数。空や数値でない入力は 0。小数は切り捨て。見出し行は含まない
			const rowCount    = clamp(Math.floor(Number(rows.value) || 0), 0, 100);
			// 収めた列数とデータ行数。見出し行は dataRows に含めない
			close({
				// 1〜50 の列数。空や数値でない入力は 1 に寄せてある
				columns: columnCount,
				// 0〜100 のデータ行数。見出し行は含まない。空や数値でない入力は 0 に寄せてある
				dataRows: rowCount
			});
		};
		// 挿入は範囲へ収めた列数と行数で解決する
		dialog.querySelector('#tmsMdeInsertTableOk')?.addEventListener('click', submit);
		// キャンセルは null。入力値は返さない
		dialog.querySelector('#tmsMdeInsertTableCancel')?.addEventListener('click', () => close(null));
		// Enter で挿入、Escape でキャンセルする。それ以外のキーは入力のままにする
		dialog.addEventListener('keydown', (event) => {
			// Enter は挿入ボタンと同じ。範囲へ収めて閉じる
			if (event.key === 'Enter') submit();
			// Escape はキャンセルとして null を返す。入力は捨てる
			if (event.key === 'Escape') close(null);
		});
		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
		columns.focus();
		columns.select();
	});
}

/**
 * 開いているコンテキストメニューをすべて閉じる
 * 各メニューへ閉じるイベントを出してから DOM から外す
 */
export function dismissContextMenus(): void {
	document.querySelectorAll('.tms-mde-context-menu').forEach((element) => {
		element.dispatchEvent(new CustomEvent(CONTEXT_MENU_DISMISS_EVENT));
		element.remove();
	});
}

/**
 * 基準要素の直下を優先して簡易メニューを表示する
 * すでに開いているメニューは先に閉じる
 * @param anchor - メニューの位置の基準になる要素
 * @param items - 表示する項目。非表示と余分な区切りは除く
 * @param onSelect - 項目 ID を受け取る。区切り線では呼ばない
 */
export function showContextMenu(anchor: HTMLElement, items: ContextMenuEntry[], onSelect: (id: string) => void): void {
	showContextMenuFromRect(anchor.getBoundingClientRect(), items, onSelect);
}

/**
 * マウス座標を基準にコンテキストメニューを表示する
 * 幅の無い点として位置を計算する
 * @param x - ビューポート X。単位は CSS ピクセル
 * @param y - ビューポート Y。単位は CSS ピクセル
 * @param items - 表示する項目。非表示と余分な区切りは除く
 * @param onSelect - 項目 ID を受け取る。区切り線では呼ばない
 */
export function showContextMenuAtPoint(x: number, y: number, items: ContextMenuEntry[], onSelect: (id: string) => void): void {
	// 幅も高さも 0 の点。左右は x、上下は y
	showContextMenuFromRect(
		{
			// 点の左端。右端と同じ座標で、幅は 0
			left: x,
			// 点の右端。左端と同じ座標
			right: x,
			// 点の上端。下端と同じ座標で、高さは 0
			top: y,
			// 点の下端。上端と同じ座標
			bottom: y
		},
		items,
		onSelect
	);
}

// prettier-ignore
/**
 * 非表示項目を除外し、先頭・末尾・連続した区切り線を取り除く
 * 入力の配列は変えない
 * @param items - 設定順のメニュー項目。`hidden` は表示しない
 * @returns 実際に並べる項目。空になることもある
 */
export function compactContextMenuEntries(items: ContextMenuEntry[]): ContextMenuEntry[] {
	// 表示する項目。非表示は含めず、先頭と連続した区切りも入れない。末尾の区切りは後で外す
	const result: ContextMenuEntry[] = [];
	items.filter((item) => !item.hidden).forEach((item) => {
		// 区切り線は、直前が通常項目のときだけ一覧へ残す。先頭と連続は捨てる
		if (item.separator) {
			// まだ項目が無い、または直前も区切りのときはこの区切りを捨てる。どちらか一方だけでも捨てる
			if (result.length === 0 || result.at(-1)?.separator) {
				return;
			}
		}
		result.push(item);
	});

	// 末尾の区切りはメニューの終わりに出せないので外す。通常項目で終わっていれば何もしない
	if (result.at(-1)?.separator) {
		result.pop();
	}
	return result;
}

/**
 * 基準矩形から共通コンテキストメニューを描画する
 * 下に入らなければ上、それも入らなければビューポート内へ寄せる
 * @param anchorRect - メニューを寄せる矩形。点指定では幅も高さも 0
 * @param items - 表示する項目。この関数の中で間引く
 * @param onSelect - 有効な項目を選んだときに ID を渡す
 */
// prettier-ignore
function showContextMenuFromRect(anchorRect: ContextMenuRect, items: ContextMenuEntry[], onSelect: (id: string) => void): void {
	dismissContextMenus();

	// ----- メニュー要素 -----

	// これから出すメニュー。項目を足してから寸法を測る
	const menu     = document.createElement('div');
	menu.className = 'tms-mde-context-menu';
	menu.setAttribute('role', 'menu');

	// ----- 閉じる処理 -----

	/**
	 * メニューの外を押したときに閉じる
	 * メニュー内の押下では閉じない
	 * @param event - 文書で捕捉したマウス押下
	 */
	const onOutsideClick = (event: MouseEvent): void => {
		// 押した節点がメニューの外のときだけ閉じる。メニュー内のボタンでは閉じない
		if (!menu.contains(event.target as Node)) {
			cleanup();
		}
	};

	/**
	 * Escape でメニューを閉じ、そのキーの既定動作を止める
	 * 他のキーはメニュー側では扱わない
	 * @param event - 文書で捕捉したキー
	 */
	const onKeyDown = (event: KeyboardEvent): void => {
		// Escape のときだけ既定動作を止めて閉じる。他のキーはメニューでは扱わない
		if (event.key === 'Escape') {
			event.preventDefault();
			cleanup();
		}
	};

	/**
	 * メニューを外し、閉じるために付けたリスナーを解除する
	 * 二度呼んでも、外れた要素の削除は無害
	 */
	const cleanup = (): void => {
		menu.remove();
		document.removeEventListener('mousedown', onOutsideClick, true);
		document.removeEventListener('keydown', onKeyDown, true);
		menu.removeEventListener(CONTEXT_MENU_DISMISS_EVENT, cleanup);
	};

	// ----- 項目 -----

	compactContextMenuEntries(items).forEach((item) => {
		// 区切りはボタンにせず線だけ足して次へ進む。選択しても ID は返さない
		if (item.separator) {
			// 選択できない区切り線
			const separator     = document.createElement('div');
			separator.className = 'tms-mde-context-menu-separator';
			separator.setAttribute('role', 'separator');
			menu.appendChild(separator);
			return;
		}

		// 1 項目のボタン。無効なら押せない
		const button    = document.createElement('button');
		button.type     = 'button';
		button.disabled = Boolean(item.disabled);
		button.setAttribute('role', 'menuitem');
		// 左に出す項目名。label が未設定の項目は ID を出す。空文字の label はそのまま出す
		const label       = document.createElement('span');
		label.className   = 'tms-mde-context-menu-label';
		label.textContent = item.label ?? item.id;
		button.appendChild(label);
		// 右端のショートカットがある項目だけ足す。無い項目はラベルだけ。空文字もここへは入らない
		if (item.shortcut) {
			// 右端に出すキー表示
			const shortcut       = document.createElement('span');
			shortcut.className   = 'tms-mde-context-menu-shortcut';
			shortcut.textContent = item.shortcut;
			button.appendChild(shortcut);
		}
		// 押せる項目だけ、閉じたあと ID を返す。無効な項目はクリックを受け取らない
		if (!item.disabled) {
			// メニューを外してから、選んだ項目 ID を呼び出し側へ渡す
			button.addEventListener('click', () => {
				cleanup();
				onSelect(item.id);
			});
		}
		menu.appendChild(button);
	});

	// ----- 表示位置 -----

	document.body.appendChild(menu);
	// ビューポート内に収めた左上。単位は CSS ピクセル。下に入らなければ上、それも入らなければ内側へ寄せる
	const position  = calculateContextMenuPosition(
		anchorRect,
		// 項目を足したあとのメニュー寸法。単位は CSS ピクセル
		{
			// 横幅。空でも offsetWidth を使う
			width: menu.offsetWidth,
			// 高さ。下に入るかの判定に使う
			height: menu.offsetHeight
		},
		// ビューポートの大きさ。単位は CSS ピクセル
		{
			// 画面幅。右にはみ出す判定に使う
			width: window.innerWidth,
			// 画面高さ。下にはみ出す判定に使う
			height: window.innerHeight
		}
	);
	menu.style.left = `${position.left}px`;
	menu.style.top  = `${position.top}px`;

	// ----- 閉じるリスナー -----

	// メニューの外を押したときに閉じる。キャプチャ段階で受け、メニュー内では onOutsideClick が戻る
	document.addEventListener('mousedown', onOutsideClick, true);
	// Escape で閉じる。他のキーは onKeyDown が何もしない
	document.addEventListener('keydown', onKeyDown, true);
	// 他のメニューを開く前の一括クローズで、このメニューも外す
	menu.addEventListener(CONTEXT_MENU_DISMISS_EVENT, cleanup);
}

/**
 * 文字コード変更メニューを表示する
 * 選べるのは UTF-8、BOM 付き、CP932、UTF-16LE
 * @param anchor - メニューの位置の基準になる要素
 * @param onSelect - 選んだ文字コード
 */
export function showEncodingMenu(anchor: HTMLElement, onSelect: (encoding: EncodingKind) => void): void {
	showContextMenu(
		anchor,
		[
			// BOM 無しの UTF-8
			{
				// 選択結果の ID。EncodingKind の utf8
				id: 'utf8',
				// 項目に出す文言。ID ではなく表示用ラベル
				label: formatEncodingLabel('utf8')
			},
			// BOM 付き UTF-8
			{
				// 選択結果の ID。EncodingKind の utf8Bom
				id: 'utf8Bom',
				// 項目に出す文言。BOM 付きと分かるラベル
				label: formatEncodingLabel('utf8Bom')
			},
			// CP932
			{
				// 選択結果の ID。EncodingKind の cp932
				id: 'cp932',
				// 項目に出す文言。表示は CP932
				label: formatEncodingLabel('cp932')
			},
			// UTF-16 リトルエンディアン
			{
				// 選択結果の ID。EncodingKind の utf16Le
				id: 'utf16Le',
				// 項目に出す文言。表示は UTF-16LE
				label: formatEncodingLabel('utf16Le')
			}
		],
		(id) => onSelect(id as EncodingKind)
	);
}

/**
 * 指定文字コードで再読込するための選択ダイアログを表示する
 * 未保存のファイルは再読込できない旨を示し、キャンセルは null
 * @param defaultEncoding - 開いたときに選んでおく文字コード
 * @returns 再読込に使う文字コード。キャンセルは null
 */
// prettier-ignore
export function showReloadEncodingDialog(defaultEncoding: EncodingKind): Promise<EncodingKind | null> {
	return new Promise((resolve) => {
		// ダイアログの背面。選択が終わるまで後ろの操作を遮る。close が文書から外す。この時点ではまだ body に無い
		const backdrop   = createBackdrop();
		// 再読込する文字コードを選ぶダイアログ。未保存では再読込できない旨を示す
		const dialog     = document.createElement('div');
		dialog.className = 'tms-mde-dialog';
		dialog.innerHTML = `<h2 class="tms-mde-dialog-title">指定の文字コードで再読込</h2><p class="tms-mde-dialog-message">未保存の変更があるファイルは再読込できません。</p><label class="tms-mde-dialog-field"><span>文字コード</span><select id="tmsMdeReloadEncoding"><option value="utf8">UTF-8</option><option value="utf8Bom">UTF-8(BOM)</option><option value="cp932">CP932</option><option value="utf16Le">UTF-16LE</option></select></label><div class="tms-mde-dialog-actions"><button type="button" id="tmsMdeReloadOk">再読込</button><button type="button" id="tmsMdeReloadCancel">キャンセル</button></div>`;
		// 文字コードの select。選択肢は UTF-8、BOM 付き、CP932、UTF-16LE。初期値は開いている文字コード
		const select     = dialog.querySelector('#tmsMdeReloadEncoding') as HTMLSelectElement;
		select.value     = defaultEncoding;
		/**
		 * 再読込を中止した場合は null を返し、現在の文字コードを維持させる
		 * @param result - 選んだ文字コード。キャンセルは null
		 */
		const close      = (result: EncodingKind | null): void => {
			backdrop.remove();
			resolve(result);
		};
		// 再読込を、選んだ文字コードで解決する。ダイアログは close が先に外す
		dialog.querySelector('#tmsMdeReloadOk')?.addEventListener('click', () => close(select.value as EncodingKind));
		// キャンセルは null。今の文字コードを維持する
		dialog.querySelector('#tmsMdeReloadCancel')?.addEventListener('click', () => close(null));
		backdrop.appendChild(dialog);
		document.body.appendChild(backdrop);
	});
}

/**
 * 改行コード変換メニューを表示する
 * 選べるのは CRLF と LF
 * @param anchor - メニューの位置の基準になる要素
 * @param onSelect - 選んだ改行
 */
export function showEolConvertMenu(anchor: HTMLElement, onSelect: (eol: EolKind) => void): void {
	showContextMenu(
		anchor,
		[
			// CRLF へ統一する項目。混在の注記は付けない
			{
				// 選択結果の ID。EolKind の crlf
				id: 'crlf',
				// 項目に出す文言。混在ではないので CRLF だけ
				label: formatEolLabel('crlf', false)
			},
			// LF へ統一する項目。混在の注記は付けない
			{
				// 選択結果の ID。EolKind の lf
				id: 'lf',
				// 項目に出す文言。混在ではないので LF だけ
				label: formatEolLabel('lf', false)
			}
		],
		(id) => onSelect(id as EolKind)
	);
}

/**
 * エラーメッセージをブラウザの警告ダイアログで表示する
 * 閉じるまで呼び出し側は待つ
 * @param message - 表示する説明。整形はしない
 */
export function showErrorMessage(message: string): void {
	window.alert(message);
}

/**
 * コンテキストメニューの表示位置を算出する
 * 下に入れば基準の下、入らなければ上、それも入らなければビューポート内へ寄せる
 * @param anchorRect - メニューを寄せる矩形
 * @param menuSize - 表示するメニューの幅と高さ
 * @param viewportSize - 画面の幅と高さ
 * @returns ビューポート内に収めた左上
 */
// prettier-ignore
export function calculateContextMenuPosition(anchorRect: ContextMenuRect, menuSize: ContextMenuSize, viewportSize: ContextMenuSize): ContextMenuPosition {
	// 右端の余白を残した左端の上限。単位は CSS ピクセル。メニューが画面より広いと負になり、そのときは左の余白へ寄せる
	const maxLeft = viewportSize.width - menuSize.width - CONTEXT_MENU_VIEWPORT_MARGIN;
	// 基準の左端を、左余白と上限の間へ収めた値。単位は CSS ピクセル。画面より広いメニューは左余白に張り付く
	const left    = clamp(anchorRect.left, CONTEXT_MENU_VIEWPORT_MARGIN, Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, maxLeft));

	// 基準の下に間隔を空けた上端。単位は CSS ピクセル。ここからメニューが高さ分下へ伸びる
	const belowTop = anchorRect.bottom + CONTEXT_MENU_GAP;
	// 基準の上にメニューを載せたときの上端。単位は CSS ピクセル。上の余白より小さいとはみ出す
	const aboveTop = anchorRect.top - menuSize.height - CONTEXT_MENU_GAP;
	// 下端の余白を残した上端の上限。単位は CSS ピクセル
	const maxTop   = viewportSize.height - menuSize.height - CONTEXT_MENU_VIEWPORT_MARGIN;

	// 下に置くと画面内に収まるときだけ基準の下へ出す。収まらないときは上を検討する
	if (belowTop <= maxTop) {
		// 基準の下へ置く左上。左は横方向に収めた値
		return {
			// 画面の左右余白の内側へ収めた左端。単位は CSS ピクセル
			left,
			// 基準の下端に間隔を足した上端。単位は CSS ピクセル
			top: belowTop
		};
	}

	// 上に置くと上端の余白を割らないときだけ基準の上へ出す。下にも上にも入らないときはこの分岐に入らない
	if (aboveTop >= CONTEXT_MENU_VIEWPORT_MARGIN) {
		// 基準の上へ置く左上。左は横方向に収めた値
		return {
			// 画面の左右余白の内側へ収めた左端。単位は CSS ピクセル
			left,
			// 基準の上にメニューの高さ分戻した上端。単位は CSS ピクセル
			top: aboveTop
		};
	}

	// 下にも上にも置き切れないときの左上。画面内の余白へ寄せる
	return {
		// 横方向に収めた左端。下にも上にも置けないときも左は同じ
		left,
		// 下に置こうとした上端を、上下の余白の内側へ寄せた値。単位は CSS ピクセル
		top: clamp(belowTop, CONTEXT_MENU_VIEWPORT_MARGIN, Math.max(CONTEXT_MENU_VIEWPORT_MARGIN, maxTop))
	};
}

/**
 * 数値を指定範囲内に丸める
 * `min` が `max` より大きいときは `Math.min` と `Math.max` の順に従い `min` 側へ寄る
 * @param value - 丸める値
 * @param min - 下限
 * @param max - 上限
 * @returns `min` 以上 `max` 以下の値
 */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * ダイアログの背面を覆う要素を生成する
 * まだ文書へは足さない
 * @returns 背面用の空の div
 */
// prettier-ignore
function createBackdrop(): HTMLDivElement {
	// ダイアログの背面。この関数では文書へ足さない。呼び出し側が body へ足す
	const backdrop     = document.createElement('div');
	backdrop.className = 'tms-mde-dialog-backdrop';
	return backdrop;
}

/**
 * ダイアログ文言に埋め込む文字列をエスケープする
 * `&` `<` `>` `"` を実体参照にする
 * @param value - エスケープ前の表示名
 * @returns テキストとして安全な文字列
 */
function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
