/* eslint-disable jsdoc/require-jsdoc */
import { invokeBridge } from '../bridge';
import type {
	AppSettings,
	ConfigGetResponse,
	ContextMenuSettings,
	CustomDecorationRule,
	CssSnippetsResponse,
	DataDirInfo,
	KeybindingsSettings,
	MigrateDataDirResponse,
	SaveConfigResponse,
} from '../types/app';
import {
	findShortcutConflicts,
	isKnownWindowsReservedShortcut,
	shortcutFromKeyboardEvent,
} from '../utils/keybindings';
import {
	createNewCustomDecorationRule,
	normalizeCustomDecorationRules,
	validateCustomDecorationRules,
} from './customDecorationRules';
import { getCssSnippetsReloadStatus } from './cssSnippets';
import {
	CONTEXT_MENU_ITEM_LABELS,
	createDefaultContextMenuSettings,
	isContextMenuSeparator,
	moveContextMenuItem,
	normalizeContextMenuSettings,
	type ContextMenuKind,
} from './contextMenuSettings';

type SettingsModalOptions = {
	settings: AppSettings;
	customDecorations: CustomDecorationRule[];
	dataDirInfo: DataDirInfo;
	isPortable?: boolean;
	cssSnippets: CssSnippetsResponse;
	onSettingsApplied: (settings: AppSettings) => void;
	onCustomDecorationsApplied: (rules: CustomDecorationRule[]) => void;
	onCssSnippetsApplied: (response: CssSnippetsResponse) => void;
};

type SettingControl = HTMLInputElement | HTMLSelectElement;

type ControlBinding = {
	key: string;
	control: SettingControl;
};

type KeybindingDefinition = {
	key: keyof KeybindingsSettings;
	label: string;
};

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
];

const FIXED_SHORTCUTS: Record<string, string> = {
	'元に戻す'         : 'Ctrl+Z',
	'やり直し'         : 'Ctrl+Y',
	'フォントサイズ拡大'   : 'Ctrl+Shift+=',
	'フォントサイズ縮小'   : 'Ctrl+-',
	'フォントサイズリセット': 'Ctrl+0',
};

/**
 * 設定モーダルを表示し、設定保存・リセット・dataDir移行を処理する。
 */
export class SettingsModal {
	private settings: AppSettings;
	private customDecorations: CustomDecorationRule[];
	private dataDirInfo: DataDirInfo;
	private readonly isPortable: boolean;
	private cssSnippets: CssSnippetsResponse;
	private readonly options: SettingsModalOptions;
	private readonly backdrop: HTMLDivElement;
	private readonly content: HTMLDivElement;
	private readonly status: HTMLParagraphElement;
	private readonly bindings: ControlBinding[] = [];
	private snippetsList: HTMLDivElement | null = null;
	private snippetDirectoryPath: HTMLParagraphElement | null = null;
	private snippetError: HTMLParagraphElement | null = null;
	private dataDirInput: HTMLInputElement | null = null;
	private dataDirResetButton: HTMLButtonElement | null = null;
	private externalBrowserCommandRow: HTMLDivElement | null = null;
	private externalBrowserCommandInput: HTMLInputElement | null = null;
	private decorationsList: HTMLDivElement | null = null;
	private decorationAddButton: HTMLButtonElement | null = null;
	private readonly contextMenuLists = new Map<ContextMenuKind, HTMLDivElement>();

	/**
	 * 設定モーダルを初期化する。
	 * @param {SettingsModalOptions} options 設定と反映コールバック
	 */
	public constructor(options: SettingsModalOptions) {
		this.options           = options;
		this.settings          = { ...options.settings, contextMenu: normalizeContextMenuSettings(options.settings.contextMenu) };
		this.customDecorations = options.customDecorations.map((rule) => ({ ...rule }));
		this.dataDirInfo       = options.dataDirInfo;
		this.isPortable        = options.isPortable === true || options.dataDirInfo.isPortable === true;
		this.cssSnippets       = options.cssSnippets;
		this.backdrop          = document.createElement('div');
		this.content           = document.createElement('div');
		this.status            = document.createElement('p');

		this.backdrop.className = 'tms-mde-dialog-backdrop tms-mde-settings-backdrop';
		this.backdrop.addEventListener('keydown', (event) => {
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
	 * モーダルを表示する。
	 * @returns {void}
	 */
	public open(): void {
		this.render();
		this.backdrop.appendChild(this.content);
		document.body.appendChild(this.backdrop);
		this.content.querySelector<HTMLButtonElement>('.tms-mde-settings-nav-button')?.focus();
	}

	private render(): void {
		this.content.innerHTML = '';
		this.bindings.length   = 0;
		this.contextMenuLists.clear();

		const header     = document.createElement('header');
		header.className = 'tms-mde-settings-header';

		const title       = document.createElement('h2');
		title.id          = 'tmsMdeSettingsTitle';
		title.textContent = '設定';

		const closeButton       = document.createElement('button');
		closeButton.type        = 'button';
		closeButton.className   = 'tms-mde-settings-close';
		closeButton.textContent = '閉じる';
		closeButton.addEventListener('click', () => this.close());
		header.append(title, closeButton);

		const layout         = document.createElement('div');
		layout.className     = 'tms-mde-settings-layout';
		const navigation     = document.createElement('nav');
		navigation.className = 'tms-mde-settings-navigation';
		navigation.setAttribute('aria-label', '設定分類');
		const sections     = document.createElement('div');
		sections.className = 'tms-mde-settings-sections';

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

		const footer         = document.createElement('footer');
		footer.className     = 'tms-mde-settings-footer';
		const resetAll       = document.createElement('button');
		resetAll.type        = 'button';
		resetAll.className   = 'tms-mde-settings-danger';
		resetAll.textContent = 'すべてリセット';
		resetAll.addEventListener('click', () => void this.resetAll());
		footer.append(resetAll, this.status);

		this.content.append(header, layout, footer);
		this.activateSection('appearance');
	}

	private addSection(
		navigation: HTMLElement,
		sections: HTMLElement,
		id: string,
		label: string,
		renderer: (section: HTMLElement) => void,
	): void {
		const button           = document.createElement('button');
		button.type            = 'button';
		button.className       = 'tms-mde-settings-nav-button';
		button.dataset.section = id;
		button.textContent     = label;
		button.addEventListener('click', () => this.activateSection(id));
		navigation.appendChild(button);

		const section           = document.createElement('section');
		section.className       = 'tms-mde-settings-section';
		section.dataset.section = id;
		section.hidden          = true;
		const heading           = document.createElement('h3');
		heading.textContent     = label;
		section.appendChild(heading);
		renderer(section);
		sections.appendChild(section);
	}

	private activateSection(id: string): void {
		this.content.querySelectorAll<HTMLElement>('.tms-mde-settings-section').forEach((section) => {
			section.hidden = section.dataset.section !== id;
		});
		this.content.querySelectorAll<HTMLButtonElement>('.tms-mde-settings-nav-button').forEach((button) => {
			const active = button.dataset.section === id;
			button.classList.toggle('is-active', active);
			button.setAttribute('aria-current', active ? 'page' : 'false');
		});
	}

	private renderAppearance(section: HTMLElement): void {
		this.addSelect(section, 'theme', 'テーマ', [
			['system', 'システム'],
			['dark', 'ダーク'],
			['light', 'ライト'],
		]);
		this.addText(section, 'editorFontFamily', 'エディタフォント');
		this.addText(section, 'codeFontFamily', 'コードブロックフォント');
		this.addNumber(section, 'editorFontSize', 'フォントサイズ', 8, 72);
		this.addCheckbox(section, 'showLineNumbers', '行番号を表示する');
		this.addCheckbox(section, 'showEolMarkers', '改行記号を表示する');
		this.addCheckbox(section, 'wordWrap', '折り返し表示');
		this.addSelect(section, 'outline.side', 'アウトラインの位置', [
			['left', '左'],
			['right', '右'],
		]);
	}

	private renderExport(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'HTMLファイルに付ける見出し一覧です。印刷とPDFでは表示しません。位置は出力HTML内の切り替えで閲覧者が選べます。';
		section.appendChild(description);
		this.addCheckbox(section, 'export.outline.enabled', 'HTML出力にアウトラインを含める');
	}

	private renderEditor(section: HTMLElement): void {
		this.addSelect(section, 'defaultViewMode', '既定の表示モード', [
			['live-preview', 'ライブプレビュー'],
			['source', 'ソース'],
		]);
		this.addNumber(section, 'tabSize', 'タブ幅', 1, 8);
		this.addNumber(section, 'largeFileThresholdMb', 'ライブプレビュー無効化サイズ (MB)', 1, 100);
		this.addCheckbox(section, 'loadRemoteImages', 'リモート画像を読み込む');
		this.addCheckbox(section, 'search.restoreCalloutFoldStateOnMove', '検索移動後にコールアウトの折りたたみを戻す');
	}

	private renderSave(section: HTMLElement): void {
		this.addSelect(section, 'newFileEncoding', '新規ファイルの文字コード', [
			['utf8', 'UTF-8'],
			['utf8Bom', 'UTF-8 (BOM)'],
			['cp932', 'CP932'],
			['utf16Le', 'UTF-16LE'],
		]);
		this.addSelect(section, 'newFileEol', '新規ファイルの改行コード', [
			['crlf', 'CRLF'],
			['lf', 'LF'],
		]);
	}

	private renderFileAndStartup(section: HTMLElement): void {
		const description       = document.createElement('p');
		description.className   = 'tms-mde-settings-description';
		description.textContent = 'インスタンスモードの変更は次回起動時から反映されます。';
		section.appendChild(description);
		this.addSelect(section, 'externalChangeBehavior', '外部変更時の挙動（未編集時）', [
			['auto-reload', '自動で再読込'],
			['confirm', '確認する'],
		]);
		this.addSelect(section, 'instanceMode', 'インスタンスモード（次回起動から）', [
			['single-instance', '単一インスタンス'],
			['new-window', '常に新しいウィンドウ'],
		]);
		this.addCheckbox(section, 'restoreSessionOnStartup', '起動時に前回開いていたタブを復元する');
		this.addCheckbox(section, 'closeAppWhenLastTabClosed', '最後のタブを閉じたらアプリを終了する');
		this.renderExternalBrowser(section);
	}

	private renderExternalBrowser(section: HTMLElement): void {
		const note       = document.createElement('p');
		note.className   = 'tms-mde-settings-description';
		note.textContent = 'Markdownリンクの http(s) URL を開くブラウザを指定します。';
		section.appendChild(note);

		this.addSelect(section, 'externalBrowser.mode', '外部リンクの起動ブラウザ', [
			['default', '既定のブラウザ'],
			['custom', 'カスタム'],
		]);
		this.externalBrowserCommandRow   = this.addText(
			section,
			'externalBrowser.customCommand',
			'カスタム起動コマンド',
		);
		this.externalBrowserCommandInput = this.externalBrowserCommandRow.querySelector<HTMLInputElement>('input');
		this.externalBrowserCommandInput?.setAttribute('placeholder', 'firefox.exe -p "MyProfile_profile1"');
		this.updateExternalBrowserCommandVisibility();
	}

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
		reloadButton.addEventListener('click', () => void this.reloadSnippets());
		const openButton       = document.createElement('button');
		openButton.type        = 'button';
		openButton.textContent = 'フォルダを開く';
		openButton.addEventListener('click', () => void this.openSnippetsFolder());
		const resetButton       = document.createElement('button');
		resetButton.type        = 'button';
		resetButton.textContent = 'すべて無効にする';
		resetButton.addEventListener('click', () => void this.resetItem('cssSnippets.enabled'));
		toolbar.append(reloadButton, openButton, resetButton);

		this.snippetsList           = document.createElement('div');
		this.snippetsList.className = 'tms-mde-settings-snippets';
		section.append(toolbar, this.snippetsList);
		this.renderSnippetList();
	}

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
		addButton.addEventListener('click', () => void this.addCustomDecoration());
		this.decorationAddButton = addButton;
		toolbar.appendChild(addButton);

		this.decorationsList           = document.createElement('div');
		this.decorationsList.className = 'tms-mde-settings-decorations';
		section.append(description, example, toolbar, this.decorationsList);
		this.renderCustomDecorationList();
	}

	private renderCustomDecorationList(): void {
		if (!this.decorationsList) {
			return;
		}

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
			enabled.addEventListener('change', () => void this.changeCustomDecoration(index, {
				enabled: enabled.checked,
			}, enabled));
			enabledLabel.append(enabled, document.createTextNode('有効'));
			const remove       = document.createElement('button');
			remove.type        = 'button';
			remove.className   = 'tms-mde-settings-danger';
			remove.textContent = '削除';
			remove.addEventListener('click', () => void this.removeCustomDecoration(index));
			header.append(enabledLabel, remove);

			const fields     = document.createElement('div');
			fields.className = 'tms-mde-settings-decoration-fields';
			fields.append(
				this.createDecorationTextField(index, 'name', 'ルール名', rule.name, '例：下線'),
				this.createDecorationTextField(index, 'pattern', '正規表現', rule.pattern, '例：_v(.+?)_v'),
				this.createDecorationTextField(index, 'cssClass', 'CSSクラス', rule.cssClass, '例：tms-custom-1'),
			);

			const hideLabel     = document.createElement('label');
			hideLabel.className = 'tms-mde-settings-decoration-check';
			const hide          = document.createElement('input');
			hide.type           = 'checkbox';
			hide.checked        = Boolean(rule.hideDelimiters);
			hide.addEventListener('change', () => void this.changeCustomDecoration(index, {
				hideDelimiters: hide.checked,
			}, hide));
			hideLabel.append(hide, document.createTextNode('最初のキャプチャグループの前後にある区切り記号を隠す'));

			const note       = document.createElement('p');
			note.className   = 'tms-mde-settings-description';
			note.textContent = '最初のキャプチャグループ (...) が装飾対象です。キャプチャグループがない場合は一致全体を装飾します。';
			card.append(legend, header, fields, hideLabel, note);
			this.decorationsList?.appendChild(card);
		});
	}

	private createDecorationTextField(
		index: number,
		field: 'name' | 'pattern' | 'cssClass',
		labelText: string,
		value: string,
		placeholder: string,
	): HTMLLabelElement {
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
		input.addEventListener('change', () => void this.changeCustomDecoration(index, {
			[field]: input.value,
		}, input));
		label.append(caption, input);
		return label;
	}

	private async addCustomDecoration(): Promise<void> {
		const next  = [...this.customDecorations, createNewCustomDecorationRule(this.customDecorations)];
		const saved = await this.saveCustomDecorations(next, true);
		if (saved) {
			const inputs = this.decorationsList?.querySelectorAll<HTMLInputElement>('[data-decoration-field="name"]');
			const input  = inputs?.item(inputs.length - 1);
			input?.focus();
			input?.select();
		}
	}

	private async removeCustomDecoration(index: number): Promise<void> {
		const rule = this.customDecorations[index];
		if (!rule || !window.confirm(`カスタム装飾ルール「${rule.name || `ルール ${index + 1}`}」を削除しますか？`)) {
			return;
		}

		const next = this.customDecorations.filter((_, currentIndex) => currentIndex !== index);
		await this.saveCustomDecorations(next, true);
	}

	private async changeCustomDecoration(
		index: number,
		patch: Partial<CustomDecorationRule>,
		control: HTMLInputElement,
	): Promise<void> {
		const next = this.customDecorations.map((rule, currentIndex) => currentIndex === index
			? { ...rule, ...patch }
			: rule);
		await this.saveCustomDecorations(next, false, control);
	}

	private async saveCustomDecorations(
		next: CustomDecorationRule[],
		rerender: boolean,
		focusControl?: HTMLInputElement,
	): Promise<boolean> {
		const previous         = this.customDecorations;
		this.customDecorations = next;
		if (rerender) {
			this.renderCustomDecorationList();
		}

		const errors = validateCustomDecorationRules(next);
		this.markCustomDecorationErrors(errors);
		if (errors.length > 0) {
			this.setStatus(`ルール ${errors[0]!.index + 1}: ${errors[0]!.message}`, true);
			return false;
		}

		this.setDecorationControlsDisabled(true);
		this.setStatus('カスタム装飾ルールを保存中...');
		try {
			const normalized = normalizeCustomDecorationRules(next);
			const result     = await invokeBridge<SaveConfigResponse>('config:update', {
				customDecorations: normalized,
			});
			if (!result.success || !result.config) {
				throw new Error(result.message ?? 'カスタム装飾ルールを保存できませんでした。');
			}
			this.customDecorations = result.config.customDecorations.map((rule) => ({ ...rule }));
			this.options.onCustomDecorationsApplied(result.config.customDecorations);
			this.setStatus('カスタム装飾ルールを保存しました。');
			return true;
		} catch (error) {
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

	private markCustomDecorationErrors(
		errors: ReturnType<typeof validateCustomDecorationRules>,
	): void {
		this.decorationsList?.querySelectorAll<HTMLInputElement>('[data-decoration-field]').forEach((input) => {
			input.removeAttribute('aria-invalid');
			input.removeAttribute('title');
		});
		errors.forEach((error) => {
			const input = this.decorationsList?.querySelector<HTMLInputElement>(
				`[data-decoration-index="${error.index}"][data-decoration-field="${error.field}"]`,
			);
			input?.setAttribute('aria-invalid', 'true');
			input?.setAttribute('title', error.message);
		});
	}

	private setDecorationControlsDisabled(disabled: boolean): void {
		if (this.decorationAddButton) {
			this.decorationAddButton.disabled = disabled;
		}
		this.decorationsList?.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
			control.disabled = disabled;
		});
	}

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
			input.addEventListener('focus', () => {
				input.select();
				this.setStatus('キーを入力してください。Escapeで設定画面を閉じます。');
			});
			input.addEventListener('keydown', (event) => {
				event.preventDefault();
				event.stopPropagation();
				if (event.key === 'Escape') {
					this.close();
					return;
				}
				const shortcut = shortcutFromKeyboardEvent(event);
				if (shortcut) {
					void this.saveKeybinding(definition, shortcut, input);
				}
			});
			this.addControlRow(section, key, definition.label, input);
		});
	}

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
		reset.addEventListener('click', () => void this.resetContextMenus(reset));
		section.appendChild(reset);
	}

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

	private renderContextMenuList(kind: ContextMenuKind): void {
		const list = this.contextMenuLists.get(kind);
		if (!list) {
			return;
		}

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
			up.addEventListener('click', () => void this.moveContextMenuItem(kind, itemId, -1, up));
			const down       = document.createElement('button');
			down.type        = 'button';
			down.textContent = '下へ';
			down.disabled    = index === order.length - 1;
			down.setAttribute('aria-label', `${label.textContent}を下へ移動`);
			down.addEventListener('click', () => void this.moveContextMenuItem(kind, itemId, 1, down));
			actions.append(up, down);
			row.append(visible, label, actions);
			list.appendChild(row);
		});
	}

	private async setContextMenuItemVisible(
		kind: ContextMenuKind,
		itemId: string,
		visible: boolean,
		control: HTMLInputElement,
	): Promise<void> {
		const next      = this.cloneContextMenuSettings();
		const hiddenKey = kind === 'editor' ? 'editorHidden' : 'tabHidden';
		const hidden    = new Set(next[hiddenKey]);
		if (visible) hidden.delete(itemId);
		else hidden.add(itemId);
		next[hiddenKey] = [...hidden];
		await this.saveContextMenuSettings(next, control);
	}

	private async moveContextMenuItem(
		kind: ContextMenuKind,
		itemId: string,
		direction: -1 | 1,
		control: HTMLButtonElement,
	): Promise<void> {
		const next     = this.cloneContextMenuSettings();
		const orderKey = kind === 'editor' ? 'editorOrder' : 'tabOrder';
		next[orderKey] = moveContextMenuItem(next[orderKey], itemId, direction);
		await this.saveContextMenuSettings(next, control);
	}

	private async resetContextMenus(control: HTMLButtonElement): Promise<void> {
		await this.saveContextMenuSettings(createDefaultContextMenuSettings(), control, '右クリックメニューを既定値へ戻しました。');
	}

	private async saveContextMenuSettings(
		next: ContextMenuSettings,
		control: HTMLInputElement | HTMLButtonElement,
		successMessage = '右クリックメニュー設定を保存しました。',
	): Promise<void> {
		control.disabled = true;
		this.setStatus('右クリックメニュー設定を保存中...');
		try {
			this.settings             = await this.updateSettings({ contextMenu: next });
			this.settings.contextMenu = normalizeContextMenuSettings(this.settings.contextMenu);
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.setStatus(successMessage);
		} catch (error) {
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.setStatus(this.formatError(error), true);
		} finally {
			control.disabled = false;
		}
	}

	private cloneContextMenuSettings(): ContextMenuSettings {
		const source = normalizeContextMenuSettings(this.settings.contextMenu);
		return {
			editorOrder : [...source.editorOrder],
			editorHidden: [...source.editorHidden],
			tabOrder    : [...source.tabOrder],
			tabHidden   : [...source.tabHidden],
		};
	}

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
		browse.addEventListener('click', () => void this.changeDataDir());
		const reset       = document.createElement('button');
		reset.type        = 'button';
		reset.textContent = '既定値へ戻す';
		reset.disabled    = this.dataDirInfo.dataDir.toLowerCase() === this.dataDirInfo.defaultDataDir.toLowerCase();
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

	private addText(section: HTMLElement, key: string, label: string): HTMLDivElement {
		const input = document.createElement('input');
		input.type  = 'text';
		input.value = String(this.getValue(key));
		input.addEventListener('change', () => void this.saveValue(key, input.value, input));
		return this.addControlRow(section, key, label, input);
	}

	private addNumber(section: HTMLElement, key: string, label: string, min: number, max: number): HTMLDivElement {
		const input = document.createElement('input');
		input.type  = 'number';
		input.min   = String(min);
		input.max   = String(max);
		input.value = String(this.getValue(key));
		input.addEventListener('change', () => void this.saveValue(key, Number(input.value), input));
		return this.addControlRow(section, key, label, input);
	}

	private addCheckbox(section: HTMLElement, key: string, label: string): HTMLDivElement {
		const input   = document.createElement('input');
		input.type    = 'checkbox';
		input.checked = Boolean(this.getValue(key));
		input.addEventListener('change', () => void this.saveValue(key, input.checked, input));
		return this.addControlRow(section, key, label, input);
	}

	private addSelect(section: HTMLElement, key: string, label: string, options: Array<[string, string]>): HTMLDivElement {
		const select = document.createElement('select');
		options.forEach(([value, text]) => {
			const option       = document.createElement('option');
			option.value       = value;
			option.textContent = text;
			select.appendChild(option);
		});
		select.value = String(this.getValue(key));
		select.addEventListener('change', () => void this.saveValue(key, select.value, select));
		return this.addControlRow(section, key, label, select);
	}

	private addControlRow(section: HTMLElement, key: string, labelText: string, control: SettingControl): HTMLDivElement {
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
		reset.addEventListener('click', (event) => {
			event.preventDefault();
			void this.resetItem(key);
		});
		control.setAttribute('aria-label', labelText);

		row.append(label, control, reset);
		section.appendChild(row);
		this.bindings.push({ key, control });
		return row;
	}

	private async saveValue(key: string, value: unknown, control: SettingControl): Promise<void> {
		control.disabled = true;
		this.setStatus('保存中...');
		try {
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
			if (document.contains(control)) {
				control.focus();
			}
		}
	}

	private async saveKeybinding(
		definition: KeybindingDefinition,
		shortcut: string,
		input: HTMLInputElement,
	): Promise<void> {
		const conflicts          = findShortcutConflicts(
			this.settings.keybindings as unknown as Record<string, string>,
			definition.key,
			shortcut,
		);
		const fixedConflicts     = findShortcutConflicts(FIXED_SHORTCUTS, '', shortcut);
		const warnings: string[] = [];
		if (conflicts.length > 0) {
			const labels = conflicts.map((key) => KEYBINDING_DEFINITIONS.find((item) => item.key === key)?.label ?? key);
			warnings.push(`「${labels.join('、')}」と競合します。`);
		}
		if (fixedConflicts.length > 0) {
			warnings.push(`固定操作「${fixedConflicts.join('、')}」と競合します。`);
		}
		if (isKnownWindowsReservedShortcut(shortcut)) {
			warnings.push('Ctrl+Shift+0 はWindowsで予約され、アプリへ届かない環境があります。');
		}
		if (warnings.length > 0 && !window.confirm(`${warnings.join('\n')}\n\nこの割り当てを保存しますか？`)) {
			this.setStatus('キーバインドの変更をキャンセルしました。');
			return;
		}

		await this.saveValue(`keybindings.${definition.key}`, shortcut, input);
	}

	private async updateSettings(patch: Record<string, unknown>): Promise<AppSettings> {
		const result = await invokeBridge<SaveConfigResponse>('config:update', { settings: patch });
		if (!result.success || !result.config) {
			throw new Error(result.message ?? '設定を保存できませんでした。');
		}
		this.options.onSettingsApplied(result.config.settings);
		return result.config.settings;
	}

	private async resetItem(key: string): Promise<void> {
		this.setStatus('リセット中...');
		try {
			const result = await invokeBridge<SaveConfigResponse>('config:resetItem', { itemKey: key });
			if (!result.success || !result.config) {
				throw new Error(result.message ?? '設定をリセットできませんでした。');
			}
			this.settings = result.config.settings;
			this.options.onSettingsApplied(this.settings);
			this.syncControls();
			this.renderContextMenuList('editor');
			this.renderContextMenuList('tab');
			this.updateExternalBrowserCommandVisibility();
			if (key === 'cssSnippets.enabled') {
				await this.reloadSnippets();
			}
			this.setStatus('設定を既定値へ戻しました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	private async resetAll(): Promise<void> {
		if (!window.confirm('dataDirを除くすべての設定を既定値へ戻します。よろしいですか？')) {
			return;
		}
		this.setStatus('すべての設定をリセット中...');
		try {
			const result = await invokeBridge<SaveConfigResponse>('config:resetAll');
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

	private async reloadSnippets(): Promise<void> {
		this.setStatus('CSSスニペットを再読み込み中...');
		try {
			this.cssSnippets = await invokeBridge<CssSnippetsResponse>('cssSnippets:list');
			this.options.onCssSnippetsApplied(this.cssSnippets);
			this.updateSnippetDirectoryInfo();
			this.renderSnippetList();
			const status = getCssSnippetsReloadStatus(this.cssSnippets);
			this.setStatus(status.message, status.isError);
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	private renderSnippetList(): void {
		if (!this.snippetsList) {
			return;
		}
		this.snippetsList.innerHTML = '';
		if (this.cssSnippets.snippets.length === 0) {
			const empty       = document.createElement('p');
			empty.className   = 'tms-mde-settings-description';
			empty.textContent = '.css ファイルがありません。';
			this.snippetsList.appendChild(empty);
			return;
		}

		this.cssSnippets.snippets.forEach((snippet) => {
			const label       = document.createElement('label');
			label.className   = 'tms-mde-settings-snippet';
			const checkbox    = document.createElement('input');
			checkbox.type     = 'checkbox';
			checkbox.checked  = snippet.enabled;
			checkbox.disabled = Boolean(snippet.error);
			checkbox.addEventListener('change', () => void this.toggleSnippet(snippet.name, checkbox.checked, checkbox));
			const name       = document.createElement('span');
			name.textContent = snippet.name;
			label.append(checkbox, name);
			if (snippet.error) {
				const error       = document.createElement('span');
				error.className   = 'tms-mde-settings-inline-error';
				error.textContent = snippet.error;
				label.appendChild(error);
			}
			this.snippetsList?.appendChild(label);
		});
	}

	private updateSnippetDirectoryInfo(): void {
		if (this.snippetDirectoryPath) {
			this.snippetDirectoryPath.textContent = `現在参照しているフォルダ: ${this.cssSnippets.directoryPath}`;
		}

		if (this.snippetError) {
			this.snippetError.textContent = this.cssSnippets.error ?? '';
			this.snippetError.hidden      = !this.cssSnippets.error;
		}
	}

	private async toggleSnippet(name: string, enabled: boolean, checkbox: HTMLInputElement): Promise<void> {
		const current = new Set(this.settings.cssSnippets.enabled);
		if (enabled) {
			current.add(name);
		} else {
			current.delete(name);
		}

		checkbox.disabled = true;
		try {
			this.settings = await this.updateSettings({
				cssSnippets: { enabled: [...current] },
			});
			await this.reloadSnippets();
		} catch (error) {
			checkbox.checked = !enabled;
			this.setStatus(this.formatError(error), true);
		} finally {
			checkbox.disabled = false;
		}
	}

	private async openSnippetsFolder(): Promise<void> {
		try {
			await invokeBridge('cssSnippets:openFolder');
			this.setStatus('CSSスニペットフォルダを開きました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	private async changeDataDir(): Promise<void> {
		if (this.isPortable) {
			this.setStatus('ポータブル版ではデータ保存先を変更できません。', true);
			return;
		}
		if (!window.confirm('データ保存先を変更し、config・snippets・backupsを移行します。移行元は削除されません。続行しますか？')) {
			return;
		}
		this.setStatus('データを移行中です。アプリを終了しないでください...');
		try {
			const result = await invokeBridge<MigrateDataDirResponse>('config:changeDataDir');
			if (!result.success) {
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

	private async resetDataDir(): Promise<void> {
		if (this.isPortable) {
			this.setStatus('ポータブル版ではデータ保存先を変更できません。', true);
			return;
		}
		if (!window.confirm('dataDirを既定の保存先へ戻し、データを移行します。移行元は削除されません。続行しますか？')) {
			return;
		}
		this.setStatus('既定のdataDirへ移行中です...');
		try {
			const result = await invokeBridge<SaveConfigResponse>('config:resetItem', { itemKey: 'dataDir' });
			if (!result.success) {
				throw new Error(result.message ?? 'dataDirを既定値へ戻せませんでした。');
			}
			await this.refreshAfterDataDirChange();
			this.setStatus('dataDirを既定の保存先へ戻しました。');
		} catch (error) {
			this.setStatus(this.formatError(error), true);
		}
	}

	private async refreshAfterDataDirChange(): Promise<void> {
		const config           = await invokeBridge<ConfigGetResponse>('config:get');
		this.settings          = config.config.settings;
		this.customDecorations = config.config.customDecorations.map((rule) => ({ ...rule }));
		this.dataDirInfo       = config.dataDirInfo;
		this.cssSnippets       = await invokeBridge<CssSnippetsResponse>('cssSnippets:list');
		this.options.onSettingsApplied(this.settings);
		this.options.onCustomDecorationsApplied(this.customDecorations);
		this.options.onCssSnippetsApplied(this.cssSnippets);
		this.syncControls();
		if (this.dataDirInput) {
			this.dataDirInput.value = this.dataDirInfo.dataDir;
		}
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

	private syncControls(): void {
		this.bindings.forEach(({ key, control }) => {
			const value = this.getValue(key);
			if (control instanceof HTMLInputElement && control.type === 'checkbox') {
				control.checked = Boolean(value);
			} else {
				control.value = String(value ?? '');
			}
		});
	}

	private updateExternalBrowserCommandVisibility(): void {
		if (!this.externalBrowserCommandInput) {
			return;
		}

		this.externalBrowserCommandInput.disabled = this.getValue('externalBrowser.mode') !== 'custom';
	}

	private getValue(key: string): unknown {
		return key.split('.').reduce<unknown>((current, part) => {
			if (!current || typeof current !== 'object') {
				return undefined;
			}
			return (current as Record<string, unknown>)[part];
		}, this.settings);
	}

	private setStatus(message: string, error = false): void {
		this.status.textContent = message;
		this.status.classList.toggle('is-error', error);
	}

	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private close(): void {
		this.backdrop.remove();
	}
}

function createNestedPatch(key: string, value: unknown): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	let current                         = root;
	const parts                         = key.split('.');

	parts.forEach((part, index) => {
		if (index === parts.length - 1) {
			current[part] = value;
			return;
		}
		const child: Record<string, unknown> = {};
		current[part]                        = child;
		current                              = child;
	});

	return root;
}
