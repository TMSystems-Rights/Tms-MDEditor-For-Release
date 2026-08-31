# Launcher 共通のベース画像から、TMS-MDEditor 識別用 MD ラベル付き PNG/ICO を生成する。
param(
	[string]$BasePngPath = (Join-Path $PSScriptRoot '..\build\icon-base.png'),
	[string]$PngPath = (Join-Path $PSScriptRoot '..\build\icon.png'),
	[string]$IcoPath = (Join-Path $PSScriptRoot '..\build\icon.ico')
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$resolvedBasePng = (Resolve-Path -LiteralPath $BasePngPath).Path
$resolvedPng     = [System.IO.Path]::GetFullPath($PngPath)
$resolvedIco     = [System.IO.Path]::GetFullPath($IcoPath)
$sizes           = @(16, 24, 32, 48, 64, 128, 256)

if ([StringComparer]::OrdinalIgnoreCase.Equals($resolvedBasePng, $resolvedPng)) {
	throw 'BasePngPath と PngPath は別ファイルにしてください。'
}

function New-RoundedRectanglePath {
	param(
		[System.Drawing.RectangleF]$Rect,
		[single]$Radius
	)

	$path     = New-Object System.Drawing.Drawing2D.GraphicsPath
	$diameter = [single]($Radius * 2)
	$arc      = New-Object System.Drawing.RectangleF -ArgumentList $Rect.X, $Rect.Y, $diameter, $diameter

	$path.AddArc($arc, 180, 90)
	$arc.X = [single]($Rect.Right - $diameter)
	$path.AddArc($arc, 270, 90)
	$arc.Y = [single]($Rect.Bottom - $diameter)
	$path.AddArc($arc, 0, 90)
	$arc.X = $Rect.X
	$path.AddArc($arc, 90, 90)
	$path.CloseFigure()

	return $path
}

function Add-SmallIconBadge {
	param([System.Drawing.Graphics]$Graphics, [int]$Size)

	$badgeSize   = [single]($Size * 0.88)
	$badgeX      = [single](($Size - $badgeSize) / 2)
	$badgeY      = [single](($Size - $badgeSize) / 2)
	$badgeRect   = New-Object System.Drawing.RectangleF -ArgumentList $badgeX, $badgeY, $badgeSize, $badgeSize
	$shadowRect  = New-Object System.Drawing.RectangleF -ArgumentList $badgeX, ([single]($badgeY + ($Size * 0.06))), $badgeSize, $badgeSize
	$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(130, 0, 0, 0))
	$badgeBrush  = New-Object System.Drawing.Drawing2D.LinearGradientBrush $badgeRect, ([System.Drawing.Color]::FromArgb(255, 220, 255, 231)), ([System.Drawing.Color]::FromArgb(255, 91, 220, 145)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
	$borderPen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 18, 170, 95)), ([single]([Math]::Max(1.5, $Size * 0.09)))

	try {
		$Graphics.FillEllipse($shadowBrush, $shadowRect)
		$Graphics.FillEllipse($badgeBrush, $badgeRect)
		$Graphics.DrawEllipse($borderPen, $badgeRect)

		$fontFamily = New-Object System.Drawing.FontFamily 'Segoe UI'
		$textFormat = New-Object System.Drawing.StringFormat
		$textFormat.Alignment = [System.Drawing.StringAlignment]::Center
		$textFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
		$textRect = New-Object System.Drawing.RectangleF -ArgumentList ([single]0), ([single]($Size * -0.03)), ([single]$Size), ([single]($Size * 1.03))
		$textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
		$textPath.AddString('MD', $fontFamily, [int][System.Drawing.FontStyle]::Bold, ([single]($Size * 0.43)), $textRect, $textFormat)
		$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 1, 45, 28))
		try { $Graphics.FillPath($textBrush, $textPath) }
		finally { $textBrush.Dispose(); $textPath.Dispose(); $textFormat.Dispose(); $fontFamily.Dispose() }
	}
	finally { $borderPen.Dispose(); $badgeBrush.Dispose(); $shadowBrush.Dispose() }
}

function Add-LargeIconLabel {
	param([System.Drawing.Graphics]$Graphics, [int]$Size)

	if ($Size -ge 128) {
		$labelWidth  = [single]($Size * 0.56)
		$labelHeight = [single]($Size * 0.27)
		$fontSize    = [single]($Size * 0.23)
	}
	else {
		$labelWidth  = [single]($Size * 0.74)
		$labelHeight = [single]($Size * 0.34)
		$fontSize    = [single]($Size * 0.27)
	}

	$labelX    = [single](($Size - $labelWidth) / 2)
	$labelY    = [single]($Size * 0.38)
	$labelRect = New-Object System.Drawing.RectangleF -ArgumentList $labelX, $labelY, $labelWidth, $labelHeight
	$shadowRect = New-Object System.Drawing.RectangleF -ArgumentList $labelX, ([single]($labelY + ($Size * 0.035))), $labelWidth, $labelHeight
	$radius     = [single]($labelHeight * 0.28)

	$shadowPath = New-RoundedRectanglePath -Rect $shadowRect -Radius $radius
	$labelPath  = New-RoundedRectanglePath -Rect $labelRect -Radius $radius
	$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
	$labelBrush  = New-Object System.Drawing.Drawing2D.LinearGradientBrush $labelRect, ([System.Drawing.Color]::FromArgb(255, 220, 255, 231)), ([System.Drawing.Color]::FromArgb(255, 91, 220, 145)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
	$borderPen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 18, 170, 95)), ([single]([Math]::Max(1.8, $Size * 0.018)))

	try {
		$Graphics.FillPath($shadowBrush, $shadowPath)
		$Graphics.FillPath($labelBrush, $labelPath)
		$Graphics.DrawPath($borderPen, $labelPath)

		$fontFamily = New-Object System.Drawing.FontFamily 'Segoe UI'
		$textFormat = New-Object System.Drawing.StringFormat
		$textFormat.Alignment = [System.Drawing.StringAlignment]::Center
		$textFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
		$textRect = New-Object System.Drawing.RectangleF -ArgumentList $labelRect.X, ([single]($labelRect.Y - ($Size * 0.015))), $labelRect.Width, ([single]($labelRect.Height * 1.04))
		$textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
		$textPath.AddString('MD', $fontFamily, [int][System.Drawing.FontStyle]::Bold, $fontSize, $textRect, $textFormat)
		$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 1, 45, 28))
		try { $Graphics.FillPath($textBrush, $textPath) }
		finally { $textBrush.Dispose(); $textPath.Dispose(); $textFormat.Dispose(); $fontFamily.Dispose() }
	}
	finally {
		$borderPen.Dispose()
		$labelBrush.Dispose()
		$shadowBrush.Dispose()
		$labelPath.Dispose()
		$shadowPath.Dispose()
	}
}

function Add-IconBadge {
	param([System.Drawing.Graphics]$Graphics, [int]$Size)

	if ($Size -le 48) {
		Add-SmallIconBadge -Graphics $Graphics -Size $Size
	}
	else {
		Add-LargeIconLabel -Graphics $Graphics -Size $Size
	}
}

function New-BadgedBitmap {
	param([System.Drawing.Image]$Source, [int]$Size)

	$side    = [Math]::Min($Source.Width, $Source.Height)
	$srcRect = New-Object System.Drawing.Rectangle ([int](($Source.Width - $side) / 2)), ([int](($Source.Height - $side) / 2)), $side, $side
	$dstRect = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size
	$bmp     = New-Object System.Drawing.Bitmap -ArgumentList $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	$g       = [System.Drawing.Graphics]::FromImage($bmp)
	try {
		$g.Clear([System.Drawing.Color]::Transparent)
		$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
		$g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
		$g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
		$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
		$g.DrawImage($Source, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
		Add-IconBadge -Graphics $g -Size $Size
	}
	finally { $g.Dispose() }

	return $bmp
}

function Save-BadgedPng {
	param([System.Drawing.Image]$Source, [string]$Path)

	$size = [Math]::Min($Source.Width, $Source.Height)
	$bmp  = New-BadgedBitmap -Source $Source -Size $size
	try { $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png) }
	finally { $bmp.Dispose() }
}

function New-IconDibBytes {
	param([System.Drawing.Image]$Source, [int]$Size)

	$bmp    = New-BadgedBitmap -Source $Source -Size $Size
	$ms     = New-Object System.IO.MemoryStream
	$writer = New-Object System.IO.BinaryWriter $ms
	try {
		$maskStride = [int]([Math]::Ceiling($Size / 32.0) * 4)
		$writer.Write([UInt32]40); $writer.Write([Int32]$Size); $writer.Write([Int32]($Size * 2)); $writer.Write([UInt16]1); $writer.Write([UInt16]32)
		$writer.Write([UInt32]0); $writer.Write([UInt32]($Size * $Size * 4)); $writer.Write([Int32]0); $writer.Write([Int32]0); $writer.Write([UInt32]0); $writer.Write([UInt32]0)
		for ($y = $Size - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $Size; $x++) { $pixel = $bmp.GetPixel($x, $y); $writer.Write([byte]$pixel.B); $writer.Write([byte]$pixel.G); $writer.Write([byte]$pixel.R); $writer.Write([byte]$pixel.A) } }
		for ($y = $Size - 1; $y -ge 0; $y--) {
			$row = New-Object byte[] $maskStride
			for ($x = 0; $x -lt $Size; $x++) { if ($bmp.GetPixel($x, $y).A -lt 128) { $row[[int][Math]::Floor($x / 8)] = $row[[int][Math]::Floor($x / 8)] -bor (0x80 -shr ($x % 8)) } }
			$writer.Write($row)
		}
		$writer.Flush(); return , $ms.ToArray()
	}
	finally { $writer.Dispose(); $ms.Dispose(); $bmp.Dispose() }
}

$source = [System.Drawing.Image]::FromFile($resolvedBasePng)
try {
	Save-BadgedPng -Source $source -Path $resolvedPng
	$images = foreach ($size in $sizes) { [pscustomobject]@{ Size = $size; Bytes = [byte[]](New-IconDibBytes -Source $source -Size $size) } }
}
finally { $source.Dispose() }

$stream = [System.IO.File]::Open($resolvedIco, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter $stream
try {
	$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$images.Count)
	$offset = 6 + (16 * $images.Count)
	foreach ($image in $images) { $sizeByte = if ($image.Size -eq 256) { 0 } else { $image.Size }; $writer.Write([byte]$sizeByte); $writer.Write([byte]$sizeByte); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$image.Bytes.Length); $writer.Write([UInt32]$offset); $offset += $image.Bytes.Length }
	foreach ($image in $images) { $writer.Write($image.Bytes) }
}
finally { $writer.Dispose(); $stream.Dispose() }

Write-Host "Created $resolvedPng"
Write-Host "Created $resolvedIco"
