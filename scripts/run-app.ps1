<#
.SYNOPSIS
    デバッグビルドの TMS-MDEditor を起動する

.DESCRIPTION
    既定では Debug 構成で dotnet build してから exe を別プロセスで起動する
    -Build のときは scripts/build-all.ps1 で Web も含めてビルドしてから起動する
    起動後もこのコンソールは使える。既存の dist 成果物は削除しない

.PARAMETER Build
    指定したときだけ、Web を含む build-all.ps1 を実行してから起動する

.OUTPUTS
    なし。exe を Start-Process で起動する

.EXAMPLE
    pwsh -NoProfile -File scripts/run-app.ps1

.EXAMPLE
    pwsh -NoProfile -File scripts/run-app.ps1 -Build

.NOTES
    例外:
    - ビルド後に Debug の exe が無い場合は throw する
    - ビルドが失敗したときは、その終了コードで終了する
#>
param(
	[switch]$Build
)

# コマンドレットの失敗を停止例外にする。ビルド失敗のあと起動へ進まない
$ErrorActionPreference = 'Stop'
# このスクリプトの親。csproj と exe の基準ディレクトリ
$repoRoot = Resolve-Path "$PSScriptRoot\.."
# Debug ビルドの対象。Release の発行物は起動しない
$project = Join-Path $repoRoot 'src\TmsMdEditor\TmsMdEditor.csproj'
# 起動する Debug の exe。ビルド前は未生成のことがある
$exe = Join-Path $repoRoot 'src\TmsMdEditor\bin\Debug\net8.0-windows\TmsMdEditor.exe'

Push-Location $repoRoot
try {
	# Web も含めてビルドする指定のときだけ build-all を使う。通常は本体の Debug だけ
	if ($Build) {
		& "$PSScriptRoot\build-all.ps1"
		# Web または本体の失敗なら起動しない
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	} else {
		# 別コンソールの `dotnet run` だとビルド失敗が一瞬で消えるため、ここへ出す
		Write-Host '==> dotnet build (Debug)'
		& dotnet build $project -c Debug
		# 本体の Debug ビルドに失敗したら起動しない
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	}

	# ビルド後も exe が無いときは起動せず止める。パス違いを起動失敗にしない
	if (-not (Test-Path -LiteralPath $exe)) {
		throw "起動用 exe が見つかりません: $exe"
	}

	Write-Host '==> Launch TMS-MDEditor (detached; terminal stays usable)'
	Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
} finally {
	Pop-Location
}
