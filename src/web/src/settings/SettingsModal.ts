/**
 * 設定ダイアログを組み立て、変更を C# へ保存して画面へ返す
 * 設定ファイルの場所はブリッジに任せ、このモジュールは入力と表示を持つ
 * @file
 */
import { BRIDGE_METHOD, invokeBridge } from '../bridge';
import { isCssHexColor, toColorInputValue } from '../app/imageBorder';
import type { AppSettings, ConfigGetResponse, ContextMenuSettings, CustomDecorationRule, CssSnippetsResponse, DataDirInfo, KeybindingsSettings, MigrateDataDirResponse, PickFolderResult, SaveConfigResponse } from '../types/app';
import { findShortcutConflicts, isKnownWindowsReservedShortcut, shortcutFromKeyboardEvent } from '../utils/keybindings';
import { createNewCustomDecorationRule, normalizeCustomDecorationRules, validateCustomDecorationRules } from './customDecorationRules';
import { getCssSnippetsReloadStatus } from './cssSnippets';
import { CONTEXT_MENU_ITEM_LABELS, createDefaultContextMenuSettings, isContextMenuSeparator, moveContextMenuItem, normalizeContextMenuSettings, type ContextMenuKind } from './contextMenuSettings';

/**
 * 設定ダイアログを開くときに渡す現在値と、保存後の反映先
 * ダイアログはこれを複製して編集し、成功したときだけコールバックを呼ぶ
 */
type SettingsModalOptions = {
	/** 開いた時点の画面設定。ダイアログ内では複製して編集する */
	settings: AppSettings;
	/** 開いた時点のカスタム装飾。無効なルールも含む */
	customDecorations: CustomDecorationRule[];
	/** データディレクトリの場所 */
	dataDirInfo: DataDirInfo;
	/** ポータブル起動か。未設定のときは dataDirInfo 側を見る */
	isPortable?: boolean;
	/** 開いた時点の CSS スニペット一覧 */
	cssSnippets: CssSnippetsResponse;
	/** 添付フォルダが空のときに示す既定パス。不明なら未設定 */
	defaultAttachmentFolder?: string;
	/**
	 * 設定の保存に成功したとき、新しい設定を画面へ渡す
	 * @param settings - 保存後の画面設定
	 */
	onSettingsApplied: (settings: AppSettings) => void;
	/**
	 * 装飾ルールの保存に成功したとき、新しいルールを画面へ渡す
	 * @param rules - 保存後のルール。無効なものも含む
	 */
	onCustomDecorationsApplied: (rules: CustomDecorationRule[]) => void;
	/**
	 * スニペットの読み直しに成功したとき、一覧を画面へ渡す
	 * @param response - 読み直したスニペット
	 */
	onCssSnippetsApplied: (response: CssSnippetsResponse) => void;
};

/** 設定の 1 入力。テキスト、数値、チェック、選択のいずれか */
type SettingControl = HTMLInputElement | HTMLSelectElement;

/**
 * 設定キーと、その値を出す入力の対応
 * 再描画のたびに作り直す
 */
type ControlBinding = {
	/** `outline.width` のようなドット区切りの設定キー */
	key: string;
	/** そのキーを表示している入力 */
	control: SettingControl;
};

/**
 * 設定画面に出す 1 つのショートカット
 * 固定のショートカットはここには含めない
 */
type KeybindingDefinition = {
	/** `KeybindingsSettings` のプロパティ名 */
	key: keyof KeybindingsSettings;
	/** 画面に出す操作名 */
	label: string;
};

/**
 * 変更できるショートカットの表示順
 * 実行中には変えない
 */
const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
	{ key: 'newFile', label: '新規作成' },
	{ key: 'openFile', label: 'ファイルを開く' },
	{ key: 'save', label: '保存' },
	{ key: 'saveAs', label: '名前を付けて保存' },
	{ key: 'closeTab', label: 'タブを閉じる' },
	{ key: 'nextTab', label: '次のタブ' },
	{ key: 'prevTab', label: '前のタブ' },
	{ key: 'find', label: '検索' },
	{ key: 'replace', label: '置換' },
	{ key: 'findNext', label: '次を検索' },
	{ key: 'findPrev', label: '前を検索' },
	{ key: 'toggleViewMode', label: '表示モード切替' },
	{ key: 'toggleOutline', label: 'アウトラインを表示 / 非表示' },
	{ key: 'splitHorizontal', label: '上下分割' },
	{ key: 'splitVertical', label: '左右分割' },
	{ key: 'unsplit', label: '分割解除' },
	{ key: 'toggleCheckbox', label: 'チェックボックス切替' },
	{ key: 'exportHtml', label: 'HTMLとしてエクスポート' },
	{ key: 'exportPdf', label: 'PDFとしてエクスポート' },
	{ key: 'print', label: '印刷' },
	{ key: 'pastePlain', label: 'プレーンテキストとして貼り付け' }
];

/**
 * 設定では変えられないショートカットの表示
 * キーは画面の操作名、値は押すキー
 */
const FIXED_SHORTCUTS: Record<string, string> = {
	元に戻す: 'Ctrl+Z',
	やり直し: 'Ctrl+Y',
	フォントサイズ拡大: 'Ctrl+Shift+=',
	フォントサイズ縮小: 'Ctrl+-',
	フォントサイズリセット: 'Ctrl+0'
};

/**
 * 設定ダイアログ
 * 開いているあいだの編集値を持ち、保存に成功した分だけ呼び出し元へ返す
 */
export class SettingsModal {
	/** 編集中の画面設定。開くときに複製し、保存成功で更新する */
	private settings: AppSettings;

	/** 編集中のカスタム装飾。開くときに複製する */
	private customDecorations: CustomDecorationRule[];

	/** 現在のデータディレクトリ。移動に成功すると更新する */
	private dataDirInfo: DataDirInfo;

	/** ポータブル起動か。true のときはデータディレクトリを動かせない */
	private readonly isPortable: boolean;

	/** 最新のスニペット一覧。再読込で置き換わる */
	private cssSnippets: CssSnippetsResponse;

	/** 添付フォルダが空のときに入力へ示す既定パス。不明なら空文字 */
	private readonly defaultAttachmentFolder: string;

	/** 開いたときに渡された設定と、保存後のコールバック */
	private readonly options: SettingsModalOptions;

	/** ダイアログの背面。閉じると文書から外す */
	private readonly backdrop: HTMLDivElement;

	/** ダイアログ本体。再描画のたびに中身を空にする */
	private readonly content: HTMLDivElement;

	/** 保存結果を出す状態行 */
	private readonly status: HTMLParagraphElement;

	/** いま画面にある入力と設定キー。再描画で作り直す */
	private readonly bindings: ControlBinding[] = [];

	/** スニペットのチェック一覧。描画前は null */
	private snippetsList: HTMLDivElement | null = null;

	/** スニペットフォルダのパス表示。描画前は null */
	private snippetDirectoryPath: HTMLParagraphElement | null = null;

	/** スニペット読み込みエラーの表示。描画前は null */
	private snippetError: HTMLParagraphElement | null = null;

	/** データディレクトリのパス入力。描画前は null */
	private dataDirInput: HTMLInputElement | null = null;

	/** データディレクトリを既定へ戻すボタン。描画前は null */
	private dataDirResetButton: HTMLButtonElement | null = null;

	/** 外部ブラウザのコマンド行。描画前は null */
	private externalBrowserCommandRow: HTMLDivElement | null = null;

	/** 外部ブラウザのコマンド入力。描画前は null */
	private externalBrowserCommandInput: HTMLInputElement | null = null;

	/** カスタム装飾の一覧。描画前は null */
	private decorationsList: HTMLDivElement | null = null;

	/** 装飾ルールを追加するボタン。保存中は無効にする */
	private decorationAddButton: HTMLButtonElement | null = null;

	/** メニュー種別から、その項目一覧の要素 */
	private readonly contextMenuLists = new Map<ContextMenuKind, HTMLDivElement>();

	/**
	 * 設定ダイアログの要素を作り、渡された設定は複製して持つ
	 * この時点では文書へ出さない
	 * @param options - 現在の設定と、保存後に画面へ戻すコールバック
	 */
	public constructor(options: SettingsModalOptions) {
		// 編集途中のUI操作で呼び出し元の設定オブジェクトを書き換えないよう、可変部分を複製して保持する
		this.options                 = options;
		this.settings                = { ...options.settings, contextMenu: normalizeContextMenuSettings(options.settings.contextMenu) };
		this.customDecorations       = options.customDecorations.map((rule) => ({ ...rule }));
		this.dataDirInfo             = options.dataDirInfo;
		this.isPortable              = options.isPortable === true || options.dataDirInfo.isPortable === true;
		this.cssSnippets             = options.cssSnippets;
		this.defaultAttachmentFolder = options.defaultAttachmentFolder ?? '';
		this.backdrop                = document.createElement('div');
		this.content                 = document.createElement('div');
		this.status                  = document.createElement('p');

		this.backdrop.className = 'tms-mde-dialog-backdrop tms-mde-settings-backdrop';
		// Escape でダイアログを閉じる。他のキーは入力のままにする
		this.backdrop.addEventListener('keydown', (event) => {
			// Escape のときだけ閉じる。入力中の文字キーでは閉じない
			if (event.key === 'Escape') {
				event.preventDefault();
				this.close();
			}
		});

		this.content.className = 'tms-mde-settings-dialog';
		this.content.setAttribute('role', 'dialog');
		this.content.setAttribute('aria-modal', 'true');
		this.content.setAttribute('aria-labelledby', 'tmsMdeSettingsTitle');

		this.status.className = 'tms-mde-settings-status';
		this.status.setAttribute('role', 'status');
	}

	/**
	 * ダイアログを描いて文書へ出す
	 * 最初のナビ項目へフォーカスする
	 */
	public open(): void {
		this.render();
		this.backdrop.appendChild(this.content);
		document.body.appendChild(this.backdrop);
		this.content.querySelector<HTMLButtonElement>('.tms-mde-settings-nav-button')?.focus();
	}

	// ----------------------------------------------
	// 画面の構築
	// ----------------------------------------------

	/**
	 * ダイアログの中身を空にして、各セクションを描き直す
	 * データディレクトリ変更後も、古い入力の参照を残さない
	 */
	private render(): void {
		// dataDir変更後などの再構築でも古いDOM参照を使わないよう、バインド情報から作り直す
		this.content.innerHTML = '';
		this.bindings.length   = 0;
		this.contextMenuLists.clear();

		// タイトルと閉じるボタンを置くヘッダー
		const header     = document.createElement('header');
		header.className = 'tms-mde-settings-header';

		// ダイアログの名前。aria-labelledby がこの id を指す
		const title       = document.createElement('h2');
		title.id          = 'tmsMdeSettingsTitle';
		title.textContent = '設定';

		// ダイアログを閉じるボタン。保存はしない
		const closeButton       = document.createElement('button');
		closeButton.type        = 'button';
		closeButton.className   = 'tms-mde-settings-close';
		closeButton.textContent = '閉じる';
		// クリックでダイアログを閉じる。未保存の入力はその場の値のまま残る
		closeButton.addEventListener('click', () => this.close());
		header.append(title, closeButton);

		// 左のナビと右の節を横に並べる領域
		const layout         = document.createElement('div');
		layout.className     = 'tms-mde-settings-layout';
		// 節を切り替えるボタンの並び
		const navigation     = document.createElement('nav');
		navigation.className = 'tms-mde-settings-navigation';
		navigation.setAttribute('aria-label', '設定分類');
		// 各節の本体。一度に表示するのは一つ
		const sections     = document.createElement('div');
		sections.className = 'tms-mde-settings-sections';

		// ナビゲーションと対応セクションを同時に登録し、data-sectionを切替キーとして共有する
		this.addSection(navigation, sections, 'appearance', '外観', (section) => this.renderAppearance(section));
		this.addSection(navigation, sections, 'editor', 'エディタ', (section) => this.renderEditor(section));
		this.addSection(navigation, sections, 'save', '保存', (section) => this.renderSave(section));
		this.addSection(navigation, sections, 'file', 'ファイル・起動', (section) => this.renderFileAndStartup(section));
		this.addSection(navigation, sections, 'export', 'エクスポート', (section) => this.renderExport(section));
		this.addSection(navigation, sections, 'snippets', 'CSSスニペット', (section) => this.renderSnippets(section));
		this.addSection(navigation, sections, 'decorations', 'カスタム装飾', (section) => this.renderCustomDecorations(section));
		this.addSection(navigation, sections, 'contextMenu', '右クリック', (section) => this.renderContextMenus(section));
		this.addSection(navigation, sections, 'keyboard', 'キーボード', (section) => this.renderKeyboard(section));
		this.addSection(navigation, sections, 'data', 'データ・更新', (section) => this.renderDataAndUpdate(section));

		layout.append(navigation, sections);

		// リセットとステータスを置くフッター
		const footer         = document.createElement('footer');
		footer.className     = 'tms-mde-settings-footer';
		// 全設定を既定へ戻すボタン。確認は resetAll 側で行う
		const resetAll       = document.createElement('button');
		resetAll.type        = 'button';
		resetAll.className   = 'tms-mde-settings-danger';
		resetAll.textContent = 'すべてリセット';
		// クリックで全項目を既定へ戻す。失敗してもダイアログは開いたまま
		resetAll.addEventListener('click', () => void this.resetAll());
		footer.append(resetAll, this.status);

		this.content.append(header, layout, footer);
		this.activateSection('appearance');
	}

	/**
	 * 左のナビと右の節を 1 つ足す
	 * ナビを押すとその節だけを表示する
	 * @param navigation - 節のボタンを足すナビ
	 * @param sections - 節の本体を足す領域
	 * @param id - 節の識別子。表示の切り替えに使う
	 * @param label - ナビに出す名前
	 * @param renderer - 節の中身を作る関数。引数はその節の要素
	 */
	private addSection(navigation: HTMLElement, sections: HTMLElement, id: string, label: string, renderer: (section: HTMLElement) => void): void {
		// この節を表示するナビボタン
		const button           = document.createElement('button');
		button.type            = 'button';
		button.className       = 'tms-mde-settings-nav-button';
		button.dataset.section = id;
		button.textContent     = label;
		// クリックでこの節だけを表示する。他の節は隠す
		button.addEventListener('click', () => this.activateSection(id));
		navigation.appendChild(button);

		// この節の本体。最初は隠す
		const section           = document.createElement('section');
		section.className       = 'tms-mde-settings-section';
		section.dataset.section = id;
		section.hidden          = true;
		// 節の見出し。ナビの名前と同じ文言
		const heading           = document.createElement('h3');
		heading.textContent     = label;
		section.appendChild(heading);
		renderer(section);
		sections.appendChild(section);
	}

	/**
	 * 指定した節だけを表示し、ナビの押下状態を合わせる
	 * @param id - 表示する節の識別子
	 */
	private activateSection(id: string): void {
		// 表示領域とaria-currentを同じ条件で更新し、見た目と読み上げ状態を一致させる
		this.content.querySelectorAll<HTMLElement>('.tms-mde-settings-section').forEach((section) => {
			section.hidden = section.dataset.section !== id;
		});
		this.content.querySelectorAll<HTMLButtonElement>('.tms-mde-settings-nav-button').forEach((button) => {
			// このボタンが選ばれた節か。違う節は aria-current を false にする
			const active = button.dataset.section === id;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-current', active ? 'page' : 'false');
		});
	}

	// ----------------------------------------------
	// 設定項目
	// ----------------------------------------------

	/**
	 * テーマなど、見た目の入力を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderAppearance(section: HTMLElement): void {
		this.addSelect(section, 'theme', 'テーマ', [
			['system', 'システム'],
			['dark', 'ダーク'],
			['light', 'ライト']
		]);
		this.addText(section, 'editorFontFamily', 'エディタフォント');
		this.addText(section, 'codeFontFamily', 'コードブロックフォント');
		this.addNumber(section, 'editorFontSize', 'フォントサイズ', 8, 72);
		this.addCheckbox(section, 'showLineNumbers', '行番号を表示する');
		this.addCheckbox(section, 'showEolMarkers', '改行記号を表示する');
		this.addCheckbox(section, 'wordWrap', '折り返し表示');
		this.addCheckbox(section, 'outline.visible', '起動時にアウトラインを表示する');
		this.addSelect(section, 'outline.side', 'アウトラインの位置', [
			['left', '左'],
			['right', '右']
		]);
	}

	/**
	 * 書き出しの入力を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderExport(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'HTMLファイルに付ける見出し一覧です。印刷とPDFでは表示しません。位置は出力HTML内の切り替えで閲覧者が選べます。';
		section.appendChild(description);
		this.addCheckbox(section, 'export.outline.enabled', 'HTML出力にアウトラインを含める');
	}

	/**
	 * フォント、折り返し、タブ幅など、編集の入力を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderEditor(section: HTMLElement): void {
		this.addSelect(section, 'defaultViewMode', '既定の表示モード', [
			['live-preview', 'ライブプレビュー'],
			['source', 'ソース']
		]);
		this.addNumber(section, 'tabSize', 'タブ幅', 1, 8);
		this.addNumber(section, 'largeFileThresholdMb', 'ライブプレビュー無効化サイズ (MB)', 1, 100);
		this.addCheckbox(section, 'loadRemoteImages', 'リモート画像を読み込む');
		this.renderAttachmentFolder(section);
		this.renderImageBorder(section);
		this.addCheckbox(section, 'search.restoreCalloutFoldStateOnMove', '検索移動後にコールアウトの折りたたみを戻す');
	}

	/**
	 * 添付フォルダの入力と、フォルダを選ぶボタンを節へ足す
	 * @param section - 入力を足す節
	 */
	private renderAttachmentFolder(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'クリップボードから貼り付けた画像の保存先です。空欄のときはピクチャフォルダ配下の既定パスを使います。OneDrive 配下や UNC パスも指定できます。';
		section.appendChild(description);

		const row         = document.createElement('div');
		row.className     = 'tms-mde-settings-row';
		const label       = document.createElement('span');
		label.className   = 'tms-mde-settings-label';
		label.textContent = '貼り付け画像の保存先';
		const input       = document.createElement('input');
		input.type        = 'text';
		input.value       = String(this.getValue('attachmentFolder') ?? '');
		input.placeholder = this.defaultAttachmentFolder;
		input.setAttribute('aria-label', '貼り付け画像の保存先');
		// 入力を確定したときだけ保存する。打鍵の途中では保存しない
		input.addEventListener('change', () => void this.saveValue('attachmentFolder', input.value, input));
		const actions      = document.createElement('div');
		actions.className  = 'tms-mde-settings-row-actions';
		const browse       = document.createElement('button');
		browse.type        = 'button';
		browse.textContent = '参照';
		// クリックでフォルダ選択を開き、選ばれたパスを入力へ入れる
		browse.addEventListener('click', () => void this.pickAttachmentFolder(input));
		const reset       = document.createElement('button');
		reset.type        = 'button';
		reset.className   = 'tms-mde-settings-reset';
		reset.textContent = 'リセット';
		reset.setAttribute('aria-label', '貼り付け画像の保存先をリセット');
		// クリックで保存先を既定へ戻す。ボタンの送信は止める
		reset.addEventListener('click', (event) => {
			event.preventDefault();
			void this.resetItem('attachmentFolder');
		});
		actions.append(browse, reset);
		row.append(label, input, actions);
		section.appendChild(row);
		this.bindings.push({ key: 'attachmentFolder', control: input });
	}

	/**
	 * 画像枠線の太さと色の入力を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderImageBorder(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'ライブプレビューの画像に付ける枠線です。ホバー時の色を空欄にすると、テーマのアクセント色を使います。太さ 0 で枠線を非表示にできます。';
		section.appendChild(description);
		this.addNumber(section, 'imageBorder.width', '画像の枠線の太さ (px)', 0, 8);
		this.addColor(section, 'imageBorder.color', '画像の枠線の色');
		this.addNumber(section, 'imageBorder.hoverWidth', 'ホバー時の枠線の太さ (px)', 0, 16);
		this.addColor(section, 'imageBorder.hoverColor', 'ホバー時の枠線の色', {
			allowEmpty: true,
			emptyPlaceholder: 'テーマのアクセント',
			pickerFallback: '#2563eb'
		});
	}

	/**
	 * フォルダ選択を C# に頼み、選んだパスを入力へ書く
	 * キャンセルしたときは入力を変えない
	 * @param input - 選んだパスを書き込む入力
	 */
	private async pickAttachmentFolder(input: HTMLInputElement): Promise<void> {
		try {
			const result = await invokeBridge<PickFolderResult>(BRIDGE_METHOD.shellPickFolder);
			if (result.canceled || !result.path) {
				return;
			}

			await this.saveValue('attachmentFolder', result.path, input);
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * 新規ファイルの文字コードと改行の入力を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderSave(section: HTMLElement): void {
		this.addSelect(section, 'newFileEncoding', '新規ファイルの文字コード', [
			['utf8', 'UTF-8'],
			['utf8Bom', 'UTF-8 (BOM)'],
			['cp932', 'CP932'],
			['utf16Le', 'UTF-16LE']
		]);
		this.addSelect(section, 'newFileEol', '新規ファイルの改行コード', [
			['crlf', 'CRLF'],
			['lf', 'LF']
		]);
	}

	/**
	 * 外部変更、ウィンドウの開き方、起動時の復元の入力を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderFileAndStartup(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'インスタンスモードの変更は次回起動時から反映されます。';
		section.appendChild(description);
		this.addSelect(section, 'externalChangeBehavior', '外部変更時の挙動（未編集時）', [
			['auto-reload', '自動で再読込'],
			['confirm', '確認する']
		]);
		this.addSelect(section, 'instanceMode', 'インスタンスモード（次回起動から）', [
			['single-instance', '単一インスタンス'],
			['new-window', '常に新しいウィンドウ']
		]);
		this.addCheckbox(section, 'restoreSessionOnStartup', '起動時に前回開いていたタブを復元する');
		this.addCheckbox(section, 'closeAppWhenLastTabClosed', '最後のタブを閉じたらアプリを終了する');
		this.renderExternalBrowser(section);
	}

	/**
	 * 外部リンクを開くブラウザの入力を節へ足す
	 * カスタム以外のときはコマンド欄を隠す
	 * @param section - 入力を足す節
	 */
	private renderExternalBrowser(section: HTMLElement): void {
		const note       = document.createElement('p');
		note.className   = 'tms-mde-settings-description';
		note.textContent = 'Markdownリンクの http(s) URL を開くブラウザを指定します。';
		section.appendChild(note);

		this.addSelect(section, 'externalBrowser.mode', '外部リンクの起動ブラウザ', [
			['default', '既定のブラウザ'],
			['custom', 'カスタム']
		]);
		this.externalBrowserCommandRow   = this.addText(section, 'externalBrowser.customCommand', 'カスタム起動コマンド');
		this.externalBrowserCommandInput = this.externalBrowserCommandRow.querySelector<HTMLInputElement>('input');
		this.externalBrowserCommandInput?.setAttribute('placeholder', 'firefox.exe -p "MyProfile_profile1"');
		this.updateExternalBrowserCommandVisibility();
	}

	/**
	 * CSS スニペットの一覧と、再読込、フォルダを開く操作を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderSnippets(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'dataDir の snippets フォルダにある .css ファイルのうち、一覧で有効にしたファイルをWeb UI全体へ適用します。ファイルを追加・変更した後は再読み込みしてください。';
		section.appendChild(description);
		this.snippetDirectoryPath           = document.createElement('p');
		this.snippetDirectoryPath.className = 'tms-mde-settings-description';
		section.appendChild(this.snippetDirectoryPath);
		this.snippetError           = document.createElement('p');
		this.snippetError.className = 'tms-mde-settings-description';
		section.appendChild(this.snippetError);
		this.updateSnippetDirectoryInfo();

		const toolbar            = document.createElement('div');
		toolbar.className        = 'tms-mde-settings-toolbar';
		const reloadButton       = document.createElement('button');
		reloadButton.type        = 'button';
		reloadButton.textContent = '再読み込み';
		// クリックでスニペット一覧を読み直し、画面へ入れ替える
		reloadButton.addEventListener('click', () => void this.reloadSnippets());
		const openButton       = document.createElement('button');
		openButton.type        = 'button';
		openButton.textContent = 'フォルダを開く';
		// クリックでスニペットフォルダをエクスプローラーで開く
		openButton.addEventListener('click', () => void this.openSnippetsFolder());
		const resetButton       = document.createElement('button');
		resetButton.type        = 'button';
		resetButton.textContent = 'すべて無効にする';
		// クリックでスニペット全体の有効設定を既定へ戻す
		resetButton.addEventListener('click', () => void this.resetItem('cssSnippets.enabled'));
		toolbar.append(reloadButton, openButton, resetButton);

		this.snippetsList           = document.createElement('div');
		this.snippetsList.className = 'tms-mde-settings-snippets';
		section.append(toolbar, this.snippetsList);
		this.renderSnippetList();
	}

	// ----------------------------------------------
	// カスタム装飾
	// ----------------------------------------------

	/**
	 * カスタム装飾の一覧と追加ボタンを節へ足す
	 * @param section - 入力を足す節
	 */
	private renderCustomDecorations(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = '正規表現に一致した文字列へCSSクラスを付け、ライブプレビューで独自のインライン装飾を表示します。';
		const example           = document.createElement('p');
		example.className       = 'tms-mde-settings-description';
		example.textContent     = '例：pattern「_v(.+?)_v」、区切り記号を隠す、CSSクラス「tms-custom-1」を設定すると、_v装飾サンプル文字列_v の「装飾サンプル文字列」が装飾対象になります。表示スタイルはCSSスニペットの「.tms-custom-1」に定義し、CSSスニペット画面でそのファイルを有効にして再読み込みしてください。';

		const toolbar         = document.createElement('div');
		toolbar.className     = 'tms-mde-settings-toolbar';
		const addButton       = document.createElement('button');
		addButton.type        = 'button';
		addButton.textContent = 'ルールを追加';
		// クリックで無効の新規ルールを末尾へ足して保存する
		addButton.addEventListener('click', () => void this.addCustomDecoration());
		this.decorationAddButton = addButton;
		toolbar.appendChild(addButton);

		this.decorationsList           = document.createElement('div');
		this.decorationsList.className = 'tms-mde-settings-decorations';
		section.append(description, example, toolbar, this.decorationsList);
		this.renderCustomDecorationList();
	}

	/**
	 * 装飾ルールごとの入力を、いまの配列から描き直す
	 */
	private renderCustomDecorationList(): void {
		if (!this.decorationsList) {
			return;
		}

		// 追加・削除でインデックスが変わるため、部分更新せず一覧とdata属性をまとめて再生成する
		this.decorationsList.innerHTML = '';
		if (this.customDecorations.length === 0) {
			const empty       = document.createElement('p');
			empty.className   = 'tms-mde-settings-description';
			empty.textContent = 'カスタム装飾ルールはありません。「ルールを追加」から作成できます。';
			this.decorationsList.appendChild(empty);
			return;
		}

		this.customDecorations.forEach((rule, index) => {
			const card         = document.createElement('fieldset');
			card.className     = 'tms-mde-settings-decoration';
			const legend       = document.createElement('legend');
			legend.textContent = `ルール ${index + 1}`;

			const header           = document.createElement('div');
			header.className       = 'tms-mde-settings-decoration-header';
			const enabledLabel     = document.createElement('label');
			enabledLabel.className = 'tms-mde-settings-decoration-check';
			const enabled          = document.createElement('input');
			enabled.type           = 'checkbox';
			enabled.checked        = rule.enabled !== false;
			// チェックの変更でそのルールの有効だけを保存する
			enabled.addEventListener(
				'change',
				() =>
					void this.changeCustomDecoration(
						index,
						{
							enabled: enabled.checked
						},
						enabled
					)
			);
			enabledLabel.append(enabled, document.createTextNode('有効'));
			const remove       = document.createElement('button');
			remove.type        = 'button';
			remove.className   = 'tms-mde-settings-danger';
			remove.textContent = '削除';
			// クリックでこのルールを一覧から外して保存する
			remove.addEventListener('click', () => void this.removeCustomDecoration(index));
			header.append(enabledLabel, remove);

			const fields     = document.createElement('div');
			fields.className = 'tms-mde-settings-decoration-fields';
			fields.append(this.createDecorationTextField(index, 'name', 'ルール名', rule.name, '例：下線'), this.createDecorationTextField(index, 'pattern', '正規表現', rule.pattern, '例：_v(.+?)_v'), this.createDecorationTextField(index, 'cssClass', 'CSSクラス', rule.cssClass, '例：tms-custom-1'));

			const hideLabel     = document.createElement('label');
			hideLabel.className = 'tms-mde-settings-decoration-check';
			const hide          = document.createElement('input');
			hide.type           = 'checkbox';
			hide.checked        = Boolean(rule.hideDelimiters);
			// チェックの変更で区切りを隠すかだけを保存する
			hide.addEventListener(
				'change',
				() =>
					void this.changeCustomDecoration(
						index,
						{
							hideDelimiters: hide.checked
						},
						hide
					)
			);
			hideLabel.append(hide, document.createTextNode('最初のキャプチャグループの前後にある区切り記号を隠す'));

			const note       = document.createElement('p');
			note.className   = 'tms-mde-settings-description';
			note.textContent = '最初のキャプチャグループ (...) が装飾対象です。キャプチャグループがない場合は一致全体を装飾します。';
			card.append(legend, header, fields, hideLabel, note);
			this.decorationsList?.appendChild(card);
		});
	}

	/**
	 * 装飾ルールの 1 項目を編集するテキスト入力を作る
	 * 変更は検証してから保存する
	 * @param index - ルール配列の位置。0 始まり
	 * @param field - 編集する項目。名前、正規表現、CSS クラスのいずれか
	 * @param labelText - 入力のラベル
	 * @param value - 開いたときの文字列
	 * @param placeholder - 空のときに示す例
	 * @returns ラベルと入力を含む要素
	 */
	private createDecorationTextField(index: number, field: 'name' | 'pattern' | 'cssClass', labelText: string, value: string, placeholder: string): HTMLLabelElement {
		const label                   = document.createElement('label');
		label.className               = 'tms-mde-settings-decoration-field';
		const caption                 = document.createElement('span');
		caption.textContent           = labelText;
		const input                   = document.createElement('input');
		input.type                    = 'text';
		input.value                   = value;
		input.placeholder             = placeholder;
		input.dataset.decorationIndex = String(index);
		input.dataset.decorationField = field;
		input.setAttribute('aria-label', `${index + 1}件目の${labelText}`);
		if (field === 'pattern' || field === 'cssClass') {
			input.className = 'tms-mde-settings-decoration-code';
		}
		// 入力を確定したときだけ、この欄の値をルールへ保存する
		input.addEventListener(
			'change',
			() =>
				void this.changeCustomDecoration(
					index,
					{
						[field]: input.value
					},
					input
				)
		);
		label.append(caption, input);
		return label;
	}

	/**
	 * 既存と重ならない新しい無効ルールを足し、保存する
	 */
	private async addCustomDecoration(): Promise<void> {
		const next  = [...this.customDecorations, createNewCustomDecorationRule(this.customDecorations)];
		const saved = await this.saveCustomDecorations(next, true);
		if (saved) {
			// 保存成功後、新規ルールの名前をすぐ入力できる位置へフォーカスを移す
			const inputs = this.decorationsList?.querySelectorAll<HTMLInputElement>('[data-decoration-field="name"]');
			const input  = inputs?.item(inputs.length - 1);
			input?.focus();
			input?.select();
		}
	}

	/**
	 * 指定位置のルールを除いて保存する
	 * @param index - 除くルールの位置。0 始まり
	 */
	private async removeCustomDecoration(index: number): Promise<void> {
		const rule = this.customDecorations[index];
		if (!rule || !window.confirm(`カスタム装飾ルール「${rule.name || `ルール ${index + 1}`}」を削除しますか？`)) {
			return;
		}

		const next = this.customDecorations.filter((_, currentIndex) => currentIndex !== index);
		await this.saveCustomDecorations(next, true);
	}

	/**
	 * 1 件のルールへ変更を重ね、検証して保存する
	 * 検証に失敗したときは入力へエラーを出し、保存しない
	 * @param index - 変更するルールの位置。0 始まり
	 * @param patch - 上書きする項目だけを持つ部分
	 * @param control - 失敗したときにエラーを出す入力
	 */
	private async changeCustomDecoration(index: number, patch: Partial<CustomDecorationRule>, control: HTMLInputElement): Promise<void> {
		const next = this.customDecorations.map((rule, currentIndex) => (currentIndex === index ? { ...rule, ...patch } : rule));
		await this.saveCustomDecorations(next, false, control);
	}

	/**
	 * 装飾ルールを検証し、通れば C# へ保存して画面へ返す
	 * 検証エラーがあるときは保存せず false
	 * @param next - 保存したいルール。無効なものも含む
	 * @param rerender - 成功後に一覧を描き直すか
	 * @param focusControl - 再描画後にフォーカスを戻す入力。不要なら省略
	 * @returns 保存できたとき true
	 */
	private async saveCustomDecorations(next: CustomDecorationRule[], rerender: boolean, focusControl?: HTMLInputElement): Promise<boolean> {
		// 入力値を先に画面へ反映し、検証・保存に失敗した場合だけpreviousへ戻す
		const previous         = this.customDecorations;
		this.customDecorations = next;
		if (rerender) {
			this.renderCustomDecorationList();
		}

		const errors = validateCustomDecorationRules(next);
		this.markCustomDecorationErrors(errors);
		if (errors.length > 0) {
			// 不正な正規表現やCSSクラスはネイティブ側へ送らず、最初の修正箇所を案内する
			this.setStatus(`ルール ${errors[0]!.index + 1}: ${errors[0]!.message}`, true);
			return false;
		}

		this.setDecorationControlsDisabled(true);
		this.setStatus('カスタム装飾ルールを保存中...');
		try {
			const normalized = normalizeCustomDecorationRules(next);
			const result     = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configUpdate, {
				customDecorations: normalized
			});
			if (!result.success || !result.config) {
				throw new Error(result.message ?? 'カスタム装飾ルールを保存できませんでした。');
			}
			this.customDecorations = result.config.customDecorations.map((rule) => ({ ...rule }));
			this.options.onCustomDecorationsApplied(result.config.customDecorations);
			this.setStatus('カスタム装飾ルールを保存しました。');
			return true;
		} catch (error) {
			// 保存済み状態と表示状態が食い違わないよう、楽観更新した配列を復元する
			this.customDecorations = previous;
			if (rerender) {
				this.renderCustomDecorationList();
			}
			this.setStatus(this.formatError(error), true);
			return false;
		} finally {
			this.setDecorationControlsDisabled(false);
			if (focusControl && document.contains(focusControl)) {
				focusControl.focus();
			}
		}
	}

	/**
	 * 検証エラーを、対応する入力のタイトルと状態行へ出す
	 * @param errors - ルール位置と項目を持つ検証エラー
	 */
	private markCustomDecorationErrors(errors: ReturnType<typeof validateCustomDecorationRules>): void {
		// 前回の検証結果を消してから、現在のエラーだけをaria属性とツールチップへ反映する
		this.decorationsList?.querySelectorAll<HTMLInputElement>('[data-decoration-field]').forEach((input) => {
			input.removeAttribute('aria-invalid');
			input.removeAttribute('title');
		});
		errors.forEach((error) => {
			const input = this.decorationsList?.querySelector<HTMLInputElement>(`[data-decoration-index="${error.index}"][data-decoration-field="${error.field}"]`);
			input?.setAttribute('aria-invalid', 'true');
			input?.setAttribute('title', error.message);
		});
	}

	/**
	 * 保存中は装飾の入力と追加ボタンを触れなくする
	 * @param disabled - true で入力を止める
	 */
	private setDecorationControlsDisabled(disabled: boolean): void {
		if (this.decorationAddButton) {
			this.decorationAddButton.disabled = disabled;
		}
		this.decorationsList?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
			control.disabled = disabled;
		});
	}

	// ----------------------------------------------
	// キーボードとメニュー
	// ----------------------------------------------

	/**
	 * 変更できるショートカットと、固定のショートカットを節へ並べる
	 * @param section - 入力を足す節
	 */
	private renderKeyboard(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = '入力欄を選択して、割り当てたいキーを押してください。競合やWindows予約キーは保存前に警告します。';
		section.appendChild(description);

		KEYBINDING_DEFINITIONS.forEach((definition) => {
			const key       = `keybindings.${definition.key}`;
			const input     = document.createElement('input');
			input.type      = 'text';
			input.readOnly  = true;
			input.className = 'tms-mde-shortcut-input';
			input.value     = this.settings.keybindings[definition.key];
			input.setAttribute('aria-label', `${definition.label}のキーバインド`);
			// フォーカスで全文を選択し、次のキーを割り当てとして受ける
			input.addEventListener('focus', () => {
				input.select();
				this.setStatus('キーを入力してください。Escapeで設定画面を閉じます。');
			});
			// 押されたキーをショートカットとして解釈する。文字入力にはしない
			input.addEventListener('keydown', (event) => {
				// ショートカット入力をエディタやブラウザ既定操作へ伝播させず、設定値としてだけ解釈する
				event.preventDefault();
				event.stopPropagation();
				// Escape は割り当てにせず、設定画面を閉じる
				if (event.key === 'Escape') {
					this.close();
					return;
				}
				// 保存できるキー名。修飾だけや保存できないキーは null
				const shortcut = shortcutFromKeyboardEvent(event);
				// 保存名があるときだけ割り当てを書く。null は無視する
				if (shortcut) {
					void this.saveKeybinding(definition, shortcut, input);
				}
			});
			this.addControlRow(section, key, definition.label, input);
		});
	}

	/**
	 * エディタとタブの右クリックメニューの編集を節へ足す
	 * @param section - 入力を足す節
	 */
	private renderContextMenus(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = '右クリックメニューの項目を表示・非表示にし、上へ／下へボタンで並べ替えられます。区切り線も移動できます。';
		section.appendChild(description);

		this.createContextMenuEditor(section, 'editor', 'エディタ内');
		this.createContextMenuEditor(section, 'tab', 'タブ');

		const reset       = document.createElement('button');
		reset.type        = 'button';
		reset.textContent = '右クリックメニューを既定値へ戻す';
		// クリックでエディタとタブの並びと非表示を既定へ戻す
		reset.addEventListener('click', () => void this.resetContextMenus(reset));
		section.appendChild(reset);
	}

	/**
	 * 1 種類のメニューについて、表示と順序を編集する一覧を作る
	 * @param section - 一覧を足す節
	 * @param kind - エディタかタブか
	 * @param headingText - 一覧の上に出す見出し
	 */
	private createContextMenuEditor(section: HTMLElement, kind: ContextMenuKind, headingText: string): void {
		const heading       = document.createElement('h4');
		heading.textContent = headingText;
		const list          = document.createElement('div');
		list.className      = 'tms-mde-settings-context-menu-list';
		list.setAttribute('aria-label', `${headingText}の右クリックメニュー項目`);
		this.contextMenuLists.set(kind, list);
		section.append(heading, list);
		this.renderContextMenuList(kind);
	}

	/**
	 * 指定した種類のメニュー項目を、いまの順序で描き直す
	 * @param kind - 描き直すメニューの種類
	 */
	private renderContextMenuList(kind: ContextMenuKind): void {
		const list = this.contextMenuLists.get(kind);
		if (!list) {
			return;
		}

		// 順序配列を表示の基準にし、非表示配列はチェック状態へ投影する
		list.innerHTML    = '';
		const order       = kind === 'editor' ? this.settings.contextMenu.editorOrder : this.settings.contextMenu.tabOrder;
		const hiddenItems = new Set(kind === 'editor' ? this.settings.contextMenu.editorHidden : this.settings.contextMenu.tabHidden);
		order.forEach((itemId, index) => {
			const row       = document.createElement('div');
			row.className   = 'tms-mde-settings-context-menu-item';
			const visible   = document.createElement('input');
			visible.type    = 'checkbox';
			visible.checked = !hiddenItems.has(itemId);
			visible.setAttribute('aria-label', `${CONTEXT_MENU_ITEM_LABELS[itemId] ?? itemId}を表示`);
			// チェックの変更で、その項目の表示と非表示を保存する
			visible.addEventListener('change', () => void this.setContextMenuItemVisible(kind, itemId, visible.checked, visible));
			const label       = document.createElement('span');
			label.className   = 'tms-mde-settings-context-menu-label';
			label.textContent = CONTEXT_MENU_ITEM_LABELS[itemId] ?? itemId;
			if (isContextMenuSeparator(itemId)) {
				row.classList.add('is-separator');
			}

			const actions     = document.createElement('div');
			actions.className = 'tms-mde-settings-context-menu-actions';
			const up          = document.createElement('button');
			up.type           = 'button';
			up.textContent    = '上へ';
			up.disabled       = index === 0;
			up.setAttribute('aria-label', `${label.textContent}を上へ移動`);
			// クリックでこの項目を一つ上へ動かす。先頭ではボタン自体が無効
			up.addEventListener('click', () => void this.moveContextMenuItem(kind, itemId, -1, up));
			const down       = document.createElement('button');
			down.type        = 'button';
			down.textContent = '下へ';
			down.disabled    = index === order.length - 1;
			down.setAttribute('aria-label', `${label.textContent}を下へ移動`);
			// クリックでこの項目を一つ下へ動かす。末尾ではボタン自体が無効
			down.addEventListener('click', () => void this.moveContextMenuItem(kind, itemId, 1, down));
			actions.append(up, down);
			row.append(visible, label, actions);
			list.appendChild(row);
		});
	}

	/**
	 * メニュー項目の表示を切り替え、保存する
	 * 保存に失敗したときはチェックを元へ戻す
	 * @param kind - エディタかタブか
	 * @param itemId - 切り替える項目 ID
	 * @param visible - 表示するなら true
	 * @param control - 失敗したときに戻すチェックボックス
	 */
	private async setContextMenuItemVisible(kind: ContextMenuKind, itemId: string, visible: boolean, control: HTMLInputElement): Promise<void> {
		const next      = this.cloneContextMenuSettings();
		const hiddenKey = kind === 'editor' ? 'editorHidden' : 'tabHidden';
		const hidden    = new Set(next[hiddenKey]);
		if (visible) hidden.delete(itemId);
		else hidden.add(itemId);
		next[hiddenKey] = [...hidden];
		await this.saveContextMenuSettings(next, control);
	}

	/**
	 * メニュー項目を 1 つ上下へ動かし、保存する
	 * 端より外へは動かない。失敗したときは一覧を描き直す
	 * @param kind - エディタかタブか
	 * @param itemId - 動かす項目 ID
	 * @param direction - -1 は上、1 は下
	 * @param control - 保存中に無効にするボタン
	 */
	private async moveContextMenuItem(kind: ContextMenuKind, itemId: string, direction: -1 | 1, control: HTMLButtonElement): Promise<void> {
		const next     = this.cloneContextMenuSettings();
		const orderKey = kind === 'editor' ? 'editorOrder' : 'tabOrder';
		next[orderKey] = moveContextMenuItem(next[orderKey], itemId, direction);
		await this.saveContextMenuSettings(next, control);
	}

	/**
	 * 右クリックメニューを既定の並びへ戻し、保存する
	 * @param control - 保存中に無効にするボタン
	 */
	private async resetContextMenus(control: HTMLButtonElement): Promise<void> {
		await this.saveContextMenuSettings(createDefaultContextMenuSettings(), control, '右クリックメニューを既定値へ戻しました。');
	}

	/**
	 * 右クリックメニューの並びと非表示を C# へ保存する
	 * 失敗したときは状態行へ理由を出し、呼び出し側が一覧を戻す
	 * @param next - 保存するメニュー設定
	 * @param control - 保存中に無効にする入力かボタン
	 * @param successMessage - 成功時に状態行へ出す文言。省略時はメニューを保存した旨
	 */
	private async saveContextMenuSettings(next: ContextMenuSettings, control: HTMLInputElement | HTMLButtonElement, successMessage = '右クリックメニュー設定を保存しました。'): Promise<void> {
		// 連打による保存競合を防ぎ、応答後は正規化済み設定から両メニューを再描画する
		control.disabled = true;
		this.setStatus('右クリックメニュー設定を保存中...');
		try {
			this.settings             = await this.updateSettings({ contextMenu: next });
			this.settings.contextMenu = normalizeContextMenuSettings(this.settings.contextMenu);
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.setStatus(successMessage);
		} catch (error) {
			// 失敗時もローカル設定を正として描画し直し、操作前のチェック・順序へ戻す
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.setStatus(this.formatError(error), true);
		} finally {
			control.disabled = false;
		}
	}

	/**
	 * 編集で元の配列を壊さないよう、メニュー設定を複製する
	 * @returns 並びと非表示をコピーした設定
	 */
	private cloneContextMenuSettings(): ContextMenuSettings {
		const source = normalizeContextMenuSettings(this.settings.contextMenu);
		return {
			editorOrder: [...source.editorOrder],
			editorHidden: [...source.editorHidden],
			tabOrder: [...source.tabOrder],
			tabHidden: [...source.tabHidden]
		};
	}

	// ----------------------------------------------
	// データと更新
	// ----------------------------------------------

	/**
	 * データディレクトリと、更新確認の入力を節へ足す
	 * ポータブル起動ではディレクトリの移動を出さない
	 * @param section - 入力を足す節
	 */
	private renderDataAndUpdate(section: HTMLElement): void {
		if (this.isPortable) {
			const note       = document.createElement('p');
			note.className   = 'tms-mde-settings-description';
			note.textContent = 'ポータブル版では、設定・ログは TmsMdEditor.exe と同じ階層の data フォルダへ保存します。保存先は変更できません。';
			section.appendChild(note);
			this.addCheckbox(section, 'update.checkOnStartup', '起動時に更新を確認する');
			return;
		}

		const dataDirRow            = document.createElement('div');
		dataDirRow.className        = 'tms-mde-settings-row';
		const label                 = document.createElement('span');
		label.className             = 'tms-mde-settings-label';
		label.textContent           = 'データ保存先 (dataDir)';
		this.dataDirInput           = document.createElement('input');
		this.dataDirInput.type      = 'text';
		this.dataDirInput.readOnly  = true;
		this.dataDirInput.value     = this.dataDirInfo.dataDir;
		this.dataDirInput.className = 'tms-mde-settings-path';
		this.dataDirInput.setAttribute('aria-label', '現在のデータ保存先');
		const actions      = document.createElement('div');
		actions.className  = 'tms-mde-settings-row-actions';
		const browse       = document.createElement('button');
		browse.type        = 'button';
		browse.textContent = '参照';
		// クリックでデータフォルダの選択を開く
		browse.addEventListener('click', () => void this.changeDataDir());
		const reset       = document.createElement('button');
		reset.type        = 'button';
		reset.textContent = '既定値へ戻す';
		reset.disabled    = this.dataDirInfo.dataDir.toLowerCase() === this.dataDirInfo.defaultDataDir.toLowerCase();
		// クリックでデータフォルダを既定の場所へ戻す。既定と同じときはボタンが無効
		reset.addEventListener('click', () => void this.resetDataDir());
		this.dataDirResetButton = reset;
		actions.append(browse, reset);
		dataDirRow.append(label, this.dataDirInput, actions);
		section.appendChild(dataDirRow);

		const note       = document.createElement('p');
		note.className   = 'tms-mde-settings-description';
		note.textContent = '変更時は config・snippets・backups を新しい保存先へコピーします。移行元は削除しません。';
		section.appendChild(note);
		this.addCheckbox(section, 'update.checkOnStartup', '起動時に更新を確認する');
	}

	// ----------------------------------------------
	// 入力欄
	// ----------------------------------------------

	/**
	 * 文字列の入力行を足し、変更でそのキーを保存する
	 * @param section - 行を足す節
	 * @param key - ドット区切りの設定キー
	 * @param label - 入力のラベル
	 * @returns 足した行
	 */
	private addText(section: HTMLElement, key: string, label: string): HTMLDivElement {
		const input = document.createElement('input');
		input.type  = 'text';
		input.value = String(this.getValue(key));
		// 入力を確定したときだけ、文字列のまま保存する
		input.addEventListener('change', () => void this.saveValue(key, input.value, input));
		return this.addControlRow(section, key, label, input);
	}

	/**
	 * 数値の入力行を足し、範囲外の入力は保存しない
	 * @param section - 行を足す節
	 * @param key - ドット区切りの設定キー
	 * @param label - 入力のラベル
	 * @param min - 受け付ける最小値
	 * @param max - 受け付ける最大値
	 * @returns 足した行
	 */
	private addNumber(section: HTMLElement, key: string, label: string, min: number, max: number): HTMLDivElement {
		const input = document.createElement('input');
		input.type  = 'number';
		input.min   = String(min);
		input.max   = String(max);
		input.value = String(this.getValue(key));
		// 入力を確定したときだけ、数値にして保存する
		input.addEventListener('change', () => void this.saveValue(key, Number(input.value), input));
		return this.addControlRow(section, key, label, input);
	}

	/**
	 * 色の入力行を足す
	 * 空を許す指定で空にしたときは空文字を保存する
	 * @param section - 行を足す節
	 * @param key - ドット区切りの設定キー
	 * @param label - 入力のラベル
	 * @param options - 空を許すかと、空のとき示す文言、カラーピッカーの代替色。省略時は空を許さない
	 * @returns 足した行
	 */
	private addColor(section: HTMLElement, key: string, label: string, options?: { allowEmpty?: boolean; emptyPlaceholder?: string; pickerFallback?: string }): HTMLDivElement {
		const allowEmpty     = options?.allowEmpty === true;
		const pickerFallback = options?.pickerFallback ?? '#888888';
		const current        = String(this.getValue(key) ?? '');
		const wrap           = document.createElement('div');
		wrap.className       = 'tms-mde-settings-color';
		const picker         = document.createElement('input');
		picker.type          = 'color';
		picker.value         = toColorInputValue(current, pickerFallback);
		picker.setAttribute('aria-label', `${label}の色見本`);
		const input       = document.createElement('input');
		input.type        = 'text';
		input.value       = current;
		input.spellcheck  = false;
		input.placeholder = options?.emptyPlaceholder ?? '';
		input.setAttribute('aria-label', label);
		// 見本を動かしているあいだ、テキスト欄だけを同じ色へ追従させる。まだ保存しない
		picker.addEventListener('input', () => {
			input.value = picker.value;
		});
		// 見本を確定したとき、その色を保存する
		picker.addEventListener('change', () => void this.saveValue(key, picker.value, input));
		// テキスト欄を確定したとき、空欄の許可と色の形式を見て保存する
		input.addEventListener('change', () => {
			const trimmed = input.value.trim();
			// hover色だけは空値をテーマ色指定として扱い、その他はCSS色形式を必須にする
			if (allowEmpty && trimmed.length === 0) {
				void this.saveValue(key, '', input);
				return;
			}

			// 空でないが、許可する16進色ではない。保存せず入力を戻す
			if (!isCssHexColor(trimmed)) {
				this.setStatus('色は #RGB / #RRGGBB / #RRGGBBAA で指定してください。', true);
				this.syncControls();
				return;
			}

			void this.saveValue(key, trimmed, input);
		});
		wrap.append(picker, input);
		return this.addControlRow(section, key, label, input, wrap);
	}

	/**
	 * チェックボックスの行を足し、切り替えでそのキーを保存する
	 * @param section - 行を足す節
	 * @param key - ドット区切りの設定キー
	 * @param label - チェックの文言
	 * @returns 足した行
	 */
	private addCheckbox(section: HTMLElement, key: string, label: string): HTMLDivElement {
		const input   = document.createElement('input');
		input.type    = 'checkbox';
		input.checked = Boolean(this.getValue(key));
		// チェックの変更で、その真偽値を保存する
		input.addEventListener('change', () => void this.saveValue(key, input.checked, input));
		return this.addControlRow(section, key, label, input);
	}

	/**
	 * 選択リストの行を足し、変更でそのキーを保存する
	 * @param section - 行を足す節
	 * @param key - ドット区切りの設定キー
	 * @param label - 選択のラベル
	 * @param options - 値と表示名の組。並びがリストの順
	 * @returns 足した行
	 */
	private addSelect(section: HTMLElement, key: string, label: string, options: Array<[string, string]>): HTMLDivElement {
		const select = document.createElement('select');
		options.forEach(([value, text]) => {
			const option       = document.createElement('option');
			option.value       = value;
			option.textContent = text;
			select.appendChild(option);
		});
		select.value = String(this.getValue(key));
		// 選択を変えたとき、その値を保存する
		select.addEventListener('change', () => void this.saveValue(key, select.value, select));
		return this.addControlRow(section, key, label, select);
	}

	/**
	 * ラベル、入力、既定へ戻すボタンを 1 行にし、バインド一覧へ登録する
	 * @param section - 行を足す節
	 * @param key - ドット区切りの設定キー
	 * @param labelText - 行のラベル
	 * @param control - 値を出す入力
	 * @param wrapper - 入力の代わりに行へ置く要素。色入力のように複数あるときだけ渡す
	 * @returns 足した行
	 */
	private addControlRow(section: HTMLElement, key: string, labelText: string, control: SettingControl, wrapper?: HTMLElement): HTMLDivElement {
		const row         = document.createElement('div');
		row.className     = 'tms-mde-settings-row';
		const label       = document.createElement('span');
		label.className   = 'tms-mde-settings-label';
		label.textContent = labelText;
		const reset       = document.createElement('button');
		reset.type        = 'button';
		reset.className   = 'tms-mde-settings-reset';
		reset.textContent = 'リセット';
		reset.setAttribute('aria-label', `${labelText}をリセット`);
		// クリックでこの項目だけを既定へ戻す。ボタンの送信は止める
		reset.addEventListener('click', (event) => {
			event.preventDefault();
			void this.resetItem(key);
		});
		control.setAttribute('aria-label', labelText);

		row.append(label, wrapper ?? control, reset);
		section.appendChild(row);
		this.bindings.push({ key, control });
		return row;
	}

	/**
	 * 1 つの設定値を保存し、成功したら入力を保存後の値へ合わせる
	 * 失敗したときは状態行へ理由を出し、入力は保存前の値へ戻す
	 * @param key - ドット区切りの設定キー
	 * @param value - 保存する値
	 * @param control - 成功と失敗のどちらでも表示を合わせる入力
	 */
	private async saveValue(key: string, value: unknown, control: SettingControl): Promise<void> {
		// 同じ入力から保存を重ねないよう一時無効化し、応答の設定値で関連コントロールも同期する
		control.disabled = true;
		this.setStatus('保存中...');
		try {
			// 保存後に正規化された設定。失敗したときはここに来ない
			const next    = await this.updateSettings(createNestedPatch(key, value));
			this.settings = next;
			this.syncControls();
			this.updateExternalBrowserCommandVisibility();
			this.setStatus('設定を保存しました。');
		} catch (error) {
			this.syncControls();
			this.setStatus(this.formatError(error), true);
		} finally {
			control.disabled = false;
			// 保存中にダイアログが閉じられた入力は、文書に残っていないのでフォーカスしない
			if (document.contains(control)) {
				control.focus();
			}
		}
	}

	/**
	 * ショートカットを正規化して保存する
	 * 空、競合、Windows が届かない既知の組み合わせは保存しない
	 * @param definition - 保存する操作
	 * @param shortcut - 入力されたショートカット。空なら保存しない
	 * @param input - 失敗したときに元の値へ戻す入力
	 */
	private async saveKeybinding(definition: KeybindingDefinition, shortcut: string, input: HTMLInputElement): Promise<void> {
		// 競合は利用者が意図して重複させる場合もあるため、禁止ではなく確認警告として扱う
		// 他の割り当てと重なるキー。空なら競合は無い
		const conflicts          = findShortcutConflicts(this.settings.keybindings as unknown as Record<string, string>, definition.key, shortcut);
		// 変更できない操作と重なるキー。空なら固定側の競合は無い
		const fixedConflicts     = findShortcutConflicts(FIXED_SHORTCUTS, '', shortcut);
		// 確認ダイアログに出す警告。無ければ確認せず保存する
		const warnings: string[] = [];
		// 変更できる操作と重なっているときだけ、相手の表示名を警告に足す
		if (conflicts.length > 0) {
			// 定義が無いキーは、表示名の代わりにキー文字列を出す
			const labels = conflicts.map((key) => KEYBINDING_DEFINITIONS.find((item) => item.key === key)?.label ?? key);
			warnings.push(`「${labels.join('、')}」と競合します。`);
		}
		// 固定操作と重なっている
		if (fixedConflicts.length > 0) {
			warnings.push(`固定操作「${fixedConflicts.join('、')}」と競合します。`);
		}
		// Windows がアプリへ渡さない既知の組み合わせ
		if (isKnownWindowsReservedShortcut(shortcut)) {
			warnings.push('Ctrl+Shift+0 はWindowsで予約され、アプリへ届かない環境があります。');
		}
		// 警告があり、かつ利用者が保存を拒んだ。片方だけではキャンセルしない
		if (warnings.length > 0 && !window.confirm(`${warnings.join('\n')}\n\nこの割り当てを保存しますか？`)) {
			this.setStatus('キーバインドの変更をキャンセルしました。');
			return;
		}

		await this.saveValue(`keybindings.${definition.key}`, shortcut, input);
	}

	/**
	 * 設定の部分更新を C# へ送り、成功したら保持値と画面へ反映する
	 * @param patch - 変更するキーだけを持つオブジェクト。ドット区切りはネストへ展開する
	 * @returns 保存後の画面設定
	 * @throws {Error} 保存に失敗したとき、C# のメッセージで reject する
	 */
	private async updateSettings(patch: Record<string, unknown>): Promise<AppSettings> {
		// C# が正規化した保存結果。失敗時は config が無い
		const result = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configUpdate, { settings: patch });
		// 失敗、または設定本体が無い。どちらかなら画面へ反映しない
		if (!result.success || !result.config) {
			throw new Error(result.message ?? '設定を保存できませんでした。');
		}
		// ネイティブ側で既定値補完・正規化された設定を、モーダル外の実行状態にも反映する
		this.options.onSettingsApplied(result.config.settings);
		return result.config.settings;
	}

	/**
	 * 1 つの設定キーを既定値へ戻し、入力と画面へ反映する
	 * @param key - 戻す設定キー。ドット区切りもそのまま渡す
	 */
	private async resetItem(key: string): Promise<void> {
		this.setStatus('リセット中...');
		try {
			// 1 項目を既定へ戻したあとの設定。失敗時は config が無い
			const result = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configResetItem, { itemKey: key });
			// 失敗、または設定本体が無い。どちらかなら画面は変えない
			if (!result.success || !result.config) {
				throw new Error(result.message ?? '設定をリセットできませんでした。');
			}
			this.settings = result.config.settings;
			this.options.onSettingsApplied(this.settings);
			this.syncControls();
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.updateExternalBrowserCommandVisibility();
			// 有効一覧だけ戻しても、適用済みの CSS は残るので読み直す
			if (key === 'cssSnippets.enabled') {
				// 有効一覧のリセットはCSS本体の再適用まで行わないと画面に古いスタイルが残る
				await this.reloadSnippets();
			}
			this.setStatus('設定を既定値へ戻しました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * すべての設定を既定へ戻し、ダイアログを描き直す
	 */
	private async resetAll(): Promise<void> {
		// 全項目を戻す前の確認。拒まれたら何も送らない
		if (!window.confirm('dataDirを除くすべての設定を既定値へ戻します。よろしいですか？')) {
			return;
		}
		this.setStatus('すべての設定をリセット中...');
		try {
			// 全項目を既定へ戻したあとの設定。失敗時は config が無い
			const result = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configResetAll);
			// 失敗、または設定本体が無い。どちらかなら画面は変えない
			if (!result.success || !result.config) {
				throw new Error(result.message ?? '設定をリセットできませんでした。');
			}
			this.settings = result.config.settings;
			this.options.onSettingsApplied(this.settings);
			this.syncControls();
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.updateExternalBrowserCommandVisibility();
			await this.reloadSnippets();
			this.setStatus('すべての設定を既定値へ戻しました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * CSS スニペットを読み直し、一覧と状態行を更新する
	 */
	private async reloadSnippets(): Promise<void> {
		this.setStatus('CSSスニペットを再読み込み中...');
		try {
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>(BRIDGE_METHOD.cssSnippetsList);
			this.options.onCssSnippetsApplied(this.cssSnippets);
			this.updateSnippetDirectoryInfo();
			this.renderSnippetList();
			// 読み込み結果の文言と、失敗として出すか。一覧が空でもエラーとは限らない
			const status = getCssSnippetsReloadStatus(this.cssSnippets);
			this.setStatus(status.message, status.isError);
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * スニペットの有効チェックを、最新の一覧から描き直す
	 */
	private renderSnippetList(): void {
		// 一覧の置き場所がまだ無い。描く前にセクションが閉じられたとき
		if (!this.snippetsList) {
			return;
		}
		this.snippetsList.innerHTML = '';
		// フォルダに CSS が無い。チェックは出さず説明だけ出す
		if (this.cssSnippets.snippets.length === 0) {
			// 空であることを示す段落
			const empty       = document.createElement('p');
			empty.className   = 'tms-mde-settings-description';
			empty.textContent = '.css ファイルがありません。';
			this.snippetsList.appendChild(empty);
			return;
		}

		this.cssSnippets.snippets.forEach((snippet) => {
			// 1 ファイル分の行。チェックと名前を並べる
			const label       = document.createElement('label');
			label.className   = 'tms-mde-settings-snippet';
			// そのファイルを有効にするチェック。読み込みエラーのあいだは操作できない
			const checkbox    = document.createElement('input');
			checkbox.type     = 'checkbox';
			checkbox.checked  = snippet.enabled;
			checkbox.disabled = Boolean(snippet.error);
			// チェックの変更で、そのスニペットの有効だけを保存する。読み込みエラーの項目は無効のまま
			checkbox.addEventListener('change', () => void this.toggleSnippet(snippet.name, checkbox.checked, checkbox));
			// ファイル名。パスは出さない
			const name       = document.createElement('span');
			name.textContent = snippet.name;
			label.append(checkbox, name);
			// そのファイルを読めなかった。理由を行の末尾に出す
			if (snippet.error) {
				// 読み込み失敗の理由
				const error       = document.createElement('span');
				error.className   = 'tms-mde-settings-inline-error';
				error.textContent = snippet.error;
				label.appendChild(error);
			}
			this.snippetsList?.appendChild(label);
		});
	}

	/**
	 * スニペットフォルダのパスと、フォルダ自体のエラー表示を更新する
	 */
	private updateSnippetDirectoryInfo(): void {
		// パス表示が描かれているときだけ文言を替える。セクション未描画なら何もしない
		if (this.snippetDirectoryPath) {
			this.snippetDirectoryPath.textContent = `現在参照しているフォルダ: ${this.cssSnippets.directoryPath}`;
		}

		// フォルダ自体のエラー欄があるときだけ、文言と表示を合わせる
		if (this.snippetError) {
			this.snippetError.textContent = this.cssSnippets.error ?? '';
			this.snippetError.hidden      = !this.cssSnippets.error;
		}
	}

	/**
	 * スニペットの有効状態を保存し、画面のスタイルへ反映する
	 * 失敗したときはチェックを元へ戻す
	 * @param name - 切り替えるファイル名
	 * @param enabled - 有効にするなら true
	 * @param checkbox - 失敗したときに戻すチェックボックス
	 */
	private async toggleSnippet(name: string, enabled: boolean, checkbox: HTMLInputElement): Promise<void> {
		// Setで重複を避けながら対象名だけを増減し、保存後の一覧は実ファイル状態から再取得する
		// 保存する有効ファイル名。同じ名前は 1 つにまとめる
		const current = new Set(this.settings.cssSnippets.enabled);
		// オンにしたファイルを一覧へ足す
		if (enabled) {
			current.add(name);
		} else {
			current.delete(name);
		}

		checkbox.disabled = true;
		try {
			this.settings = await this.updateSettings({
				cssSnippets: { enabled: [...current] }
			});
			await this.reloadSnippets();
		} catch (error) {
			// 保存失敗時はチェックだけ先に反転していたため、直前の状態へ戻す
			checkbox.checked = !enabled;
			this.setStatus(this.formatError(error), true);
		} finally {
			checkbox.disabled = false;
		}
	}

	/**
	 * スニペットフォルダを OS のエクスプローラーで開く
	 */
	private async openSnippetsFolder(): Promise<void> {
		try {
			await invokeBridge(BRIDGE_METHOD.cssSnippetsOpenFolder);
			this.setStatus('CSSスニペットフォルダを開きました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * 新しいデータディレクトリを選び、設定の場所を移す
	 * キャンセルと失敗では、いまの場所のままにする
	 */
	private async changeDataDir(): Promise<void> {
		// ポータブル版は保存先を動かせない
		if (this.isPortable) {
			this.setStatus('ポータブル版ではデータ保存先を変更できません。', true);
			return;
		}
		// 設定だけでなく複数ディレクトリをコピーするため、長時間処理の開始前に明示確認する
		if (!window.confirm('データ保存先を変更し、config・snippets・backupsを移行します。移行元は削除されません。続行しますか？')) {
			return;
		}
		this.setStatus('データを移行中です。アプリを終了しないでください...');
		try {
			// フォルダ選択と移行の結果。キャンセルも失敗として返る
			const result = await invokeBridge<MigrateDataDirResponse>(BRIDGE_METHOD.configChangeDataDir);
			// 移行できていない。キャンセルと失敗で出し分ける
			if (!result.success) {
				// 利用者がフォルダ選択を閉じた。保存先は変えない
				if (result.message === 'キャンセルされました。') {
					this.setStatus('dataDirの変更をキャンセルしました。');
					return;
				}
				throw new Error(result.message ?? 'dataDirを変更できませんでした。');
			}
			await this.refreshAfterDataDirChange();
			this.setStatus('dataDirを変更しました。移行元のデータは保持されています。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * データディレクトリを既定の場所へ戻す
	 */
	private async resetDataDir(): Promise<void> {
		// ポータブル版は既定の場所へも戻せない
		if (this.isPortable) {
			this.setStatus('ポータブル版ではデータ保存先を変更できません。', true);
			return;
		}
		// 移行の確認。拒まれたら送らない
		if (!window.confirm('dataDirを既定の保存先へ戻し、データを移行します。移行元は削除されません。続行しますか？')) {
			return;
		}
		this.setStatus('既定のdataDirへ移行中です...');
		try {
			// 既定の保存先へ戻した応答。設定本体が無くても成功なら再読込へ進む
			const result = await invokeBridge<SaveConfigResponse>(BRIDGE_METHOD.configResetItem, { itemKey: 'dataDir' });
			// 戻せなかった。画面の保存先は変えない
			if (!result.success) {
				throw new Error(result.message ?? 'dataDirを既定値へ戻せませんでした。');
			}
			await this.refreshAfterDataDirChange();
			this.setStatus('dataDirを既定の保存先へ戻しました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	/**
	 * データディレクトリを移したあと、設定とスニペットを読み直して描き直す
	 */
	private async refreshAfterDataDirChange(): Promise<void> {
		// 保存ルートが変わると設定とスニペットの参照先も変わるため、関連キャッシュを一括で再取得する
		// 移したあとの設定、装飾、保存先情報
		const config           = await invokeBridge<ConfigGetResponse>(BRIDGE_METHOD.configGet);
		this.settings          = config.config.settings;
		this.customDecorations = config.config.customDecorations.map((rule) => ({ ...rule }));
		this.dataDirInfo       = config.dataDirInfo;
		this.cssSnippets       = await invokeBridge<CssSnippetsResponse>(BRIDGE_METHOD.cssSnippetsList);
		this.options.onSettingsApplied(this.settings);
		this.options.onCustomDecorationsApplied(this.customDecorations);
		this.options.onCssSnippetsApplied(this.cssSnippets);
		this.syncControls();
		// 保存先の入力が描かれているときだけ、移したあとのパスを入れる
		if (this.dataDirInput) {
			this.dataDirInput.value = this.dataDirInfo.dataDir;
		}
		// 既定へ戻すボタンがあるときだけ、既定と同じなら押せなくする
		if (this.dataDirResetButton) {
			this.dataDirResetButton.disabled = this.dataDirInfo.dataDir.toLowerCase() === this.dataDirInfo.defaultDataDir.toLowerCase();
		}
		this.renderSnippetList();
		this.renderCustomDecorationList();
		this.renderContextMenuList('editor');
		this.renderContextMenuList('tab');
		this.updateSnippetDirectoryInfo();
		this.updateExternalBrowserCommandVisibility();
	}

	/**
	 * 保持している設定値を、いま画面にある入力へ書き戻す
	 */
	private syncControls(): void {
		// 保存・リセット後の正規化値を全入力へ戻し、個別UIに古い値が残らないようにする
		this.bindings.forEach(({ key, control }) => {
			// そのキーの保存値。階層が無いときは undefined
			const value = this.getValue(key);
			// チェックボックスだけ真偽で戻す。それ以外は文字列。種類が違う入力へは入れない
			if (control instanceof HTMLInputElement && control.type === 'checkbox') {
				control.checked = Boolean(value);
			} else {
				control.value = String(value ?? '');
			}

			// 同じ行の色選択。色以外の行には無い
			const picker = control.parentElement?.querySelector<HTMLInputElement>('input[type="color"]');
			// 色選択がある行だけ、空や不正な値をピッカーが受け取れる色へ替える
			if (picker) {
				// 空のときのピッカー色。ホバー枠だけ青、ほかは灰
				const fallback = key === 'imageBorder.hoverColor' ? '#2563eb' : '#888888';
				picker.value   = toColorInputValue(String(value ?? ''), fallback);
			}
		});
	}

	/**
	 * 外部ブラウザがカスタムのときだけ、コマンド入力を表示する
	 */
	private updateExternalBrowserCommandVisibility(): void {
		// コマンド入力がまだ無い。外部ブラウザのセクションを描く前
		if (!this.externalBrowserCommandInput) {
			return;
		}

		this.externalBrowserCommandInput.disabled = this.getValue('externalBrowser.mode') !== 'custom';
	}

	/**
	 * ドット区切りのキーで、保持している設定値を取る
	 * 途中の階層が無いときは undefined
	 * @param key - ドット区切りの設定キー
	 * @returns そのキーの値。階層が無いときは undefined
	 */
	private getValue(key: string): unknown {
		// ドット区切りキーを共通化し、各設定画面がネスト構造を個別にたどらずに済むようにする
		return key.split('.').reduce<unknown>((current, part) => {
			// 途中の階層が無い、またはオブジェクトではない。どちらかならそれ以上たどらない
			if (!current || typeof current !== 'object') {
				return undefined;
			}
			return (current as Record<string, unknown>)[part];
		}, this.settings);
	}

	/**
	 * ダイアログ下部の状態行を書き換える
	 * @param message - 出す文言
	 * @param error - 失敗として目立たせるか。省略時は false
	 */
	private setStatus(message: string, error = false): void {
		this.status.textContent = message;
		this.status.classList.toggle('is-error', error);
	}

	/**
	 * 失敗を状態行へ出せる文字列にする
	 * @param error - catch した値
	 * @returns Error ならその message、それ以外は文字列化した値
	 */
	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	/**
	 * 背面ごとダイアログを文書から外す
	 * 未保存の入力は捨てる。保存済みの値は呼び出し元に残っている
	 */
	private close(): void {
		this.backdrop.remove();
	}
}

/**
 * ドット区切りの設定キーを、部分更新用のネストしたオブジェクトへ展開する
 * 途中の階層は空オブジェクトで作り、最後の部品へ値を入れる
 * @param key - ドット区切りの設定キー
 * @param value - そのキーへ保存する値
 * @returns 変更点だけを持つオブジェクト
 */
function createNestedPatch(key: string, value: unknown): Record<string, unknown> {
	// config:updateが部分更新できるよう、ドット区切りキーを最小のネストオブジェクトへ展開する
	// 部分更新の根。途中の階層だけを持つ
	const root: Record<string, unknown> = {};
	// いま値を足している階層。最初は根
	let current                         = root;
	// ドットで分けたキー。最後の部品だけが値を持つ
	const parts                         = key.split('.');

	parts.forEach((part, index) => {
		// 最後の部品。ここに保存値を置き、それより下は作らない
		if (index === parts.length - 1) {
			current[part] = value;
			return;
		}
		// 次の階層。空のオブジェクトで作る
		const child: Record<string, unknown> = {};
		current[part]                        = child;
		current                              = child;
	});

	return root;
}
