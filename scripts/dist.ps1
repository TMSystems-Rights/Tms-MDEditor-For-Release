<#
.SYNOPSIS
    Release 用のインストーラとポータブル ZIP を生成する

.DESCRIPTION
    Web と本体を Release でビルドし、自己完結の win-x64 を発行する
    Inno Setup でインストーラを作り、ポータブル ZIP と SHA-256 を dist へ出す
    発行先、ステージ先、起動用発行先が既に存在する場合は throw し、既存の配布成果物は削除しない

.PARAMETER PublishDir
    本体の発行先。未指定または空文字のときは dist\publish-<version>\win-x64

.PARAMETER StageDir
    ポータブル ZIP 用のステージ先。未指定または空文字のときは dist\zip-stage-<version>

.PARAMETER LauncherPublishDir
    ポータブル起動用 exe の発行先。未指定または空文字のときは dist\publish-portable-launcher-<version>\win-x64

.OUTPUTS
    なし。インストーラ、ポータブル ZIP、SHA-256 を dist へファイルとして書く

.EXAMPLE
    pwsh -NoProfile -File scripts/dist.ps1

.NOTES
    例外:
    - Directory.Build.props から Version を読めない場合は throw する
    - 発行先、ステージ先、起動用発行先が既に存在する場合は throw し、既存ファイルは削除しない
    - Inno Setup 6 の ISCC.exe が無い場合は throw する
    - 子スクリプトや dotnet publish が失敗した場合は、その終了コードで終了する
#>
param(
	[string]$PublishDir = '',
	[string]$StageDir = '',
	[string]$LauncherPublishDir = ''
)

# コマンドレットの失敗を停止例外にする。子スクリプトの終了コードは別途見る
$ErrorActionPreference = 'Stop'
# このスクリプトの親。発行、インストーラ、版の基準
$repoRoot    = (Resolve-Path "$PSScriptRoot\..").Path
# 自己完結で発行する本体の csproj
$projectPath = Join-Path $repoRoot 'src\TmsMdEditor\TmsMdEditor.csproj'
# Inno Setup へ渡すスクリプト
$setupScript = Join-Path $repoRoot 'installer\setup.iss'
# Version を読む props。ファイルは変更しない
$propsPath   = Join-Path $repoRoot 'Directory.Build.props'

# Version を含む XML
[xml]$props = Get-Content -LiteralPath $propsPath
# インストーラ名と発行先に使う版。空白だけなら下で止める
$version = $props.Project.PropertyGroup.Version
# 版が空だと成果物名が決まらないので、ここで止める
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Directory.Build.props から Version を取得できません。' }

# ----------------------------------------------
# パスの解決
# ----------------------------------------------

# 発行先の指定が空のときだけ、版付きの既定パスにする。指定済みは上書きしない
if ([string]::IsNullOrWhiteSpace($PublishDir)) {
	$PublishDir = Join-Path $repoRoot "dist\publish-$version\win-x64"
}

# ステージ先が空のときだけ、版付きの既定にする
if ([string]::IsNullOrWhiteSpace($StageDir)) {
	$StageDir = Join-Path $repoRoot "dist\zip-stage-$version"
}

# 起動用の発行先が空のときだけ、版付きの既定にする
if ([string]::IsNullOrWhiteSpace($LauncherPublishDir)) {
	$LauncherPublishDir = Join-Path $repoRoot "dist\publish-portable-launcher-$version\win-x64"
}

# 発行先のフルパス。相対のまま存在確認しない
$publishPath = [System.IO.Path]::GetFullPath($PublishDir)

# ----------------------------------------------
# 既存成果物の確認
# ----------------------------------------------

# 発行先が既にあるときは消さず止める。別の -PublishDir で再実行する
if (Test-Path -LiteralPath $publishPath) {
	throw "発行先が既に存在します: $publishPath`n既存の配布成果物を保護するため、自動削除は行いません。別の -PublishDir を指定してください。"
}

# ステージ先のフルパス
$stagePath = [System.IO.Path]::GetFullPath($StageDir)
# 起動用発行先のフルパス
$launcherPublishPath = [System.IO.Path]::GetFullPath($LauncherPublishDir)
# ステージ先が既にあるときは消さず止める
if (Test-Path -LiteralPath $stagePath) {
	throw "ステージ先が既に存在します: $stagePath`n既存の配布成果物を保護するため、自動削除は行いません。別の -StageDir を指定してください。"
}

# 起動用発行先が既にあるときは消さず止める
if (Test-Path -LiteralPath $launcherPublishPath) {
	throw "起動用発行先が既に存在します: $launcherPublishPath`n既存の配布成果物を保護するため、自動削除は行いません。別の -LauncherPublishDir を指定してください。"
}

# ----------------------------------------------
# ISCC の検索
# ----------------------------------------------

# ISCC の候補。PATH を先にし、その後にインストール先を足す
$isccRoots = @(
	(Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
)
foreach ($isccRoot in @(
		(Get-Item -LiteralPath Env:ProgramFiles -ErrorAction SilentlyContinue)?.Value,
		(Get-Item -LiteralPath 'Env:ProgramFiles(x86)' -ErrorAction SilentlyContinue)?.Value,
		(Get-Item -LiteralPath Env:LOCALAPPDATA -ErrorAction SilentlyContinue)?.Value
	)) {
	# 環境変数が空のルートは候補に足さない
	if ([string]::IsNullOrWhiteSpace($isccRoot)) {
		continue
	}

	# Program Files 直下の Inno Setup 6
	$isccRoots += Join-Path $isccRoot 'Inno Setup 6\ISCC.exe'
	# ユーザーインストール（LocalAppData\Programs）の Inno Setup 6
	$isccRoots += Join-Path $isccRoot 'Programs\Inno Setup 6\ISCC.exe'
}

# 実在する ISCC。0 件ならコンパイルできない
$isccCandidates = @($isccRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
# 候補が無いときはインストーラを作らず止める
if ($isccCandidates.Count -eq 0) { throw 'Inno Setup 6 の ISCC.exe が見つかりません。Inno Setup 6 をインストールするか PATH を設定してください。' }

Push-Location $repoRoot
try {
	# ----------------------------------------------
	# ビルドと発行
	# ----------------------------------------------

	& pwsh (Join-Path $repoRoot 'scripts\build-all.ps1') -Configuration Release
	# Web または本体のビルドに失敗したら発行へ進まない
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& pwsh (Join-Path $repoRoot 'scripts\build-icon.ps1')
	# アイコン生成に失敗したら発行へ進まない
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& dotnet publish $projectPath -c Release -r win-x64 --self-contained true -p:PublishReadyToRun=true -p:DebugType=None -p:DebugSymbols=false -o $publishPath
	# 自己完結の発行に失敗したらインストーラを作らない
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& $isccCandidates[0] "/DMyAppVersion=$version" "/DMyPublishDir=$publishPath" $setupScript
	# インストーラのコンパイルに失敗したら ZIP を作らない
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& pwsh (Join-Path $repoRoot 'scripts\package-portable.ps1') -Version $version -PublishDir $publishPath -StageDir $stagePath -LauncherPublishDir $launcherPublishPath -OutputDir (Join-Path $repoRoot 'dist')
	# ポータブル ZIP に失敗したら、その終了コードで終わる
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
	Pop-Location
}
