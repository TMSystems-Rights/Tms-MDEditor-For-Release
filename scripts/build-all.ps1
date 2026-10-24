<#
.SYNOPSIS
    Web と本体をビルドする

.DESCRIPTION
    src/web で npm install と npm run build を実行し、続けて TmsMdEditor を dotnet build する
    dotnet build が失敗し、TmsMdEditor.exe が残っているときはプロセスを終了してからビルドを 1 回だけ再実行する
    既存の dist 成果物は削除しない

.PARAMETER Configuration
    dotnet build の構成。Debug または Release。未指定時は Debug

.OUTPUTS
    なし。成功時は終了コード 0。Web または dotnet の失敗時は、その終了コードで終了する

.EXAMPLE
    pwsh -NoProfile -File scripts/build-all.ps1 -Configuration Release

.NOTES
    例外:
    - Stop-Process が失敗したときは、その例外をそのまま送出する
#>
param(
	[ValidateSet('Debug', 'Release')]
	[string]$Configuration = 'Debug'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$webDir   = Join-Path $repoRoot 'src\web'
$project  = Join-Path $repoRoot 'src\TmsMdEditor\TmsMdEditor.csproj'

<#
.SYNOPSIS
    発行先に残っている TmsMdEditor プロセスを終了する

.DESCRIPTION
    プロセス名 TmsMdEditor を検索し、存在すれば強制終了して 1 秒待つ
    存在しなければ何もしない

.OUTPUTS
    System.Boolean
    終了させたとき true。残っていなかったとき false

.EXAMPLE
    $stopped = Stop-TmsMdEditorIfRunning

.NOTES
    例外:
    - Stop-Process が失敗したときは、その例外をそのまま送出する
#>
function Stop-TmsMdEditorIfRunning {
	$processes = @(Get-Process -Name 'TmsMdEditor' -ErrorAction SilentlyContinue)
	if ($processes.Count -eq 0) {
		return $false
	}

	Write-Host "==> Stopping lingering TmsMdEditor process(es): $($processes.Id -join ', ')"
	$processes | Stop-Process -Force
	Start-Sleep -Seconds 1
	return $true
}

<#
.SYNOPSIS
    TmsMdEditor を指定の構成で dotnet build する

.DESCRIPTION
    ビルド出力をホストへ流し、dotnet の終了コードを返す
    失敗してもプロセスは終了しない。再実行の判断は呼び出し側が行う

.PARAMETER Configuration
    Debug または Release

.OUTPUTS
    System.Int32
    dotnet build の終了コード

.EXAMPLE
    $exitCode = Invoke-DotnetBuild -Configuration Release

.NOTES
    例外:
    - dotnet を起動できないときは、その例外をそのまま送出する
#>
function Invoke-DotnetBuild {
	param(
		[string]$Configuration
	)

	& dotnet build $project -c $Configuration | Out-Host
	$exitCode = $LASTEXITCODE
	return $exitCode
}

Push-Location $repoRoot
try {
	# ----------------------------------------------
	# Web
	# ----------------------------------------------

	Write-Host '==> npm install (web)'
	Push-Location $webDir
	npm install
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	Write-Host '==> npm run build (web)'
	npm run build
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	Pop-Location

	# ----------------------------------------------
	# 本体
	# ----------------------------------------------

	Write-Host "==> dotnet build ($Configuration)"
	$dotnetExitCode = [int](Invoke-DotnetBuild -Configuration $Configuration)
	if ($dotnetExitCode -ne 0) {
		Write-Warning "dotnet build failed (exit code $dotnetExitCode). Checking for lingering TmsMdEditor process..."
		if (Stop-TmsMdEditorIfRunning) {
			Write-Host "==> dotnet build retry ($Configuration)"
			$dotnetExitCode = [int](Invoke-DotnetBuild -Configuration $Configuration)
		}
	}

	if ($dotnetExitCode -ne 0) { exit $dotnetExitCode }

	Write-Host 'Build completed.'
} finally {
	if ((Get-Location).Path -eq $webDir) {
		Pop-Location
	}

	Pop-Location
}
