; ==============================================
; TMS-MDEditorインストーラ生成（発行成果物の配置）
; ==============================================

; 64-bit の発行成果物を、ユーザー権限または管理者権限で配置する
; .md と .mdc の関連付けは、利用者がインストール時またはインストール後に任意で設定する（設定 > アプリ >既定のアプリ）
; 既存のユーザーデータディレクトリは削除しない

#define MyAppName "TMS-MDEditor"
#define MyAppExeName "TmsMdEditor.exe"
; MyAppVersion と MyPublishDir は ISCC の /D で渡す。scripts/dist.ps1 が Directory.Build.props の Version と発行先を渡す
; スクリプトには版も発行先も残さない。/D が無いコンパイルは失敗する

; アプリ識別子、出力ファイル名、64-bit、ユーザー権限でのインストールを決める

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

; ウィザードの言語。表示文言は Inno Setup の日本語メッセージを使う

[Languages]
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

; デスクトップショートカットと、.md / .mdc の既定アプリ化は、利用者が選んだときだけ行う

[Tasks]
Name: "desktopicon"; Description: "デスクトップショートカットを作成する"
Name: "associatemd"; Description: ".md ファイルの既定アプリを TMS-MDEditor に設定する"
Name: "associatemdc"; Description: ".mdc ファイルの既定アプリを TMS-MDEditor に設定する"

; 発行物をインストール先へコピーする。既存ファイルはバージョンに関係なく上書きする

[Files]
Source: "{#MyPublishDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

; スタートメニューは常に作る。デスクトップは desktopicon タスクが選ばれたときだけ作る

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

; 現在のユーザーだけに、拡張子とアプリケーション登録を書く
; uninsdeletekey と uninsdeletevalue は、アンインストール時にこのインストーラが書いた値だけを消す

[Registry]
; ----------------------------------------------
; .md の Open With
; ----------------------------------------------
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "TMS-MDEditor.md"; ValueData: ""; Flags: uninsdeletevalue

; ----------------------------------------------
; .mdc の Open With
; ----------------------------------------------
Root: HKCU; Subkey: "Software\Classes\.mdc\OpenWithProgids"; ValueType: string; ValueName: "TMS-MDEditor.mdc"; ValueData: ""; Flags: uninsdeletevalue

; ----------------------------------------------
; .md の ProgId
; ----------------------------------------------
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.md"; ValueType: string; ValueName: ""; ValueData: "Markdown ファイル"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.md\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.md\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

; ----------------------------------------------
; .mdc の ProgId
; ----------------------------------------------
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.mdc"; ValueType: string; ValueName: ""; ValueData: "Markdown Cursor ファイル"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.mdc\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\TMS-MDEditor.mdc\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

; ----------------------------------------------
; アプリケーション登録
; ----------------------------------------------
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".md"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\Applications\{#MyAppExeName}\SupportedTypes"; ValueType: string; ValueName: ".mdc"; ValueData: ""

; ----------------------------------------------
; 機能と登録済みアプリ
; ----------------------------------------------
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities"; ValueType: string; ValueName: "ApplicationName"; ValueData: "{#MyAppName}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities"; ValueType: string; ValueName: "ApplicationDescription"; ValueData: "Markdown ファイルを編集・プレビューする TMS-MDEditor"
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities"; ValueType: string; ValueName: "ApplicationIcon"; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".md"; ValueData: "TMS-MDEditor.md"
Root: HKCU; Subkey: "Software\TMSystems\TMS-MDEditor\Capabilities\FileAssociations"; ValueType: string; ValueName: ".mdc"; ValueData: "TMS-MDEditor.mdc"
Root: HKCU; Subkey: "Software\RegisteredApplications"; ValueType: string; ValueName: "{#MyAppName}"; ValueData: "Software\TMSystems\TMS-MDEditor\Capabilities"; Flags: uninsdeletevalue

; サイレントインストールのときは起動しない。通常完了時だけ、利用者が起動を選べる

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "TMS-MDEditor を起動する"; Flags: nowait postinstall skipifsilent

; データディレクトリの選択、関連付け、シェルへの変更通知を行う

[Code]
const
  // 関連付けの変更をエクスプローラへ通知するイベント ID
  SHCNE_ASSOCCHANGED = $08000000;
  // 通知対象を ID リストとして渡す指定。呼び出し側は 0 を渡し、関連付け全体を更新する
  SHCNF_IDLIST = $0000;

var
  // データ保存先を入力するウィザードページ。InitializeWizard で作り、NextButtonClick で読む
  DataDirPage: TInputDirWizardPage;

// ----------------------------------------------
// シェル通知
// ----------------------------------------------

{
  shell32 の SHChangeNotify を呼ぶ
  関連付けを書いたあと、エクスプローラへ変更を知らせる

  引数:
    wEventId は通知するイベント。関連付けでは SHCNE_ASSOCCHANGED を渡す
    uFlags は対象の渡し方。SHCNF_IDLIST を渡す
    dwItem1 と dwItem2 は対象の ID。関連付け全体の更新では 0 を渡す
}
procedure SHChangeNotify(wEventId, uFlags: Cardinal; dwItem1, dwItem2: Integer);
  external 'SHChangeNotify@shell32.dll stdcall';

// ----------------------------------------------
// 関連付けタスク
// ----------------------------------------------

{
  利用者が .md の関連付けタスクを選んでいるかを返す
  ウィザードのタスク選択より前に呼ぶと、常に False になる

  引数:
    なし

  戻り値:
    associatemd が選択されていれば True
}
function IsMdAssociationSelected: Boolean;
begin
  Result := WizardIsTaskSelected('associatemd');
end;

{
  利用者が .mdc の関連付けタスクを選んでいるかを返す
  ウィザードのタスク選択より前に呼ぶと、常に False になる

  引数:
    なし

  戻り値:
    associatemdc が選択されていれば True
}
function IsMdcAssociationSelected: Boolean;
begin
  Result := WizardIsTaskSelected('associatemdc');
end;

{
  .md または .mdc のどちらかの関連付けタスクが選ばれているかを返す

  引数:
    なし

  戻り値:
    どちらかが選択されていれば True
}
function IsAnyAssociationSelected: Boolean;
begin
  Result := IsMdAssociationSelected or IsMdcAssociationSelected;
end;

// ----------------------------------------------
// ユーザーの既定アプリ
// ----------------------------------------------

{
  Windows が保護している、利用者の既定アプリ選択があるかを返す
  UserChoice または UserChoiceLatest のどちらかのキーがあれば True

  引数:
    Extension はドット付きの拡張子。.md または .mdc

  戻り値:
    HKCU の FileExts に利用者の選択キーがあれば True
}
function IsUserChoicePresent(Extension: String): Boolean;
begin
  Result :=
    RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoice') or
    RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoiceLatest');
end;

{
  利用者が選んだ既定アプリの ProgId を読む
  UserChoice を先に読み、無ければ UserChoiceLatest を読む

  引数:
    Extension はドット付きの拡張子
    ProgId は読み取った ProgId。読めないときは変更しないことがある

  戻り値:
    どちらかのキーから ProgId を読めたとき True
}
function QueryUserChoiceProgId(Extension: String; var ProgId: String): Boolean;
begin
  Result :=
    RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoice', 'ProgId', ProgId) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\' + Extension + '\UserChoiceLatest', 'ProgId', ProgId);
end;

// ----------------------------------------------
// データ保存先
// ----------------------------------------------

{
  JSON 文字列リテラルに入れるため、制御文字と引用符をエスケープする
  起動設定は外部パーサを使わず、このインストーラ内で読み書きする

  引数:
    Value はエスケープ前の文字列。パスを想定する

  戻り値:
    バックスラッシュ、二重引用符、改行、タブをエスケープした文字列
}
function EscapeJsonString(Value: String): String;
var
  // 走査位置。1 始まり。空文字ならループに入らない
  I: Integer;
  // 今見ている 1 文字。制御文字と引用符だけをエスケープする
  Ch: String;
begin
  Result := '';
  for I := 1 to Length(Value) do begin
    Ch := Copy(Value, I, 1);
    // パス区切りを JSON のエスケープにする。生のままだと次の文字が制御扱いになる
    if Ch = '\' then
      Result := Result + '\\'
    // 値の二重引用符が文字列を閉じないようにする
    else if Ch = '"' then
      Result := Result + '\"'
    // 復帰を \r にする。生の改行は JSON 文字列に置けない
    else if Ch = #13 then
      Result := Result + '\r'
    // 改行を \n にする
    else if Ch = #10 then
      Result := Result + '\n'
    // タブを \t にする
    else if Ch = #9 then
      Result := Result + '\t'
    else
      Result := Result + Ch;
  end;
end;

{
  起動設定 app-config.json のパスを返す
  インストール後もこのファイルは残る。アンインストールでは削除しない

  引数:
    なし

  戻り値:
    ユーザーの AppData 直下の tms-mdeditor\app-config.json を展開したパス
}
function GetBootstrapConfigPath: String;
begin
  Result := ExpandConstant('{userappdata}\tms-mdeditor\app-config.json');
end;

{
  利用者が保存先を指定していないときのデータディレクトリを返す

  引数:
    なし

  戻り値:
    ユーザーの AppData 直下の tms-mdeditor\data を展開したパス
}
function GetDefaultDataDir: String;
begin
  Result := ExpandConstant('{userappdata}\tms-mdeditor\data');
end;

{
  JSON テキストから、指定した名前の文字列プロパティを 1 つ取り出す
  オブジェクトの入れ子や配列は解釈しない。最初に見つかった名前を読む

  引数:
    Json は起動設定ファイルの全文
    PropertyName はプロパティ名。引用符は付けない
    Value は読み取った文字列。見つからないときは空のまま

  戻り値:
    文字列値の終端引用符まで読めたとき True
}
function TryExtractJsonStringValue(Json, PropertyName: String; var Value: String): Boolean;
var
  // 探すプロパティ名。引用符付き
  Key: String;
  // 今見ている 1 文字。エスケープの次の文字もこれで見る
  Ch: String;
  // 走査位置。1 始まり。0 は名前が無い
  I: Integer;
  // 直前がバックスラッシュか。True のとき次の 1 文字を制御文字として読む
  Escaped: Boolean;
begin
  // 未発見の初期値。終端の引用符まで読めなければこのまま返す
  Result := False;
  // 読み取り前に空へ戻す。途中で抜けたとき前の値が残らない
  Value := '';
  Key := '"' + PropertyName + '"';
  // 名前の先頭位置。0 はファイルにその名前が無い
  I := Pos(Key, Json);
  // 名前が無いときは値を読まず空のまま返す
  if I = 0 then exit;

  I := I + Length(Key);
  while (I <= Length(Json)) and (Copy(Json, I, 1) <> ':') do
    I := I + 1;
  // 名前のあとコロンが無いときは、文字列値ではない
  if I > Length(Json) then exit;

  I := I + 1;
  while (I <= Length(Json)) and (Copy(Json, I, 1) <> '"') do
    I := I + 1;
  // 値の開始引用符が無いときは文字列プロパティではない
  if I > Length(Json) then exit;

  I := I + 1;
  // 値の開始引用符の次から読む。まだエスケープ中ではない
  Escaped := False;
  while I <= Length(Json) do begin
    Ch := Copy(Json, I, 1);
    // バックスラッシュの次の 1 文字を制御文字として足す
    if Escaped then begin
      // \r を復帰にする
      if Ch = 'r' then
        Value := Value + #13
      // \n を改行にする
      else if Ch = 'n' then
        Value := Value + #10
      // \t をタブにする
      else if Ch = 't' then
        Value := Value + #9
      else
        Value := Value + Ch;
      Escaped := False;
    // バックスラッシュは次の文字のエスケープ開始。文字自体はまだ足さない
    end else if Ch = '\' then begin
      Escaped := True;
    // 終端の引用符まで読めた。エスケープ中でなければここで成功
    end else if Ch = '"' then begin
      Result := True;
      exit;
    end else begin
      Value := Value + Ch;
    end;
    I := I + 1;
  end;
end;

{
  起動設定からデータ保存先を読む
  dataDir を先に探し、無ければ DataDir を探す

  引数:
    Json は起動設定ファイルの全文
    DataDir は読み取ったパス。見つからないときは空のまま

  戻り値:
    どちらかの名前で文字列を読めたとき True
}
function TryExtractDataDir(Json: String; var DataDir: String): Boolean;
begin
  Result := TryExtractJsonStringValue(Json, 'dataDir', DataDir);
  // 新しい名前が無いときだけ旧名を読む。両方空なら False のまま
  if not Result then
    Result := TryExtractJsonStringValue(Json, 'DataDir', DataDir);
end;

{
  既存の起動設定ファイルから、空でないデータ保存先を読む
  ファイルが無いときは False を返し、既定の保存先へフォールバックするのは呼び出し側

  引数:
    DataDir は読み取ったパス。読めないときは空

  戻り値:
    ファイルを読み、空でない保存先を取り出せたとき True
}
function TryGetConfiguredDataDir(var DataDir: String): Boolean;
var
  // ファイルから読んだ生のバイト列。ファイルが無いときは未使用
  BootstrapConfigContent: AnsiString;
  // JSON として解釈する文字列。読めなければ空のまま
  BootstrapConfig: String;
begin
  Result := False;
  DataDir := '';
  // 起動設定が無いときは既定へ落とす判断を呼び出し側に残す
  if LoadStringFromFile(GetBootstrapConfigPath, BootstrapConfigContent) then begin
    BootstrapConfig := BootstrapConfigContent;
    // 抽出と、空白以外の中身の両方が揃ったときだけ成功。一方だけでは False
    Result := TryExtractDataDir(BootstrapConfig, DataDir) and (Trim(DataDir) <> '');
  end;
end;

{
  ウィザードに最初に表示するデータ保存先を返す
  既存の設定が無ければ既定の保存先を返す

  引数:
    なし

  戻り値:
    表示するディレクトリパス
}
function GetInitialDataDir: String;
begin
  // 既存設定が読めないときは既定の保存先を表示する
  if not TryGetConfiguredDataDir(Result) then
    Result := GetDefaultDataDir;
end;

{
  ディレクトリパスの前後空白を除き、ルート以外の末尾区切りを外す

  引数:
    Value は利用者が入力した、または設定ファイルから読んだパス

  戻り値:
    比較と保存に使うパス
}
function NormalizeDir(Value: String): String;
begin
  Result := RemoveBackslashUnlessRoot(Trim(Value));
end;

{
  2 つのディレクトリが、正規化のあと大文字小文字を無視して同じかを返す

  引数:
    Left と Right は比較するパス。正規化前でよい

  戻り値:
    同じディレクトリなら True
}
function IsSameDir(Left, Right: String): Boolean;
begin
  Result := CompareText(NormalizeDir(Left), NormalizeDir(Right)) = 0;
end;

{
  起動設定を app-config.json へ上書き保存する
  保存先が変わるときは、旧ディレクトリを pendingMigrationSourceDir に残す
  既存の利用者データディレクトリは削除しない

  引数:
    DataDir は新しいデータ保存先。保存前に正規化する
    PendingMigrationSourceDir は移行元。空のときはプロパティを書かない

  戻り値:
    ファイルを書き込めたとき True

  例外:
    失敗してもウィザードは止めない。False を返し、呼び出し側がメッセージを出す
}
function SaveBootstrapConfig(DataDir, PendingMigrationSourceDir: String): Boolean;
var
  // 書き込む app-config.json。ユーザーの AppData 配下
  BootstrapConfigPath: String;
  // 組み立て中の JSON。移行元が空ならそのプロパティは書かない
  BootstrapConfig: String;
begin
  BootstrapConfigPath := GetBootstrapConfigPath;
  ForceDirectories(ExtractFileDir(BootstrapConfigPath));
  BootstrapConfig := '{"schemaVersion":1,"dataDir":"' + EscapeJsonString(NormalizeDir(DataDir)) + '"';
  // 移行元があるときだけプロパティを足す。空なら保存先だけの JSON にする
  if Trim(PendingMigrationSourceDir) <> '' then
    BootstrapConfig := BootstrapConfig + ',"pendingMigrationSourceDir":"' + EscapeJsonString(NormalizeDir(PendingMigrationSourceDir)) + '"';
  BootstrapConfig := BootstrapConfig + '}' + #13#10;
  Result := SaveStringToFile(BootstrapConfigPath, BootstrapConfig, False);
end;

{
  データ保存先ディレクトリを作成し、作成できたかを返す
  中身のファイルは消さない

  引数:
    DirectoryPath は作成を試みるディレクトリ

  戻り値:
    ディレクトリが存在するとき True
}
function VerifyWritableDirectory(DirectoryPath: String): Boolean;
begin
  ForceDirectories(DirectoryPath);
  Result := DirExists(DirectoryPath);
end;

// ----------------------------------------------
// ウィザード
// ----------------------------------------------

{
  インストール先の選択のあとに、データ保存先ページを追加する
  初期値は既存の起動設定、無ければ既定の保存先

  引数:
    なし
}
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

{
  データ保存先ページの次へ進むとき、起動設定を保存する
  保存先が変わっていて旧設定があるときは、旧パスを移行元として残す
  利用者データそのものは移動しない

  引数:
    CurPageID は今閉じようとしているウィザードページ。データ保存先以外では何もしない

  戻り値:
    次へ進んでよいとき True。保存またはフォルダ作成に失敗したとき False

  例外:
    失敗時はメッセージを出して False を返し、このページに留める
}
function NextButtonClick(CurPageID: Integer): Boolean;
var
  // 利用者が入力した保存先。空のときはこのページに留まる
  NewDataDir: String;
  // 変更前の保存先。設定が無いときは既定パス
  OldDataDir: String;
  // 起動設定から保存先を読めたか。False なら移行元は書かない
  HasConfiguredDataDir: Boolean;
begin
  // このページ以外では次へ進む。データ保存先の検証はしない
  Result := True;
  // データ保存先ページ以外では設定を書かない
  if CurPageID <> DataDirPage.ID then exit;

  // 前後空白と末尾区切りを除いた保存先。空なら保存しない
  NewDataDir := NormalizeDir(DataDirPage.Values[0]);
  // 空の入力では既定へ戻さず、このページに留まる
  if NewDataDir = '' then exit;

  // 既存の起動設定が読めれば True。ファイルが無いときは False
  HasConfiguredDataDir := TryGetConfiguredDataDir(OldDataDir);
  // 設定ファイルが無いときは比較用の旧パスを既定にする。利用者データは移動しない
  if not HasConfiguredDataDir then
    OldDataDir := GetDefaultDataDir;

  // 保存先が変わっていないときは移行元を書かない
  if IsSameDir(OldDataDir, NewDataDir) then begin
    // 設定ファイルを書けないときは権限不足としてこのページに留める
    if not SaveBootstrapConfig(NewDataDir, '') then begin
      MsgBox('データ保存先の設定ファイルを保存できませんでした。保存先の書き込み権限を確認してください。', mbError, MB_OK);
      Result := False;
    end;
    exit;
  end;

  // 新しいフォルダを用意できないときは移行情報を書かず、このページに留める
  if not VerifyWritableDirectory(NewDataDir) then begin
    MsgBox('データ保存先フォルダへ書き込めません。保存先の書き込み権限を確認してください。' + #13#10 + NewDataDir, mbError, MB_OK);
    Result := False;
    exit;
  end;

  // 旧設定があるときだけ移行元を残す。利用者データそのものは移動しない
  if HasConfiguredDataDir then begin
    // 移行元付きの設定を書けないときは、このページに留める
    if not SaveBootstrapConfig(NewDataDir, OldDataDir) then begin
      MsgBox('初回データ保存先の設定ファイルを作成できませんでした。保存先の書き込み権限を確認してください。', mbError, MB_OK);
      Result := False;
    end;
    exit;
  end;

  // 初回の設定を書けないときは、このページに留める
  if not SaveBootstrapConfig(NewDataDir, '') then begin
    MsgBox('初回データ保存先の設定ファイルを作成できませんでした。保存先の書き込み権限を確認してください。', mbError, MB_OK);
    Result := False;
  end;
end;

// ----------------------------------------------
// 関連付けの適用と解除
// ----------------------------------------------

{
  拡張子の従来の既定が、このアプリの ProgId のときだけその値を消す
  別のアプリの既定は残す。UserChoice は変更しない

  引数:
    Extension はドット付きの拡張子
    ProgId は、このインストーラが所有しているときだけ消す ProgId
}
procedure RemoveAssociationIfOwned(Extension, ProgId: String);
var
  // 拡張子の現在の既定 ProgId。読めなければ削除しない
  CurrentValue: String;
begin
  // このアプリの ProgId のときだけ消す。別アプリの既定や、値が読めないときは残す。一方だけでは消さない
  if RegQueryStringValue(HKCU, 'Software\Classes\' + Extension, '', CurrentValue) and (CompareText(CurrentValue, ProgId) = 0) then
    RegDeleteValue(HKCU, 'Software\Classes\' + Extension, '');
end;

{
  利用者の既定が無いときだけ、従来の既定 ProgId を書く
  UserChoice がある、または別の ProgId があるときは何も書かず、設定アプリが必要だと返す

  引数:
    Extension はドット付きの拡張子
    ProgId は書き込む ProgId。TMS-MDEditor.md または TMS-MDEditor.mdc
    Applied は、この呼び出しで ProgId を書けたとき True
    NeedsSettings は、Windows の設定で利用者が選ぶ必要があるとき True

  例外:
    レジストリへ書けなくてもウィザードは止めない。NeedsSettings を True にする
}
procedure SetLegacyAssociationIfUnassigned(Extension, ProgId: String; var Applied, NeedsSettings: Boolean);
var
  // 従来の既定 ProgId。空なら未設定
  CurrentValue: String;
  // 利用者が選んだ ProgId。UserChoice が無いときは空のまま
  UserChoiceProgId: String;
begin
  // まだ書いていない。下の分岐で書けたときだけ True
  Applied := False;
  // 設定アプリが不要な初期値。保護された既定や別アプリがあるときに True
  NeedsSettings := False;

  // 利用者の既定があるときは従来の ProgId を上書きしない
  if IsUserChoicePresent(Extension) then begin
    // 既にこのアプリが選ばれているときは、設定アプリも開かない。読めないときは下で案内する
    if QueryUserChoiceProgId(Extension, UserChoiceProgId) and (CompareText(UserChoiceProgId, ProgId) = 0) then
      exit;
    // 別のアプリが選ばれている。ProgId は書けないので設定アプリが必要
    NeedsSettings := True;
    exit;
  end;

  // 従来の既定があるときだけ中身を見る。キーが無いときは下で書く
  if RegQueryStringValue(HKCU, 'Software\Classes\' + Extension, '', CurrentValue) then begin
    // 既にこのアプリなら書き直さない
    if CompareText(CurrentValue, ProgId) = 0 then
      exit;
    // 空白以外の別 ProgId があるときは上書きせず、設定アプリへ回す
    if Trim(CurrentValue) <> '' then begin
      NeedsSettings := True;
      exit;
    end;
  end;

  // 未設定のときだけ書く。書けないときは設定アプリが必要
  if RegWriteStringValue(HKCU, 'Software\Classes\' + Extension, '', ProgId) then
    Applied := True
  else
    NeedsSettings := True;
end;

{
  設定アプリで選んでもらう拡張子の表示文を作る

  引数:
    MdNeedsSettings は .md を設定画面で選ぶ必要があるとき True
    MdcNeedsSettings は .mdc を設定画面で選ぶ必要があるとき True

  戻り値:
    両方なら .md と .mdc、片方ならその拡張子、不要なら空文字
}
function BuildAssociationTargetText(MdNeedsSettings, MdcNeedsSettings: Boolean): String;
begin
  // 両方とも設定アプリが必要なときだけ、二つの拡張子を並べる。一方だけでは入らない
  if MdNeedsSettings and MdcNeedsSettings then
    Result := '.md と .mdc'
  // .md だけ設定が必要
  else if MdNeedsSettings then
    Result := '.md'
  // .mdc だけ設定が必要
  else if MdcNeedsSettings then
    Result := '.mdc'
  else
    Result := '';
end;

{
  アンインストール完了後に、このアプリが所有する従来の既定だけを外す
  外したあとにシェルへ関連付けの変更を通知する
  起動設定と利用者データは削除しない

  引数:
    CurUninstallStep はアンインストールの段階。usPostUninstall 以外では何もしない
}
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  // アンインストール完了後だけ関連付けを外す。途中の段階ではレジストリを触らない
  if CurUninstallStep <> usPostUninstall then exit;
  RemoveAssociationIfOwned('.md', 'TMS-MDEditor.md');
  RemoveAssociationIfOwned('.mdc', 'TMS-MDEditor.mdc');
  SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, 0, 0);
end;

{
  インストール完了後に、選ばれた拡張子の従来の既定を書き、シェルへ通知する
  既に別の既定があるときは設定アプリを開く。サイレント時はメッセージも設定アプリも出さない

  引数:
    CurStep はインストールの段階。ssPostInstall 以外では何もしない
}
procedure CurStepChanged(CurStep: TSetupStep);
var
  // 設定アプリを開けなかったときのコード。メッセージは出さない
  ErrorCode: Integer;
  // .md の従来の既定を書けたか。手続きが False のまま返すことがある
  LegacyMdApplied: Boolean;
  // .mdc の従来の既定を書けたか。手続きが False のまま返すことがある
  LegacyMdcApplied: Boolean;
  // .md を設定アプリで選ぶ必要があるか。初期値は False
  MdNeedsSettings: Boolean;
  // .mdc を設定アプリで選ぶ必要があるか。初期値は False
  MdcNeedsSettings: Boolean;
  // 設定アプリに案内する拡張子の文。不要なときは空
  SettingsTargetText: String;
begin
  // インストール完了後だけ関連付けを書く。それ以前の段階では何もしない
  if CurStep = ssPostInstall then begin
    // 関連付けタスクが一つも選ばれていないときは、レジストリを書かず通知だけする
    if IsAnyAssociationSelected then begin
      // Windows 8 以降は、利用者が選んだ既定を保護する。UserChoice が無いときだけ、従来の既定を書く
      MdNeedsSettings := False;
      MdcNeedsSettings := False;
      // .md タスクが選ばれたときだけ従来の既定を試す
      if IsMdAssociationSelected then
        SetLegacyAssociationIfUnassigned('.md', 'TMS-MDEditor.md', LegacyMdApplied, MdNeedsSettings);
      // .mdc タスクが選ばれたときだけ従来の既定を試す
      if IsMdcAssociationSelected then
        SetLegacyAssociationIfUnassigned('.mdc', 'TMS-MDEditor.mdc', LegacyMdcApplied, MdcNeedsSettings);
      SettingsTargetText := BuildAssociationTargetText(MdNeedsSettings, MdcNeedsSettings);
      // 案内する拡張子があり、かつサイレントでないときだけ設定アプリを開く。一方だけでは開かない
      if (SettingsTargetText <> '') and (not WizardSilent) then begin
        MsgBox(
          '既に別のアプリが既定として選択されている可能性があります。' + #13#10 + #13#10 +
          '続けて表示される「既定のアプリ」画面で、' + SettingsTargetText + ' に TMS-MDEditor を選択してください。',
          mbInformation,
          MB_OK);
        // 登録アプリへのディープリンクを開けないときだけ、既定のアプリの一覧を開く
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
