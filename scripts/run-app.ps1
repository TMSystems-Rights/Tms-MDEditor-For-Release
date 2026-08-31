param(
	[switch]$Build
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$project = Join-Path $repoRoot 'src\TmsMdEditor\TmsMdEditor.csproj'
$exe = Join-Path $repoRoot 'src\TmsMdEditor\bin\Debug\net8.0-windows\TmsMdEditor.exe'

Push-Location $repoRoot
try {
	if ($Build) {
		& "$PSScriptRoot\build-all.ps1"
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	}
	else {
		# 別コンソールの `dotnet run` だとビルド失敗が一瞬で消えるため、ここへ出す。
		Write-Host '==> dotnet build (Debug)'
		& dotnet build $project -c Debug
		if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	}

	if (-not (Test-Path -LiteralPath $exe)) {
		throw "起動用 exe が見つかりません: $exe"
	}

	Write-Host '==> Launch TMS-MDEditor (detached; terminal stays usable)'
	Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
}
finally {
	Pop-Location
}
