#define MyAppName "TMS-MDEditor"
#define MyAppExeName "TmsMdEditor.exe"
#ifndef MyAppVersion
  #define MyAppVersion "1.3.2"
#endif
#ifndef MyPublishDir
  #define MyPublishDir "..\\dist\\publish\\win-x64"
#endif

[Setup]
AppId={{B31D3D0B-72A8-4E20-B0F2-91381835752F}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=TMSystems
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=TMS-MDEditor-{#MyAppVersion}-setup
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
ChangesAssociations=yes
UsePreviousTasks=no

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[Tasks]
Name: "desktopicon"; Description: "デスクトップショートカットを作成する"
Name: "associatemd"; Description: ".md ファイルの既定アプリを TMS-MDEditor に設定する"
Name: "associatemdc"; Description: ".mdc ファイルの既定アプリを TMS-MDEditor に設定する"

[Files]
Source: "{#MyPublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "TMS-MDEditor.md"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.mdc\OpenWithProgids"; ValueType: string; ValueName: "TMS-MDEditor.mdc"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.md"; ValueType: string; ValueName: ""; ValueData: "Markdown ファイル"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.md\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.md\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.mdc"; ValueType: string; ValueName: ""; ValueData: "Markdown Cursor ファイル"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.mdc\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.mdc\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".mdc"; ValueData: ""
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Markdown ファイルを編集・プレビューする TMS-MDEditor"
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".md"; ValueData: "TMS-MDEditor.md"
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mdc"; ValueData: "TMS-MDEditor.mdc"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: "Software\TMSystems\TMS-MDEditor\Capabilities"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "TMS-MDEditor を起動する"; Flags: nowait postinstall skipifsilent

[Code]
const
  SHCNE_ASSOCCHANGED = $08000000;
  SHCNF_IDLIST = $0000;

var
  DataDirPage: TInputDirWizardPage;

procedure SHChangeNotify(wEventId, uFlags: Cardinal; dwItem1, dwItem2: Integer);
  external 'SHChangeNotify@shell32.dll stdcall';

function IsMdAssociationSelected: Boolean;
begin
  Result := WizardIsTaskSelected('associatemd');
end;

function IsMdcAssociationSelected: Boolean;
begin
  Result := WizardIsTaskSelected('associatemdc');
end;

function IsAnyAssociationSelected: Boolean;
begin
  Result := IsMdAssociationSelected or IsMdcAssociationSelected;
end;

function IsUserChoicePresent(Extension: String): Boolean;
begin
  Result :=
    RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoice') or
    RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoiceLatest');
end;

function QueryUserChoiceProgId(Extension: String; var ProgId: String): Boolean;
begin
  Result :=
    RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoice', 'ProgId', ProgId) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoiceLatest', 'ProgId', ProgId);
end;

function EscapeJsonString(Value: String): String;
var
  I: Integer;
  Ch: String;
begin
  Result := '';
  for I := 1 to Length(Value) do begin
    Ch := Copy(Value, I, 1);
    if Ch = '\' then
      Result := Result + '\\'
    else if Ch = '"' then
      Result := Result + '\"'
    else if Ch = #13 then
      Result := Result + '\r'
    else if Ch = #10 then
      Result := Result + '\n'
    else if Ch = #9 then
      Result := Result + '\t'
    else
      Result := Result + Ch;
  end;
end;

function GetBootstrapConfigPath: String;
begin
  Result := ExpandConstant('{userappdata}\tms-mdeditor\app-config.json');
end;

function GetDefaultDataDir: String;
begin
  Result := ExpandConstant('{userappdata}\tms-mdeditor\data');
end;

function TryExtractJsonStringValue(Json, PropertyName: String; var Value: String): Boolean;
var
  Key: String;
  Ch: String;
  I: Integer;
  Escaped: Boolean;
begin
  Result := False;
  Value := '';
  Key := '"' + PropertyName + '"';
  I := Pos(Key, Json);
  if I = 0 then exit;

  I := I + Length(Key);
  while (I <= Length(Json)) and (Copy(Json, I, 1) <> ':') do
    I := I + 1;
  if I > Length(Json) then exit;

  I := I + 1;
  while (I <= Length(Json)) and (Copy(Json, I, 1) <> '"') do
    I := I + 1;
  if I > Length(Json) then exit;

  I := I + 1;
  Escaped := False;
  while I <= Length(Json) do begin
    Ch := Copy(Json, I, 1);
    if Escaped then begin
      if Ch = 'r' then
        Value := Value + #13
      else if Ch = 'n' then
        Value := Value + #10
      else if Ch = 't' then
        Value := Value + #9
      else
        Value := Value + Ch;
      Escaped := False;
    end else if Ch = '\' then begin
      Escaped := True;
    end else if Ch = '"' then begin
      Result := True;
      exit;
    end else begin
      Value := Value + Ch;
    end;
    I := I + 1;
  end;
end;

function TryExtractDataDir(Json: String; var DataDir: String): Boolean;
begin
  Result := TryExtractJsonStringValue(Json, 'dataDir', DataDir);
  if not Result then
    Result := TryExtractJsonStringValue(Json, 'DataDir', DataDir);
end;

function TryGetConfiguredDataDir(var DataDir: String): Boolean;
var
  BootstrapConfigContent: AnsiString;
  BootstrapConfig: String;
begin
  Result := False;
  DataDir := '';
  if LoadStringFromFile(GetBootstrapConfigPath, BootstrapConfigContent) then begin
    BootstrapConfig := BootstrapConfigContent;
    Result := TryExtractDataDir(BootstrapConfig, DataDir) and (Trim(DataDir) <> '');
  end;
end;

function GetInitialDataDir: String;
begin
  if not TryGetConfiguredDataDir(Result) then
    Result := GetDefaultDataDir;
end;

function NormalizeDir(Value: String): String;
begin
  Result := RemoveBackslashUnlessRoot(Trim(Value));
end;

function IsSameDir(Left, Right: String): Boolean;
begin
  Result := CompareText(NormalizeDir(Left), NormalizeDir(Right)) = 0;
end;

function SaveBootstrapConfig(DataDir, PendingMigrationSourceDir: String): Boolean;
var
  BootstrapConfigPath: String;
  BootstrapConfig: String;
begin
  BootstrapConfigPath := GetBootstrapConfigPath;
  ForceDirectories(ExtractFileDir(BootstrapConfigPath));
  BootstrapConfig := '{"schemaVersion":1,"dataDir":"' + EscapeJsonString(NormalizeDir(DataDir)) + '"';
  if Trim(PendingMigrationSourceDir) <> '' then
    BootstrapConfig := BootstrapConfig + ',"pendingMigrationSourceDir":"' + EscapeJsonString(NormalizeDir(PendingMigrationSourceDir)) + '"';
  BootstrapConfig := BootstrapConfig + '}' + #13#10;
  Result := SaveStringToFile(BootstrapConfigPath, BootstrapConfig, False);
end;

function VerifyWritableDirectory(DirectoryPath: String): Boolean;
begin
  ForceDirectories(DirectoryPath);
  Result := DirExists(DirectoryPath);
end;

procedure InitializeWizard;
begin
  DataDirPage := CreateInputDirPage(wpSelectDir,
    'データ保存先の指定',
    'データ保存先を必要に応じて変更してください。',
    '既存の設定がある場合は現在の保存先を表示します。変更すると更新後の保存先も変更します。',
    False, '');
  DataDirPage.Add('データ保存先:');
  DataDirPage.Values[0] := GetInitialDataDir;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  NewDataDir: String;
  OldDataDir: String;
  HasConfiguredDataDir: Boolean;
begin
  Result := True;
  if CurPageID <> DataDirPage.ID then exit;

  NewDataDir := NormalizeDir(DataDirPage.Values[0]);
  if NewDataDir = '' then exit;

  HasConfiguredDataDir := TryGetConfiguredDataDir(OldDataDir);
  if not HasConfiguredDataDir then
    OldDataDir := GetDefaultDataDir;

  if IsSameDir(OldDataDir, NewDataDir) then begin
    if not SaveBootstrapConfig(NewDataDir, '') then begin
      MsgBox('データ保存先の設定ファイルを保存できませんでした。保存先の書き込み権限を確認してください。', mbError, MB_OK);
      Result := False;
    end;
    exit;
  end;

  if not VerifyWritableDirectory(NewDataDir) then begin
    MsgBox('データ保存先フォルダへ書き込めません。保存先の書き込み権限を確認してください。' + #13#10 + NewDataDir, mbError, MB_OK);
    Result := False;
    exit;
  end;

  if HasConfiguredDataDir then begin
    if not SaveBootstrapConfig(NewDataDir, OldDataDir) then begin
      MsgBox('初回データ保存先の設定ファイルを作成できませんでした。保存先の書き込み権限を確認してください。', mbError, MB_OK);
      Result := False;
    end;
    exit;
  end;

  if not SaveBootstrapConfig(NewDataDir, '') then begin
    MsgBox('初回データ保存先の設定ファイルを作成できませんでした。保存先の書き込み権限を確認してください。', mbError, MB_OK);
    Result := False;
  end;
end;

procedure RemoveAssociationIfOwned(Extension, ProgId: String);
var
  CurrentValue: String;
begin
  if RegQueryStringValue(HKCU, 'Software\Classes\' + Extension, '', CurrentValue) and (CompareText(CurrentValue, ProgId) = 0) then
    RegDeleteValue(HKCU, 'Software\Classes\' + Extension, '');
end;

procedure SetLegacyAssociationIfUnassigned(Extension, ProgId: String; var Applied, NeedsSettings: Boolean);
var
  CurrentValue: String;
  UserChoiceProgId: String;
begin
  Applied := False;
  NeedsSettings := False;

  if IsUserChoicePresent(Extension) then begin
    if QueryUserChoiceProgId(Extension, UserChoiceProgId) and (CompareText(UserChoiceProgId, ProgId) = 0) then
      exit;
    NeedsSettings := True;
    exit;
  end;

  if RegQueryStringValue(HKCU, 'Software\Classes\' + Extension, '', CurrentValue) then begin
    if CompareText(CurrentValue, ProgId) = 0 then
      exit;
    if Trim(CurrentValue) <> '' then begin
      NeedsSettings := True;
      exit;
    end;
  end;

  if RegWriteStringValue(HKCU, 'Software\Classes\' + Extension, '', ProgId) then
    Applied := True
  else
    NeedsSettings := True;
end;

function BuildAssociationTargetText(MdNeedsSettings, MdcNeedsSettings: Boolean): String;
begin
  if MdNeedsSettings and MdcNeedsSettings then
    Result := '.md と .mdc'
  else if MdNeedsSettings then
    Result := '.md'
  else if MdcNeedsSettings then
    Result := '.mdc'
  else
    Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usPostUninstall then exit;
  RemoveAssociationIfOwned('.md', 'TMS-MDEditor.md');
  RemoveAssociationIfOwned('.mdc', 'TMS-MDEditor.mdc');
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ErrorCode: Integer;
  LegacyMdApplied: Boolean;
  LegacyMdcApplied: Boolean;
  MdNeedsSettings: Boolean;
  MdcNeedsSettings: Boolean;
  SettingsTargetText: String;
begin
  if CurStep = ssPostInstall then begin
    if IsAnyAssociationSelected then begin
      { This legacy default is best-effort. Windows 8 and later protect an
        explicit user default, so write it only when no user choice is present. }
      MdNeedsSettings := False;
      MdcNeedsSettings := False;
      if IsMdAssociationSelected then
        SetLegacyAssociationIfUnassigned('.md', 'TMS-MDEditor.md', LegacyMdApplied, MdNeedsSettings);
      if IsMdcAssociationSelected then
        SetLegacyAssociationIfUnassigned('.mdc', 'TMS-MDEditor.mdc', LegacyMdcApplied, MdcNeedsSettings);
      SettingsTargetText := BuildAssociationTargetText(MdNeedsSettings, MdcNeedsSettings);
      if (SettingsTargetText <> '') and (not WizardSilent) then begin
        MsgBox(
          '既に別のアプリが既定として選択されている可能性があります。' + #13#10 + #13#10 +
          '続けて表示される「既定のアプリ」画面で、' + SettingsTargetText + ' に TMS-MDEditor を選択してください。',
          mbInformation,
          MB_OK);
        if not ShellExec(
          '',
          'ms-settings:defaultapps?registeredAppUser=TMS-MDEditor',
          '',
          '',
          SW_SHOWNORMAL,
          ewNoWait,
          ErrorCode) then
          ShellExec('', 'ms-settings:defaultapps', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
      end;
    end;
    SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0);
  end;
end;
