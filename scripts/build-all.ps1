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

# コマンドレットの失敗を停止例外にする。ネイティブの終了コードは別途見る
$ErrorActionPreference = 'Stop'
# このスクリプトの親。Web と csproj の基準ディレクトリ
$repoRoot = Resolve-Path "$PSScriptRoot\.."
# npm を実行するディレクトリ。本体の csproj とは別
$webDir   = Join-Path $repoRoot 'src\web'
# dotnet build の対象。テストプロジェクトは含めない
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
	# 実行中の TmsMdEditor。見つからなければ空配列で、終了処理に入らない
	$processes = @(Get-Process -Name 'TmsMdEditor' -ErrorAction SilentlyContinue)
	# 残っていないときは終了せず false。呼び出し側は再ビルドしない
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
	# dotnet の終了コード。0 以外は失敗。この関数はプロセスを終了しない
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
	# 依存の取得に失敗したら、Web のビルドも本体も始めない
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	Write-Host '==> npm run build (web)'
	npm run build
	# Web の成果物ができないときは本体ビルドへ進まない
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	Pop-Location

	# ----------------------------------------------
	# 本体
	# ----------------------------------------------

	Write-Host "==> dotnet build ($Configuration)"
	# 本体ビルドの終了コード。0 以外のときだけ exe の残留を疑う
	$dotnetExitCode = [int](Invoke-DotnetBuild -Configuration $Configuration)
	# 失敗したときだけ残留プロセスを探す。成功時は再実行しない
	if ($dotnetExitCode -ne 0) {
		Write-Warning "dotnet build failed (exit code $dotnetExitCode). Checking for lingering TmsMdEditor process..."
		# プロセスを終了できたときだけ 1 回再ビルドする。残っていなければ終了コードはそのまま
		if (Stop-TmsMdEditorIfRunning) {
			Write-Host "==> dotnet build retry ($Configuration)"
			# 再ビルドの終了コード。0 以外なら下でそのコードのまま終わる
			$dotnetExitCode = [int](Invoke-DotnetBuild -Configuration $Configuration)
		}
	}

	# 再ビルド後も失敗なら、その終了コードで終わる
	if ($dotnetExitCode -ne 0) { exit $dotnetExitCode }

	Write-Host 'Build completed.'
} finally {
	# npm の作業ディレクトリに残っているときだけ戻す。本体ビルドまで進んでいれば何もしない
	if ((Get-Location).Path -eq $webDir) {
		Pop-Location
	}

	Pop-Location
}
