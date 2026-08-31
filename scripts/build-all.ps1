param(
	[ValidateSet('Debug', 'Release')]
	[string]$Configuration = 'Debug'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$webDir   = Join-Path $repoRoot 'src\web'
$project  = Join-Path $repoRoot 'src\TmsMdEditor\TmsMdEditor.csproj'

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
	Write-Host '==> npm install (web)'
	Push-Location $webDir
	npm install
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

	Write-Host '==> npm run build (web)'
	npm run build
	if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
	Pop-Location

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
}
finally {
	if ((Get-Location).Path -eq $webDir) {
		Pop-Location
	}

	Pop-Location
}
