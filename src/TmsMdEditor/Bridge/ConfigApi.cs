using System.Text.Json;
using TmsMdEditor.Models;
using TmsMdEditor.Services;

namespace TmsMdEditor.Bridge;

/// <summary>
/// 設定関連ブリッジ API
/// </summary>
internal sealed class ConfigApi
{
	private readonly AppContext _appContext;
	private readonly Action _onSettingsChanged;

	/// <summary>
	/// 設定 API を初期化する
	/// </summary>
	/// <param name="appContext">アプリコンテキスト</param>
	/// <param name="onSettingsChanged">設定変更後のコールバック</param>
	public ConfigApi(AppContext appContext, Action onSettingsChanged)
	{
		_appContext       = appContext;
		_onSettingsChanged = onSettingsChanged;
	}

	/// <summary>
	/// 設定を取得する
	/// </summary>
	/// <returns>設定応答</returns>
	public ConfigGetResponse GetConfig()
	{
		return new ConfigGetResponse
		{
			Config      = _appContext.Config,
			DataDirInfo = _appContext.ConfigStore.GetDataDirInfo(),
		};
	}

	/// <summary>
	/// 設定を更新する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult Update(JsonElement paramsElement)
	{
		if (paramsElement.TryGetProperty("settings", out JsonElement settingsElement))
		{
			SaveConfigResult result = _appContext.ConfigStore.UpdateSettings(settingsElement);
			ApplySavedConfig(result);
			return result;
		}

		if (paramsElement.TryGetProperty("customDecorations", out JsonElement decorationsElement))
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

		if (paramsElement.TryGetProperty("window", out JsonElement windowElement))
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
	/// 設定項目をリセットする
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>保存結果</returns>
	public SaveConfigResult ResetItem(JsonElement paramsElement)
	{
		string itemKey = paramsElement.TryGetProperty("itemKey", out JsonElement keyElement)
			? keyElement.GetString() ?? string.Empty
			: string.Empty;

		SaveConfigResult result = _appContext.ConfigStore.ResetSettingItem(itemKey);
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// settings をすべてリセットする
	/// </summary>
	/// <returns>保存結果</returns>
	public SaveConfigResult ResetAll()
	{
		SaveConfigResult result = _appContext.ConfigStore.ResetAllSettings();
		ApplySavedConfig(result);
		return result;
	}

	/// <summary>
	/// dataDir を取得する
	/// </summary>
	/// <returns>dataDir 情報</returns>
	public DataDirInfo GetDataDir()
	{
		return _appContext.ConfigStore.GetDataDirInfo();
	}

	/// <summary>
	/// dataDir を変更する
	/// </summary>
	/// <param name="paramsElement">params</param>
	/// <returns>移行結果</returns>
	public MigrateDataDirResult ChangeDataDir(JsonElement paramsElement)
	{
		if (paramsElement.TryGetProperty("dataDir", out JsonElement dataDirElement))
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
	/// フォルダ選択ダイアログで dataDir を変更する
	/// </summary>
	/// <returns>移行結果</returns>
	public MigrateDataDirResult ChangeDataDirWithDialog()
	{
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
	/// 保存結果を AppContext へ反映する
	/// </summary>
	/// <param name="result">保存結果</param>
	private void ApplySavedConfig(SaveConfigResult result)
	{
		if (result.Success && result.Config is not null)
		{
			_appContext.Config = result.Config;
			_onSettingsChanged();
		}
	}
}
