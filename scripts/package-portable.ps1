# 本体 publish 成果物と起動用 stub からポータブル ZIP と SHA-256 を生成する。
# 完成ツリーをステージしてから固める。既存 dist\publish* は削除しない。
# 出力 ZIP / sha256 ファイルは上書きする。今回作ったステージフォルダだけ削除する。
param(
	[string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
	[string]$Version = '',
	[string]$PublishDir = '',
	[string]$OutputDir = '',
	[string]$StageDir = '',
	[string]$LauncherPublishDir = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ProjectVersion {
	param([string]$Root)

	$propsPath = Join-Path $Root 'Directory.Build.props'
	[xml]$props = Get-Content -LiteralPath $propsPath
	$version = $props.Project.PropertyGroup.Version
	if ([string]::IsNullOrWhiteSpace($version)) {
		throw 'Directory.Build.props から Version を取得できません。'
	}

	return [string]$version
}

function Test-ExcludedPortableSource {
	param([string]$RelativePath)

	$normalized = $RelativePath.Replace('\', '/')

	if ($normalized -eq 'data' -or $normalized.StartsWith('data/')) {
		return $true
	}

	$fileName = [System.IO.Path]::GetFileName($normalized)
	if ($fileName -eq 'createdump.exe') {
		return $true
	}

	if ($fileName.EndsWith('.xml', [StringComparison]::OrdinalIgnoreCase) -and $fileName -ne 'portable-mode.json') {
		return $true
	}

	return $false
}

function Convert-ToZipEntryName {
	param(
		[string]$Prefix,
		[string]$RelativePath
	)

	$normalized = $RelativePath.Replace('\', '/')

	if ([string]::IsNullOrWhiteSpace($normalized)) {
		return $Prefix
	}

	return "$Prefix/$normalized"
}

function Add-ZipFileEntry {
	param(
		[System.IO.Compression.ZipArchive]$Archive,
		[string]$EntryName,
		[string]$SourcePath
	)

	$entry = $Archive.CreateEntry($EntryName, [System.IO.Compression.CompressionLevel]::Optimal)
	$sourceStream = [System.IO.File]::OpenRead($SourcePath)
	try {
		$entryStream = $entry.Open()
		try {
			$sourceStream.CopyTo($entryStream)
		} finally {
			$entryStream.Dispose()
		}
	} finally {
		$sourceStream.Dispose()
	}
}

function Test-NativeAotLinker {
	$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
	if (-not (Test-Path -LiteralPath $vswhere)) {
		return $false
	}

	$installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
	return -not [string]::IsNullOrWhiteSpace($installPath)
}

function Get-SevenZipPath {
	$candidates = @(
		(Get-Command 7z.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1),
		'D:\Program Files\7-Zip\7z.exe',
		(Join-Path ${env:ProgramFiles} '7-Zip\7z.exe'),
		(Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe')
	)

	return @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Publish-PortableLauncher {
	param(
		[string]$Root,
		[string]$OutputDir
	)

	$projectPath = Join-Path $Root 'src\TmsMdEditor.PortableLauncher\TmsMdEditor.PortableLauncher.csproj'
	if (-not (Test-Path -LiteralPath $projectPath)) {
		throw "起動用プロジェクトがありません: $projectPath"
	}

	$publishArgs = @(
		$projectPath,
		'-c', 'Release',
		'-r', 'win-x64',
		'--self-contained', 'true',
		'-p:DebugType=None',
		'-p:DebugSymbols=false',
		'-o', $OutputDir
	)

	if (Test-NativeAotLinker) {
		Write-Host '==> publishing portable launcher (Native AOT)'
		& dotnet publish @publishArgs '-p:PublishAot=true' '-p:IlcOptimizationPreference=Size'
		if ($LASTEXITCODE -ne 0) {
			throw '起動用 exe の Native AOT 発行に失敗しました。'
		}

		return
	}

	Write-Host '==> publishing portable launcher (trimmed single-file; C++ linker not found)'
	& dotnet publish @publishArgs '-p:PublishSingleFile=true' '-p:PublishTrimmed=true' '-p:EnableCompressionInSingleFile=true'
	if ($LASTEXITCODE -ne 0) {
		throw '起動用 exe の発行に失敗しました。'
	}
}

function Copy-PublishTreeToAppDir {
	param(
		[string]$PublishFull,
		[string]$AppDir
	)

	$files = Get-ChildItem -LiteralPath $PublishFull -Recurse -File
	foreach ($file in $files) {
		$relative = $file.FullName.Substring($PublishFull.Length).TrimStart('\', '/')
		if (Test-ExcludedPortableSource -RelativePath $relative) {
			continue
		}

		$destination = Join-Path $AppDir $relative
		$destinationDir = Split-Path -Parent $destination
		if (-not (Test-Path -LiteralPath $destinationDir)) {
			New-Item -ItemType Directory -Path $destinationDir | Out-Null
		}

		Copy-Item -LiteralPath $file.FullName -Destination $destination
	}
}

function New-PortableZipFromStage {
	param(
		[string]$StageDir,
		[string]$LayoutFolderName,
		[string]$ZipPath
	)

	$sevenZip = Get-SevenZipPath
	$builtZip = Join-Path $StageDir 'portable-out.zip'
	if (-not [string]::IsNullOrWhiteSpace($sevenZip)) {
		Write-Host "==> 7-Zip: $sevenZip"
		$previous = Get-Location
		try {
			Set-Location -LiteralPath $StageDir
			& $sevenZip a -tzip -mx=9 $builtZip $LayoutFolderName
			if ($LASTEXITCODE -ne 0) {
				throw "7-Zip による ZIP 生成に失敗しました: $LASTEXITCODE"
			}
		} finally {
			Set-Location -LiteralPath $previous.Path
		}
	} else {
		Write-Host '==> ZipArchive (7-Zip なし)'
		$layoutRoot = Join-Path $StageDir $LayoutFolderName
		$layoutFull = [System.IO.Path]::GetFullPath($layoutRoot)
		$zipStream = [System.IO.File]::Create($builtZip)
		$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
		try {
			$files = Get-ChildItem -LiteralPath $layoutFull -Recurse -File
			foreach ($file in $files) {
				$relative = $file.FullName.Substring($layoutFull.Length).TrimStart('\', '/')
				$entryName = Convert-ToZipEntryName -Prefix $LayoutFolderName -RelativePath $relative
				Add-ZipFileEntry -Archive $archive -EntryName $entryName -SourcePath $file.FullName
			}
		} finally {
			$archive.Dispose()
			$zipStream.Dispose()
		}
	}

	Copy-Item -LiteralPath $builtZip -Destination $ZipPath -Force
}

if ([string]::IsNullOrWhiteSpace($Version)) {
	$Version = Get-ProjectVersion -Root $ProjectRoot
}

if ([string]::IsNullOrWhiteSpace($PublishDir)) {
	$PublishDir = Join-Path $ProjectRoot 'dist\publish\win-x64'
}

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
	$OutputDir = Join-Path $ProjectRoot 'dist'
}

if ([string]::IsNullOrWhiteSpace($StageDir)) {
	$StageDir = Join-Path $ProjectRoot 'dist\zip-stage-portable'
}

if ([string]::IsNullOrWhiteSpace($LauncherPublishDir)) {
	$LauncherPublishDir = Join-Path $ProjectRoot 'dist\publish-portable-launcher\win-x64'
}

$publishFull = [System.IO.Path]::GetFullPath($PublishDir)
$outputFull = [System.IO.Path]::GetFullPath($OutputDir)
$stageFull = [System.IO.Path]::GetFullPath($StageDir)
$launcherPublishFull = [System.IO.Path]::GetFullPath($LauncherPublishDir)
$exePath = Join-Path $publishFull 'TmsMdEditor.exe'
$iconPath = Join-Path $publishFull 'icon.ico'
$markerSource = Join-Path $ProjectRoot 'resources\portable-mode.json'
$readmeSource = Join-Path $ProjectRoot 'resources\README-PORTABLE.txt'
$zipName = "TMS-MDEditor-$Version-portable-x64.zip"
$hashName = "$zipName.sha256"
$zipPath = Join-Path $outputFull $zipName
$hashPath = Join-Path $outputFull $hashName
$zipRoot = 'TMS-MDEditor'
$zipAppPrefix = "$zipRoot/app"
$layoutRoot = Join-Path $stageFull $zipRoot
$appDir = Join-Path $layoutRoot 'app'
$createdStage = $false

if (-not (Test-Path -LiteralPath $exePath)) {
	throw "publish 成果物が見つかりません: $exePath`nscripts/dist.ps1 の後に実行してください。"
}

if (-not (Test-Path -LiteralPath $iconPath)) {
	throw "publish 成果物に icon.ico がありません: $iconPath"
}

if (-not (Test-Path -LiteralPath $markerSource)) {
	throw "portable-mode.json がありません: $markerSource"
}

if (-not (Test-Path -LiteralPath $readmeSource)) {
	throw "README-PORTABLE.txt がありません: $readmeSource"
}

if (Test-Path -LiteralPath $stageFull) {
	throw "ステージ先が既に存在します: $stageFull`n既存の配布成果物を保護するため、自動削除は行いません。別の -StageDir を指定してください。"
}

if (Test-Path -LiteralPath $launcherPublishFull) {
	throw "起動用発行先が既に存在します: $launcherPublishFull`n既存の配布成果物を保護するため、自動削除は行いません。別の -LauncherPublishDir を指定してください。"
}

if (-not (Test-Path -LiteralPath $outputFull)) {
	New-Item -ItemType Directory -Path $outputFull | Out-Null
}

try {
	Publish-PortableLauncher -Root $ProjectRoot -OutputDir $launcherPublishFull
	$launcherExe = Join-Path $launcherPublishFull 'TmsMdEditor.Portable.exe'
	if (-not (Test-Path -LiteralPath $launcherExe)) {
		throw "起動用 exe が見つかりません: $launcherExe"
	}

	$launcherInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($launcherExe)
	$expectedDisplayName = 'TMS-MDEditor.portable'
	if ($launcherInfo.FileDescription -ne $expectedDisplayName) {
		throw "起動用 exe の FileDescription が $expectedDisplayName ではありません: $($launcherInfo.FileDescription)"
	}
	if ($launcherInfo.ProductName -ne $expectedDisplayName) {
		throw "起動用 exe の ProductName が $expectedDisplayName ではありません: $($launcherInfo.ProductName)"
	}

	New-Item -ItemType Directory -Path $appDir | Out-Null
	$createdStage = $true
	Copy-PublishTreeToAppDir -PublishFull $publishFull -AppDir $appDir
	Copy-Item -LiteralPath $markerSource -Destination (Join-Path $appDir 'portable-mode.json')
	Copy-Item -LiteralPath $readmeSource -Destination (Join-Path $layoutRoot 'README-PORTABLE.txt')
	Copy-Item -LiteralPath $launcherExe -Destination (Join-Path $layoutRoot 'TmsMdEditor.exe')

	if (-not (Test-Path -LiteralPath (Join-Path $appDir 'TmsMdEditor.exe'))) {
		throw 'ステージの app\TmsMdEditor.exe がありません。'
	}

	New-PortableZipFromStage -StageDir $stageFull -LayoutFolderName $zipRoot -ZipPath $zipPath
} finally {
	if ($createdStage -and (Test-Path -LiteralPath $stageFull)) {
		Remove-Item -LiteralPath $stageFull -Recurse -Force -ErrorAction SilentlyContinue
	}
}

$sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$hashLine = "$sha256  $zipName`n"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hashPath, $hashLine, $utf8NoBom)

$verify = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
	$names = @($verify.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })

	if ($names -notcontains "$zipRoot/TmsMdEditor.exe") {
		throw "ZIP に起動用 $zipRoot/TmsMdEditor.exe がありません。"
	}

	if ($names -notcontains "$zipAppPrefix/TmsMdEditor.exe") {
		throw "ZIP に $zipAppPrefix/TmsMdEditor.exe がありません。"
	}

	if ($names -notcontains "$zipAppPrefix/icon.ico") {
		throw "ZIP に $zipAppPrefix/icon.ico がありません。"
	}

	if ($names -notcontains "$zipAppPrefix/portable-mode.json") {
		throw "ZIP に app/portable-mode.json がありません。"
	}

	if ($names -notcontains "$zipRoot/README-PORTABLE.txt") {
		throw "ZIP に README-PORTABLE.txt がありません。"
	}

	if ($names -contains "$zipRoot/TmsMdEditor.exe.lnk" -or ($names | Where-Object { $_.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase) })) {
		throw 'ZIP に .lnk が含まれています。起動用は stub exe にしてください。'
	}

	if ($names -contains "$zipRoot/TmsMdEditor.ico") {
		throw 'ZIP 直下に TmsMdEditor.ico があります。アイコンは app\icon.ico のみにしてください。'
	}

	if ($names | Where-Object { $_ -eq "$zipRoot/data" -or $_.StartsWith("$zipRoot/data/") -or $_ -eq "$zipAppPrefix/data" -or $_.StartsWith("$zipAppPrefix/data/") }) {
		throw 'ZIP に利用者データ data/ が含まれています。'
	}

	$rootExe = $verify.GetEntry("$zipRoot/TmsMdEditor.exe")
	$appExe = $verify.GetEntry("$zipAppPrefix/TmsMdEditor.exe")
	if ($null -eq $rootExe -or $null -eq $appExe) {
		throw 'ZIP の起動用 exe または本体 exe を読めません。'
	}

	if ($rootExe.Length -eq $appExe.Length) {
		throw '直下の TmsMdEditor.exe と app\TmsMdEditor.exe のサイズが同じです。起動用 stub と本体が入れ替わっている可能性があります。'
	}
} finally {
	$verify.Dispose()
}

Write-Host "portable zip: $zipPath"
Write-Host "sha256: $sha256"
