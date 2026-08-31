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

$isccCandidates = @(@(
	(Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
	(Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
	(Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
	(Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) })
if ($isccCandidates.Count -eq 0) { throw 'Inno Setup 6 の ISCC.exe が見つかりません。Inno Setup 6 をインストールするか PATH を設定してください。' }

Push-Location $repoRoot
try {
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
}
finally {
	Pop-Location
}
