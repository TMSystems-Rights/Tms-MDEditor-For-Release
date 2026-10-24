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
		return new ConfigGetResponse
		{
			Config                   = _appContext.Config,
			DataDirInfo              = _appContext.ConfigStore.GetDataDirInfo(),
			IsPortable               = AppPaths.IsPortable,
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
		if (paramsElement.TryGetProperty(BridgeProperty.Settings, out JsonElement settingsElement))
		{
			SaveConfigResult result = _appContext.ConfigStore.UpdateSettings(settingsElement);
			ApplySavedConfig(result);
			return result;
		}

		if (paramsElement.TryGetProperty(BridgeProperty.CustomDecorations, out JsonElement decorationsElement))
		{
			if (decorationsElement.ValueKind != JsonValueKind.Array)
			{
				return new SaveConfigResult
				{
					Success = false,
					Message = "カスタム装飾ルールの形式が正しくありません。",
				};
			}

			try
			{
				List<CustomDecorationRule?>? parsed = decorationsElement.Deserialize<List<CustomDecorationRule?>>(BridgeJson.Options);
				if (parsed is null || parsed.Any(rule => rule is null))
				{
					return new SaveConfigResult
					{
						Success = false,
						Message = "カスタム装飾ルールの形式が正しくありません。",
					};
				}

				SaveConfigResult result = _appContext.ConfigStore.UpdateCustomDecorations(parsed.Select(rule => rule!));
				ApplySavedConfig(result);
				return result;
			}
			catch (JsonException)
			{
				return new SaveConfigResult
				{
					Success = false,
					Message = "カスタム装飾ルールの形式が正しくありません。",
				};
			}
		}

		if (paramsElement.TryGetProperty(BridgeProperty.Window, out JsonElement windowElement))
		{
			AppConfigDocument current = _appContext.Config;
			WindowConfig? window = windowElement.Deserialize<WindowConfig>(BridgeJson.Options);
			SaveConfigResult result = _appContext.ConfigStore.Save(new AppConfigDocument
			{
				SchemaVersion     = current.SchemaVersion,
				Window            = window ?? current.Window,
				Settings          = current.Settings,
				CustomDecorations = current.CustomDecorations,
				RecentFiles       = current.RecentFiles,
			});
			ApplySavedConfig(result);
			return result;
		}

		return new SaveConfigResult
		{
			Success = false,
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
		string itemKey = paramsElement.TryGetProperty(BridgeProperty.ItemKey, out JsonElement keyElement)
			? keyElement.GetString() ?? string.Empty
			: string.Empty;

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
		if (AppPaths.IsPortable)
		{
			return new MigrateDataDirResult
			{
				Success = false,
				Message = "ポータブル版ではデータ保存先を変更できません。",
			};
		}

		if (paramsElement.TryGetProperty(BridgeProperty.DataDir, out JsonElement dataDirElement))
		{
			string? dataDir = dataDirElement.GetString();
			if (string.IsNullOrWhiteSpace(dataDir))
			{
				return new MigrateDataDirResult
				{
					Success = false,
					Message = "保存先フォルダが指定されていません。",
				};
			}

			MigrateDataDirResult result = _appContext.ConfigStore.MigrateDataDir(dataDir);
			if (result.Success)
			{
				_appContext.Config = _appContext.ConfigStore.CachedConfig ?? _appContext.Config;
				_onSettingsChanged();
			}

			return result;
		}

		return new MigrateDataDirResult
		{
			Success = false,
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
		if (AppPaths.IsPortable)
		{
			return new MigrateDataDirResult
			{
				Success = false,
				Message = "ポータブル版ではデータ保存先を変更できません。",
			};
		}

		using var dialog = new FolderBrowserDialog
		{
			Description        = "データ保存先フォルダを選択してください",
			UseDescriptionForTitle = true,
			SelectedPath       = _appContext.ConfigStore.GetDataDirInfo().DataDir,
		};

		if (dialog.ShowDialog() != DialogResult.OK || string.IsNullOrWhiteSpace(dialog.SelectedPath))
		{
			return new MigrateDataDirResult
			{
				Success = false,
				Message = "キャンセルされました。",
			};
		}

		MigrateDataDirResult result = _appContext.ConfigStore.MigrateDataDir(dialog.SelectedPath);
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
		if (result.Success && result.Config is not null)
		{
			_appContext.Config = result.Config;
			_onSettingsChanged();
		}
	}
}
