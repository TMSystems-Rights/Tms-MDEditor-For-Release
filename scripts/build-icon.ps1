<#
.SYNOPSIS
    共通のベース画像から、MD ラベル付きの PNG と ICO を作る

.DESCRIPTION
    ベース PNG を正方形に切り抜き、サイズごとの MD バッジを描いて PNG と複数サイズの ICO を書く
    ベース画像は変更しない。PngPath と IcoPath は上書きする

.PARAMETER BasePngPath
    入力 PNG。未指定時は build\icon-base.png。このスクリプトからの相対パス

.PARAMETER PngPath
    出力 PNG。未指定時は build\icon.png。BasePngPath と同じパスは不可

.PARAMETER IcoPath
    出力 ICO。未指定時は build\icon.ico。16 から 256 のサイズを格納する

.OUTPUTS
    なし。PNG と ICO をファイルとして書く

.EXAMPLE
    pwsh -NoProfile -File scripts/build-icon.ps1

.NOTES
    例外:
    - ベース画像が読めない、または BasePngPath と PngPath が同じときは throw する
#>
param(
	[string]$BasePngPath = (Join-Path $PSScriptRoot '..\build\icon-base.png'),
	[string]$PngPath = (Join-Path $PSScriptRoot '..\build\icon.png'),
	[string]$IcoPath = (Join-Path $PSScriptRoot '..\build\icon.ico')
)

Add-Type -AssemblyName System.Drawing
# コマンドレットの失敗を停止例外にする。ベース画像が読めないときは止める
$ErrorActionPreference = 'Stop'

# 入力 PNG のフルパス。読めないときはここで止める
$resolvedBasePng = (Resolve-Path -LiteralPath $BasePngPath).Path
# 出力 PNG のフルパス。既存ファイルは上書きする
$resolvedPng     = [System.IO.Path]::GetFullPath($PngPath)
# 出力 ICO のフルパス。既存ファイルは上書きする
$resolvedIco     = [System.IO.Path]::GetFullPath($IcoPath)
# ICO に入れる一辺。単位はピクセル。256 はディレクトリ上 0 になる
$sizes           = @(16, 24, 32, 48, 64, 128, 256)

# 入出力が同じファイルだとベース画像を上書きしてしまうので止める
if ([StringComparer]::OrdinalIgnoreCase.Equals($resolvedBasePng, $resolvedPng)) {
	throw 'BasePngPath と PngPath は別ファイルにしてください。'
}

# ----------------------------------------------
# バッジの描画
# ----------------------------------------------

<#
.SYNOPSIS
    角丸矩形の GraphicsPath を作る

.DESCRIPTION
    四隅に円弧を置き、閉じたパスを返す
    呼び出し側が Dispose する。半径が辺より大きいときの縮小はしない

.PARAMETER Rect
    角丸を描く範囲。単位はピクセル

.PARAMETER Radius
    角の半径。単位はピクセル

.OUTPUTS
    System.Drawing.Drawing2D.GraphicsPath
    閉じた角丸矩形。呼び出し側が Dispose する

.EXAMPLE
    $path = New-RoundedRectanglePath -Rect $labelRect -Radius $radius
#>
function New-RoundedRectanglePath {
	param(
		[System.Drawing.RectangleF]$Rect,
		[single]$Radius
	)

	# 閉じる前の角丸パス。呼び出し側が Dispose する
	$path     = New-Object System.Drawing.Drawing2D.GraphicsPath
	# 角の円弧の直径。単位はピクセル
	$diameter = [single]($Radius * 2)
	# 円弧を置く矩形。四隅で X と Y を動かす
	$arc      = New-Object System.Drawing.RectangleF -ArgumentList $Rect.X, $Rect.Y, $diameter, $diameter

	# 左上の円弧。180 度から 90 度
	$path.AddArc($arc, 180, 90)
	# 右上へ移してから円弧を足す
	$arc.X = [single]($Rect.Right - $diameter)
	$path.AddArc($arc, 270, 90)
	# 右下へ移してから円弧を足す
	$arc.Y = [single]($Rect.Bottom - $diameter)
	$path.AddArc($arc, 0, 90)
	# 左下へ戻してから円弧を足し、パスを閉じる
	$arc.X = $Rect.X
	$path.AddArc($arc, 90, 90)
	$path.CloseFigure()

	return $path
}

<#
.SYNOPSIS
    小さいアイコンへ、円形の MD バッジを描く

.DESCRIPTION
    一辺の中央に影、緑の円、MD の文字を描く
    ブラシとフォントは関数内で破棄する。Graphics は破棄しない

.PARAMETER Graphics
    描画先。Dispose しない

.PARAMETER Size
    アイコンの一辺。単位はピクセル。48 以下を想定する

.OUTPUTS
    なし

.EXAMPLE
    Add-SmallIconBadge -Graphics $Graphics -Size 32
#>
function Add-SmallIconBadge {
	param([System.Drawing.Graphics]$Graphics, [int]$Size)

	# 円バッジの直径。一辺の 88%。単位はピクセル
	$badgeSize   = [single]($Size * 0.88)
	# 円を中央に置くための左。単位はピクセル
	$badgeX      = [single](($Size - $badgeSize) / 2)
	# 円を中央に置くための上。単位はピクセル
	$badgeY      = [single](($Size - $badgeSize) / 2)
	# 円の塗り範囲
	$badgeRect   = New-Object System.Drawing.RectangleF -ArgumentList $badgeX, $badgeY, $badgeSize, $badgeSize
	# 影。円より一辺の 6% だけ下へずらす
	$shadowRect  = New-Object System.Drawing.RectangleF -ArgumentList $badgeX, ([single]($badgeY + ($Size * 0.06))), $badgeSize, $badgeSize
	# 半透明の黒。影に使う
	$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(130, 0, 0, 0))
	# 上を明るく、下を濃くする緑のグラデーション
	$badgeBrush  = New-Object System.Drawing.Drawing2D.LinearGradientBrush $badgeRect, ([System.Drawing.Color]::FromArgb(255, 220, 255, 231)), ([System.Drawing.Color]::FromArgb(255, 91, 220, 145)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
	# 円の縁。細いアイコンでも 1.5px 未満にしない
	$borderPen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 18, 170, 95)), ([single]([Math]::Max(1.5, $Size * 0.09)))

	try {
		$Graphics.FillEllipse($shadowBrush, $shadowRect)
		$Graphics.FillEllipse($badgeBrush, $badgeRect)
		$Graphics.DrawEllipse($borderPen, $badgeRect)

		# 本文に使う Segoe UI。finally で破棄する
		$fontFamily = New-Object System.Drawing.FontFamily 'Segoe UI'
		# 文字の水平垂直の中央揃え
		$textFormat = New-Object System.Drawing.StringFormat
		$textFormat.Alignment = [System.Drawing.StringAlignment]::Center
		$textFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
		# 文字の配置矩形。わずかに上へずらして円の中央に見せる
		$textRect = New-Object System.Drawing.RectangleF -ArgumentList ([single]0), ([single]($Size * -0.03)), ([single]$Size), ([single]($Size * 1.03))
		# MD のアウトライン。塗りつぶして文字にする
		$textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
		$textPath.AddString('MD', $fontFamily, [int][System.Drawing.FontStyle]::Bold, ([single]($Size * 0.43)), $textRect, $textFormat)
		# 暗い緑の文字色。明るいバッジの地に載せる
		$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 1, 45, 28))
		try { $Graphics.FillPath($textBrush, $textPath) }
		finally { $textBrush.Dispose(); $textPath.Dispose(); $textFormat.Dispose(); $fontFamily.Dispose() }
	} finally { $borderPen.Dispose(); $badgeBrush.Dispose(); $shadowBrush.Dispose() }
}

<#
.SYNOPSIS
    大きいアイコンへ、角丸の MD ラベルを描く

.DESCRIPTION
    128 以上はラベルを小さめにし、絵柄の中央を残す
    それ未満はラベルを広げて文字を読める大きさにする
    パスとブラシは関数内で破棄する。Graphics は破棄しない

.PARAMETER Graphics
    描画先。Dispose しない

.PARAMETER Size
    アイコンの一辺。単位はピクセル

.OUTPUTS
    なし

.EXAMPLE
    Add-LargeIconLabel -Graphics $Graphics -Size 256
#>
function Add-LargeIconLabel {
	param([System.Drawing.Graphics]$Graphics, [int]$Size)

	# 128 以上はラベルを小さめにして絵柄の中央を残す。それ未満は文字が読めるよう広げる
	if ($Size -ge 128) {
		# ラベル幅。一辺の 56%。単位はピクセル
		$labelWidth  = [single]($Size * 0.56)
		# ラベル高さ。一辺の 27%
		$labelHeight = [single]($Size * 0.27)
		# MD の文字サイズ。単位はピクセル
		$fontSize    = [single]($Size * 0.23)
	} else {
		# 小さいアイコンでは幅を広げて文字を読める大きさにする
		$labelWidth  = [single]($Size * 0.74)
		# ラベル高さ。一辺の 34%
		$labelHeight = [single]($Size * 0.34)
		# 小さいアイコン向けの文字サイズ。単位はピクセル
		$fontSize    = [single]($Size * 0.27)
	}

	# ラベルを中央に置く左。単位はピクセル
	$labelX    = [single](($Size - $labelWidth) / 2)
	# 絵柄の下寄りに置く上。一辺の 38%
	$labelY    = [single]($Size * 0.38)
	# ラベル本体の矩形
	$labelRect = New-Object System.Drawing.RectangleF -ArgumentList $labelX, $labelY, $labelWidth, $labelHeight
	# 影。ラベルより一辺の 3.5% だけ下
	$shadowRect = New-Object System.Drawing.RectangleF -ArgumentList $labelX, ([single]($labelY + ($Size * 0.035))), $labelWidth, $labelHeight
	# 角の半径。高さの 28%。単位はピクセル
	$radius     = [single]($labelHeight * 0.28)

	# 影の角丸パス。finally で破棄する
	$shadowPath = New-RoundedRectanglePath -Rect $shadowRect -Radius $radius
	# ラベルの角丸パス。finally で破棄する
	$labelPath  = New-RoundedRectanglePath -Rect $labelRect -Radius $radius
	# 半透明の黒。影に使う
	$shadowBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(120, 0, 0, 0))
	# 上を明るく、下を濃くする緑のグラデーション
	$labelBrush  = New-Object System.Drawing.Drawing2D.LinearGradientBrush $labelRect, ([System.Drawing.Color]::FromArgb(255, 220, 255, 231)), ([System.Drawing.Color]::FromArgb(255, 91, 220, 145)), ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
	# ラベルの縁。細いサイズでも 1.8px 未満にしない
	$borderPen   = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 18, 170, 95)), ([single]([Math]::Max(1.8, $Size * 0.018)))

	try {
		$Graphics.FillPath($shadowBrush, $shadowPath)
		$Graphics.FillPath($labelBrush, $labelPath)
		$Graphics.DrawPath($borderPen, $labelPath)

		# 本文に使う Segoe UI。finally で破棄する
		$fontFamily = New-Object System.Drawing.FontFamily 'Segoe UI'
		# 文字の水平垂直の中央揃え
		$textFormat = New-Object System.Drawing.StringFormat
		$textFormat.Alignment = [System.Drawing.StringAlignment]::Center
		$textFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
		# 文字の配置矩形。ラベルよりわずかに上へずらす
		$textRect = New-Object System.Drawing.RectangleF -ArgumentList $labelRect.X, ([single]($labelRect.Y - ($Size * 0.015))), $labelRect.Width, ([single]($labelRect.Height * 1.04))
		# MD のアウトライン。塗りつぶして文字にする
		$textPath = New-Object System.Drawing.Drawing2D.GraphicsPath
		$textPath.AddString('MD', $fontFamily, [int][System.Drawing.FontStyle]::Bold, $fontSize, $textRect, $textFormat)
		# 暗い緑の文字色。明るいラベルの地に載せる
		$textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 1, 45, 28))
		try { $Graphics.FillPath($textBrush, $textPath) }
		finally { $textBrush.Dispose(); $textPath.Dispose(); $textFormat.Dispose(); $fontFamily.Dispose() }
	} finally {
		$borderPen.Dispose()
		$labelBrush.Dispose()
		$shadowBrush.Dispose()
		$labelPath.Dispose()
		$shadowPath.Dispose()
	}
}

<#
.SYNOPSIS
    サイズに応じて MD バッジの描き方を選ぶ

.DESCRIPTION
    48 以下は円形バッジにする。角丸ラベルは小さいサイズでは潰れる
    49 以上は角丸ラベルにする。Graphics は破棄しない

.PARAMETER Graphics
    描画先。Dispose しない

.PARAMETER Size
    アイコンの一辺。単位はピクセル

.OUTPUTS
    なし

.EXAMPLE
    Add-IconBadge -Graphics $g -Size $Size
#>
function Add-IconBadge {
	param([System.Drawing.Graphics]$Graphics, [int]$Size)

	# 48 以下は円形。角丸ラベルは小さいサイズでは潰れる
	if ($Size -le 48) {
		Add-SmallIconBadge -Graphics $Graphics -Size $Size
	} else {
		Add-LargeIconLabel -Graphics $Graphics -Size $Size
	}
}

# ----------------------------------------------
# 画像の生成
# ----------------------------------------------

<#
.SYNOPSIS
    元画像を正方形に切り抜き、MD バッジを載せたビットマップを作る

.DESCRIPTION
    縦横の短い辺に合わせて中央を切り抜き、Size へ拡大縮小してからバッジを描く
    Source は破棄しない。戻り値の Bitmap は呼び出し側が Dispose する

.PARAMETER Source
    元画像。Dispose しない

.PARAMETER Size
    出力の一辺。単位はピクセル

.OUTPUTS
    System.Drawing.Bitmap
    32bpp ARGB。呼び出し側が Dispose する

.EXAMPLE
    $bmp = New-BadgedBitmap -Source $source -Size 256
#>
function New-BadgedBitmap {
	param([System.Drawing.Image]$Source, [int]$Size)

	# 切り抜く正方形の一辺。縦横の短い方。単位はピクセル
	$side    = [Math]::Min($Source.Width, $Source.Height)
	# 中央を正方形に切り抜く元矩形
	$srcRect = New-Object System.Drawing.Rectangle ([int](($Source.Width - $side) / 2)), ([int](($Source.Height - $side) / 2)), $side, $side
	# 出力いっぱいに描く先矩形
	$dstRect = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size
	# 32bpp の作業ビットマップ。呼び出し側が Dispose する
	$bmp     = New-Object System.Drawing.Bitmap -ArgumentList $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
	# 作業ビットマップへの描画先。finally で破棄する
	$g       = [System.Drawing.Graphics]::FromImage($bmp)
	try {
		# 角の外側を透明にする。不透明だと四角の地が見える
		$g.Clear([System.Drawing.Color]::Transparent)
		# 縮小してもバッジの縁が荒れないよう、補間と合成を高品質にする
		$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
		$g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
		$g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
		$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
		$g.DrawImage($Source, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
		Add-IconBadge -Graphics $g -Size $Size
	} finally { $g.Dispose() }

	return $bmp
}

<#
.SYNOPSIS
    バッジ付き PNG を上書き保存する

.DESCRIPTION
    出力の一辺は、元画像の短い辺と同じにする
    Path の既存ファイルは上書きする。親ディレクトリは作らない
    作業ビットマップは関数内で破棄する

.PARAMETER Source
    元画像。Dispose しない

.PARAMETER Path
    書き出す PNG のパス

.OUTPUTS
    なし

.EXAMPLE
    Save-BadgedPng -Source $source -Path $resolvedPng

.NOTES
    例外:
    - PNG の保存に失敗したときは、その例外をそのまま送出する
#>
function Save-BadgedPng {
	param([System.Drawing.Image]$Source, [string]$Path)

	# 出力の一辺。元画像の短い辺と同じ。単位はピクセル
	$size = [Math]::Min($Source.Width, $Source.Height)
	# バッジ付きビットマップ。保存後に破棄する
	$bmp  = New-BadgedBitmap -Source $Source -Size $size
	try { $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png) }
	finally { $bmp.Dispose() }
}

<#
.SYNOPSIS
    ICO の 1 サイズ分の DIB バイト列を作る

.DESCRIPTION
    BITMAPINFOHEADER、下から上の BGRA、AND マスクの順に並べる
    アルファが 128 未満の画素をマスクで透明にする
    作業ビットマップは関数内で破棄する。戻り値はバイト配列のまま返す

.PARAMETER Source
    元画像。Dispose しない

.PARAMETER Size
    このエントリの一辺。単位はピクセル

.OUTPUTS
    System.Byte[]
    ICO ディレクトリから指す画像バイト

.EXAMPLE
    $bytes = New-IconDibBytes -Source $source -Size 32
#>
function New-IconDibBytes {
	param([System.Drawing.Image]$Source, [int]$Size)

	# このサイズのバッジ付きビットマップ。finally で破棄する
	$bmp    = New-BadgedBitmap -Source $Source -Size $Size
	# DIB バイトを貯めるストリーム
	$ms     = New-Object System.IO.MemoryStream
	# リトルエンディアンでヘッダと画素を書く
	$writer = New-Object System.IO.BinaryWriter $ms
	try {
		# AND マスク 1 行のバイト数。32 ビット境界へ切り上げる
		$maskStride = [int]([Math]::Ceiling($Size / 32.0) * 4)
		$writer.Write([UInt32]40); $writer.Write([Int32]$Size); $writer.Write([Int32]($Size * 2)); $writer.Write([UInt16]1); $writer.Write([UInt16]32)
		$writer.Write([UInt32]0); $writer.Write([UInt32]($Size * $Size * 4)); $writer.Write([Int32]0); $writer.Write([Int32]0); $writer.Write([UInt32]0); $writer.Write([UInt32]0)
		# 各画素は BGRA。DIB は下の行から書く
		for ($y = $Size - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $Size; $x++) { $pixel = $bmp.GetPixel($x, $y); $writer.Write([byte]$pixel.B); $writer.Write([byte]$pixel.G); $writer.Write([byte]$pixel.R); $writer.Write([byte]$pixel.A) } }
		for ($y = $Size - 1; $y -ge 0; $y--) {
			# この行の AND マスク。0 は不透明のまま
			$row = New-Object byte[] $maskStride
			# アルファ 128 未満だけ透明ビットを立てる。それ以上は不透明のまま
			for ($x = 0; $x -lt $Size; $x++) { if ($bmp.GetPixel($x, $y).A -lt 128) { $row[[int][Math]::Floor($x / 8)] = $row[[int][Math]::Floor($x / 8)] -bor (0x80 -shr ($x % 8)) } }
			$writer.Write($row)
		}
		$writer.Flush(); return , $ms.ToArray()
	} finally { $writer.Dispose(); $ms.Dispose(); $bmp.Dispose() }
}

# ----------------------------------------------
# PNG と ICO の書き出し
# ----------------------------------------------

# ベース画像。finally で閉じる
$source = [System.Drawing.Image]::FromFile($resolvedBasePng)
try {
	Save-BadgedPng -Source $source -Path $resolvedPng
	# サイズごとの DIB。ディレクトリの直後からこの順で連結する
	$images = foreach ($size in $sizes) {
		# 1 サイズ分の画像
		[pscustomobject]@{
			# 一辺のピクセル。256 はディレクトリ上では 0 と書く
			Size = $size
			# このサイズの DIB。空にはしない
			Bytes = [byte[]](New-IconDibBytes -Source $source -Size $size)
		}
	}
} finally { $source.Dispose() }

# ICO を新規作成するストリーム。既存ファイルは上書きする
$stream = [System.IO.File]::Open($resolvedIco, [System.IO.FileMode]::Create)
# ヘッダと画像バイトを書く
$writer = New-Object System.IO.BinaryWriter $stream
try {
	$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$images.Count)
	# 最初の画像データの位置。ヘッダ 6 バイトと、件数分の 16 バイトディレクトリの直後
	$offset = 6 + (16 * $images.Count)
	# ディレクトリの幅と高さ。256 は ICO の仕様で 0。それ以外はピクセル数のまま
	foreach ($image in $images) { $sizeByte = if ($image.Size -eq 256) { 0 } else { $image.Size }; $writer.Write([byte]$sizeByte); $writer.Write([byte]$sizeByte); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$image.Bytes.Length); $writer.Write([UInt32]$offset); $offset += $image.Bytes.Length }
	foreach ($image in $images) { $writer.Write($image.Bytes) }
} finally { $writer.Dispose(); $stream.Dispose() }

Write-Host "Created $resolvedPng"
Write-Host "Created $resolvedIco"
