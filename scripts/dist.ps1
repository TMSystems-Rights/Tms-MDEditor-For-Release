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

$ErrorActionPreference = 'Stop'
$repoRoot    = (Resolve-Path "$PSScriptRoot\..").Path
$projectPath = Join-Path $repoRoot 'src\TmsMdEditor\TmsMdEditor.csproj'
$setupScript = Join-Path $repoRoot 'installer\setup.iss'
$propsPath   = Join-Path $repoRoot 'Directory.Build.props'

[xml]$props = Get-Content -LiteralPath $propsPath
$version = $props.Project.PropertyGroup.Version
if ([string]::IsNullOrWhiteSpace($version)) { throw 'Directory.Build.props から Version を取得できません。' }

# ----------------------------------------------
# パスの解決
# ----------------------------------------------

if ([string]::IsNullOrWhiteSpace($PublishDir)) {
	$PublishDir = Join-Path $repoRoot "dist\publish-$version\win-x64"
}

if ([string]::IsNullOrWhiteSpace($StageDir)) {
	$StageDir = Join-Path $repoRoot "dist\zip-stage-$version"
}

if ([string]::IsNullOrWhiteSpace($LauncherPublishDir)) {
	$LauncherPublishDir = Join-Path $repoRoot "dist\publish-portable-launcher-$version\win-x64"
}

$publishPath = [System.IO.Path]::GetFullPath($PublishDir)

# ----------------------------------------------
# 既存成果物の確認
# ----------------------------------------------

if (Test-Path -LiteralPath $publishPath) {
	throw "発行先が既に存在します: $publishPath`n既存の配布成果物を保護するため、自動削除は行いません。別の -PublishDir を指定してください。"
}

$stagePath = [System.IO.Path]::GetFullPath($StageDir)
$launcherPublishPath = [System.IO.Path]::GetFullPath($LauncherPublishDir)
if (Test-Path -LiteralPath $stagePath) {
	throw "ステージ先が既に存在します: $stagePath`n既存の配布成果物を保護するため、自動削除は行いません。別の -StageDir を指定してください。"
}

if (Test-Path -LiteralPath $launcherPublishPath) {
	throw "起動用発行先が既に存在します: $launcherPublishPath`n既存の配布成果物を保護するため、自動削除は行いません。別の -LauncherPublishDir を指定してください。"
}

# ----------------------------------------------
# ISCC の検索
# ----------------------------------------------

$isccRoots = @(
	(Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
)
foreach ($isccRoot in @(
		(Get-Item -LiteralPath Env:ProgramFiles -ErrorAction SilentlyContinue)?.Value,
		(Get-Item -LiteralPath 'Env:ProgramFiles(x86)' -ErrorAction SilentlyContinue)?.Value,
		(Get-Item -LiteralPath Env:LOCALAPPDATA -ErrorAction SilentlyContinue)?.Value
	)) {
	if ([string]::IsNullOrWhiteSpace($isccRoot)) {
		continue
	}

	$isccRoots += Join-Path $isccRoot 'Inno Setup 6\ISCC.exe'
	$isccRoots += Join-Path $isccRoot 'Programs\Inno Setup 6\ISCC.exe'
}

$isccCandidates = @($isccRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($isccCandidates.Count -eq 0) { throw 'Inno Setup 6 の ISCC.exe が見つかりません。Inno Setup 6 をインストールするか PATH を設定してください。' }

Push-Location $repoRoot
try {
	# ----------------------------------------------
	# ビルドと発行
	# ----------------------------------------------

	& pwsh (Join-Path $repoRoot 'scripts\build-all.ps1') -Configuration Release
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& pwsh (Join-Path $repoRoot 'scripts\build-icon.ps1')
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& dotnet publish $projectPath -c Release -r win-x64 --self-contained true -p:PublishReadyToRun=true -p:DebugType=None -p:DebugSymbols=false -o $publishPath
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& $isccCandidates[0] "/DMyAppVersion=$version" "/DMyPublishDir=$publishPath" $setupScript
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	& pwsh (Join-Path $repoRoot 'scripts\package-portable.ps1') -Version $version -PublishDir $publishPath -StageDir $stagePath -LauncherPublishDir $launcherPublishPath -OutputDir (Join-Path $repoRoot 'dist')
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
	Pop-Location
}
