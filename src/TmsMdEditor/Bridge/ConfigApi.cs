// ==============================================
// 設定の取得と保存
// ==============================================

// Web 層からの部分更新を ConfigStore へ渡し、成功したときだけメモリ上の設定を差し替える
// 対象が無い、または形式が不正なときは保存せず、失敗メッセージを返す

using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// config:* を受けるブリッジ。ポータブル版ではデータ保存先の変更を拒否する
/// </summary>
internal sealed class ConfigApi
{
	/// <summary>
	/// 設定の読み書き先。API より長く生きる
	/// </summary>
	private readonly AppContext _appContext;

	/// <summary>
	/// 設定の保存に成功したあと、メニューのショートカット表示を更新する。失敗時は呼ばない
	/// </summary>
	private readonly Action _onSettingsChanged;

	/// <summary>
	/// 設定 API を作る。コンテキストは借用する
	/// </summary>
	/// <param name="appContext">設定ストアと現在の設定。null は渡さない</param>
	/// <param name="onSettingsChanged">保存成功後に呼ぶ処理。データ保存先の変更成功時も呼ぶ。null は渡さない</param>
	public ConfigApi(AppContext appContext, Action onSettingsChanged)
	{
		_appContext       = appContext;
		_onSettingsChanged = onSettingsChanged;
	}

	/// <summary>
	/// 現在の設定、データ保存先、ポータブルかどうか、添付フォルダの既定値を返す
	/// ディスクは読み直さない
	/// </summary>
	/// <returns>Web 層の起動後と設定画面が読む応答</returns>
	public ConfigGetResponse GetConfig()
	{
		// 起動後と設定画面が読む応答。ディスクは読み直さない
		return new ConfigGetResponse
		{
			// メモリ上の設定。保存失敗時は直前の値のまま
			Config                   = _appContext.Config,
			// 現在と既定のデータ保存先
			DataDirInfo              = _appContext.ConfigStore.GetDataDirInfo(),
			// true ならポータブル配置。データ保存先の変更は拒否する
			IsPortable               = AppPaths.IsPortable,
			// 添付フォルダの既定。設定が空のときの候補
			DefaultAttachmentFolder  = AttachmentFolder.GetDefaultFolder(),
		};
	}

	/// <summary>
	/// settings、カスタム装飾、ウィンドウのいずれかを保存する
	/// 対象が無い、または装飾の JSON が配列でないときは保存せず失敗を返す
	/// </summary>
	/// <param name="paramsElement">settings、customDecorations、window のいずれか 1 つを持つ JSON</param>
	/// <returns>保存結果。失敗時はメモリ上の設定を変えない</returns>
	public SaveConfigResult Update(JsonElement paramsElement)
	{
		// settings があるとき。装飾やウィンドウが同時にあっても、こちらを先に保存する
		if (paramsElement.TryGetProperty(BridgeProperty.Settings, out JsonElement settingsElement))
		{
			// 設定の部分更新の結果。失敗時は Config が null
			SaveConfigResult result = _appContext.ConfigStore.UpdateSettings(settingsElement);
			ApplySavedConfig(result);
			return result;
		}

		// settings が無く、customDecorations があるとき。プロパティが無いとこの分岐には入らない
		if (paramsElement.TryGetProperty(BridgeProperty.CustomDecorations, out JsonElement decorationsElement))
		{
			// 配列でないとき。オブジェクトや null では保存しない
			if (decorationsElement.ValueKind != JsonValueKind.Array)
			{
				// 形式不正で保存しなかった結果。メモリ上の設定は変えない
				return new SaveConfigResult
				{
					// false は未保存
					Success = false,
					// Web 層へ返す理由。空にはしない
					Message = "カスタム装飾ルールの形式が正しくありません。",
				};
			}

			try
			{
				// 配列を規則へ変換した結果。要素の null は形式不正。変換不能なら例外
				List<CustomDecorationRule?>? parsed = decorationsElement.Deserialize<List<CustomDecorationRule?>>(BridgeJson.Options);
				// 変換結果が null、または要素に null があるとき。片方でも保存しない
				if (parsed is null || parsed.Any(rule => rule is null))
				{
					// 要素が欠けているため保存しなかった結果
					return new SaveConfigResult
					{
						// false は未保存
						Success = false,
						// Web 層へ返す理由。空にはしない
						Message = "カスタム装飾ルールの形式が正しくありません。",
					};
				}

				// 装飾の差し替え結果。成功したときだけメモリとメニューを更新する
				SaveConfigResult result = _appContext.ConfigStore.UpdateCustomDecorations(parsed.Select(rule => rule!));
				ApplySavedConfig(result);
				return result;
			}
			catch (JsonException)
			{
				// JSON として規則にならないとき。保存せず失敗を返す
				return new SaveConfigResult
				{
					// false は未保存
					Success = false,
					// Web 層へ返す理由。空にはしない
					Message = "カスタム装飾ルールの形式が正しくありません。",
				};
			}
		}

		// settings も装飾も無く、window があるとき。プロパティが無いとウィンドウは保存しない
		if (paramsElement.TryGetProperty(BridgeProperty.Window, out JsonElement windowElement))
		{
			// ウィンドウ以外を写す現在の文書
			AppConfigDocument current = _appContext.Config;
			// 要求のウィンドウ。JSON が WindowConfig の形でなければ null で、現在のウィンドウを残す
			WindowConfig? window = windowElement.Deserialize<WindowConfig>(BridgeJson.Options);
			// ウィンドウだけを差し替えた保存。他の節は current のまま
			SaveConfigResult result = _appContext.ConfigStore.Save(new AppConfigDocument
			{
				// 形式版。この保存では変えない
				SchemaVersion     = current.SchemaVersion,
				// 要求が null のときは現在のウィンドウを残す
				Window            = window ?? current.Window,
				// エディタ設定。この保存では変えない
				Settings          = current.Settings,
				// カスタム装飾。この保存では変えない
				CustomDecorations = current.CustomDecorations,
				// 最近使ったファイル。この保存では変えない
				RecentFiles       = current.RecentFiles,
			});
			ApplySavedConfig(result);
			return result;
		}

		// 対象プロパティが一つも無いときの失敗。保存しない
		return new SaveConfigResult
		{
			// false は未保存
			Success = false,
			// 対象が指定されなかった理由
			Message = "更新対象が指定されていません。",
		};
	}

	/// <summary>
	/// 指定した設定項目だけを既定値へ戻して保存する。成功したときだけメモリとメニューを更新する
	/// </summary>
	/// <param name="paramsElement">itemKey を持つ JSON。無いときは空文字としてストアへ渡し、失敗結果を返す</param>
	/// <returns>保存結果。未知のキーはストアが失敗にする</returns>
	public SaveConfigResult ResetItem(JsonElement paramsElement)
	{
		// 既定値へ戻す項目キー。プロパティが無い、または null のときは空文字で、ストアが失敗にする
		string itemKey = paramsElement.TryGetProperty(BridgeProperty.ItemKey, out JsonElement keyElement)
			? keyElement.GetString() ?? string.Empty
			: string.Empty;

		// 項目だけのリセット結果。失敗時はメモリもメニューも変えない
		SaveConfigResult result = _appContext.ConfigStore.ResetSettingItem(itemKey);
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// データ保存先以外の設定を既定値へ戻して保存する。成功したときだけメモリとメニューを更新する
	/// </summary>
	/// <returns>保存結果。書き込みに失敗しても例外は出さない</returns>
	public SaveConfigResult ResetAll()
	{
		// データ保存先以外を既定値へ戻した結果。失敗時はメモリもメニューも変えない
		SaveConfigResult result = _appContext.ConfigStore.ResetAllSettings();
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// 現在と既定のデータ保存先、ポータブルかどうかを返す。設定ファイルは読み直さない
	/// </summary>
	/// <returns>データ保存先の情報</returns>
	public DataDirInfo GetDataDir()
	{
		return _appContext.ConfigStore.GetDataDirInfo();
	}

	/// <summary>
	/// データ保存先を指定パスへ移す。ポータブル版、またはパスが空のときは移さず失敗を返す
	/// 成功したときはメモリ上の設定をストアのキャッシュで置き換える
	/// </summary>
	/// <param name="paramsElement">dataDir を持つ JSON。プロパティが無いときは失敗を返す</param>
	/// <returns>移行結果。失敗時は保存先を変えない</returns>
	public MigrateDataDirResult ChangeDataDir(JsonElement paramsElement)
	{
		// ポータブル版は保存先を移せない。ダイアログも出さない
		if (AppPaths.IsPortable)
		{
			// 移行しなかった結果。保存先は変わらない
			return new MigrateDataDirResult
			{
				// false は未移行
				Success = false,
				// 拒否した理由。空にはしない
				Message = "ポータブル版ではデータ保存先を変更できません。",
			};
		}

		// dataDir があるとき。プロパティが無いと末尾の失敗を返す
		if (paramsElement.TryGetProperty(BridgeProperty.DataDir, out JsonElement dataDirElement))
		{
			// 移す先。null や空白は失敗で、フォルダは作らない
			string? dataDir = dataDirElement.GetString();
			// パスが空のとき。空白だけも空として扱う
			if (string.IsNullOrWhiteSpace(dataDir))
			{
				// パスが空のため移行しなかった結果
				return new MigrateDataDirResult
				{
					// false は未移行
					Success = false,
					// パスが無かった理由
					Message = "保存先フォルダが指定されていません。",
				};
			}

			// 移行結果。成功したときだけメモリ上の設定をキャッシュで置き換える
			MigrateDataDirResult result = _appContext.ConfigStore.MigrateDataDir(dataDir);
			// 移行に成功したとき。失敗時は保存先もメニューも変えない
			if (result.Success)
			{
				_appContext.Config = _appContext.ConfigStore.CachedConfig ?? _appContext.Config;
				_onSettingsChanged();
			}

			return result;
		}

		// dataDir プロパティが無いときの失敗
		return new MigrateDataDirResult
		{
			// false は未移行
			Success = false,
			// プロパティが無かった理由
			Message = "dataDir が指定されていません。",
		};
	}

	/// <summary>
	/// フォルダ選択ダイアログでデータ保存先を選ばせ、選ばれたパスへ移す
	/// ポータブル版とキャンセルは失敗結果にし、例外は出さない
	/// </summary>
	/// <returns>移行結果。キャンセル時の Message はキャンセルされた旨</returns>
	public MigrateDataDirResult ChangeDataDirWithDialog()
	{
		// ポータブル版はフォルダ選択も出さない
		if (AppPaths.IsPortable)
		{
			// 移行しなかった結果。保存先は変わらない
			return new MigrateDataDirResult
			{
				// false は未移行
				Success = false,
				// 拒否した理由。空にはしない
				Message = "ポータブル版ではデータ保存先を変更できません。",
			};
		}

		// 現在の保存先を初期選択にしたフォルダダイアログ
		using var dialog = new FolderBrowserDialog
		{
			// ダイアログ本文。タイトルにも同じ文言を使う
			Description        = "データ保存先フォルダを選択してください",
			// true なら Description をタイトルバーに出す
			UseDescriptionForTitle = true,
			// 初期選択。空のときはダイアログの既定位置
			SelectedPath       = _appContext.ConfigStore.GetDataDirInfo().DataDir,
		};

		// キャンセル、またはパスが空のとき。どちらか一方でも移行しない
		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.SelectedPath))
		{
			// ユーザーが選ばなかった結果。保存先は変わらない
			return new MigrateDataDirResult
			{
				// false は未移行
				Success = false,
				// キャンセルした旨。空にはしない
				Message = "キャンセルされました。",
			};
		}

		// 選ばれたパスへの移行結果。成功したときだけメモリをキャッシュで置き換える
		MigrateDataDirResult result = _appContext.ConfigStore.MigrateDataDir(dialog.SelectedPath);
		// 移行に成功したとき。失敗時は保存先もメニューも変えない
		if (result.Success)
		{
			_appContext.Config = _appContext.ConfigStore.CachedConfig ?? _appContext.Config;
			_onSettingsChanged();
		}

		return result;
	}

	/// <summary>
	/// 保存に成功した設定をメモリへ反映し、メニュー表示の更新を呼ぶ
	/// 失敗、または Config が null のときは何もしない
	/// </summary>
	/// <param name="result">Update、ResetItem、ResetAll の保存結果</param>
	private void ApplySavedConfig(SaveConfigResult result)
	{
		// 保存に成功し、かつ文書があるときだけメモリとメニュー表示を更新する。片方でも欠けると何もしない
		if (result.Success && result.Config is not null)
		{
			_appContext.Config = result.Config;
			_onSettingsChanged();
		}
	}
}
