<#
.SYNOPSIS
  Generates multi-resolution Windows .ico (16, 24, 32, 48, 64, 128, 256 px PNG frames) for FailurePrism.exe and Web favicon.
#>
param(
    [string[]]$OutputPaths = @()
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir

if (-not $OutputPaths -or $OutputPaths.Count -eq 0) {
    $OutputPaths = @(
        (Join-Path $rootDir "launcher\assets\failureprism.ico"),
        (Join-Path $rootDir "public\favicon.ico")
    )
}

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2.0
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Render-PrismIconPngBytes([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)

        $s = [float]$size / 256.0
        $pad = [Math]::Max(1.0, 10.0 * $s)
        $boxSize = [float]$size - 2.0 * $pad
        $radius = [Math]::Max(3.0, 52.0 * $s)

        # 1. Background rounded tile
        $bgPath = New-RoundedRectPath $pad $pad $boxSize $boxSize $radius
        $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF(0, 0)),
            (New-Object System.Drawing.PointF($size, $size)),
            [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
            [System.Drawing.Color]::FromArgb(255, 30, 41, 59)
        )
        $g.FillPath($bgBrush, $bgPath)

        $borderW = [Math]::Max(1.0, 6.0 * $s)
        $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 56, 73, 102), $borderW)
        $g.DrawPath($borderPen, $bgPath)

        # 2. Incident white light ray (left)
        $beamW = [Math]::Max(1.6, 12.0 * $s)
        $inPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 248, 250, 252), $beamW)
        $inPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
        $inPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        $g.DrawLine($inPen, (28.0 * $s), (138.0 * $s), (95.0 * $s), (128.0 * $s))

        # 3. Dispersed spectrum rays (right)
        $rayW = [Math]::Max(1.5, 10.5 * $s)
        $rayBlue = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 56, 189, 248), $rayW)
        $rayGreen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 52, 211, 153), $rayW)
        $rayAmber = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 251, 191, 36), $rayW)
        foreach ($rp in @($rayBlue, $rayGreen, $rayAmber)) {
            $rp.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
            $rp.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
        }
        $g.DrawLine($rayBlue, (148.0 * $s), (104.0 * $s), (218.0 * $s), (68.0 * $s))
        $g.DrawLine($rayGreen, (156.0 * $s), (128.0 * $s), (222.0 * $s), (128.0 * $s))
        $g.DrawLine($rayAmber, (164.0 * $s), (152.0 * $s), (218.0 * $s), (188.0 * $s))

        if ($size -ge 24) {
            $dotR = [Math]::Max(1.8, 10.0 * $s)
            $bBlue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 56, 189, 248))
            $bGreen = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 52, 211, 153))
            $bAmber = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 245, 158, 11))
            $g.FillEllipse($bBlue, (218.0 * $s - $dotR), (68.0 * $s - $dotR), ($dotR * 2.0), ($dotR * 2.0))
            $g.FillEllipse($bGreen, (222.0 * $s - $dotR), (128.0 * $s - $dotR), ($dotR * 2.0), ($dotR * 2.0))
            $g.FillEllipse($bAmber, (218.0 * $s - $dotR), (188.0 * $s - $dotR), ($dotR * 2.0), ($dotR * 2.0))
            $bBlue.Dispose(); $bGreen.Dispose(); $bAmber.Dispose()
        }

        # 4. Internal refraction ray
        $innerPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(195, 186, 230, 253), [Math]::Max(1.2, 8.0 * $s))
        $g.DrawLine($innerPen, (93.0 * $s), (128.0 * $s), (155.0 * $s), (126.0 * $s))

        # 5. Central equilateral prism
        $pts = [System.Drawing.PointF[]]@(
            (New-Object System.Drawing.PointF((120.0 * $s), (46.0 * $s))),
            (New-Object System.Drawing.PointF((60.0 * $s), (194.0 * $s))),
            (New-Object System.Drawing.PointF((180.0 * $s), (194.0 * $s)))
        )
        $prismBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
            (New-Object System.Drawing.PointF((60.0 * $s), (46.0 * $s))),
            (New-Object System.Drawing.PointF((180.0 * $s), (194.0 * $s))),
            [System.Drawing.Color]::FromArgb(115, 56, 189, 248),
            [System.Drawing.Color]::FromArgb(95, 129, 140, 248)
        )
        $g.FillPolygon($prismBrush, $pts)

        $prismW = [Math]::Max(1.5, 10.0 * $s)
        $prismPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 224, 242, 254), $prismW)
        $prismPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
        $g.DrawPolygon($prismPen, $pts)

        if ($size -ge 32) {
            $facetPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(85, 224, 242, 254), [Math]::Max(1.0, 4.0 * $s))
            $g.DrawLine($facetPen, (120.0 * $s), (52.0 * $s), (110.0 * $s), (192.0 * $s))
            $facetPen.Dispose()
        }

        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
        $ms.Dispose()

        $prismPen.Dispose(); $prismBrush.Dispose(); $innerPen.Dispose()
        $rayBlue.Dispose(); $rayGreen.Dispose(); $rayAmber.Dispose(); $inPen.Dispose()
        $borderPen.Dispose(); $bgBrush.Dispose(); $bgPath.Dispose()

        return ,$bytes
    } finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($sz in $sizes) {
    $pngData = Render-PrismIconPngBytes $sz
    $frames += [PSCustomObject]@{
        Size  = $sz
        Bytes = $pngData
    }
}

$icoStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($icoStream)

# ICONDIR header (6 bytes)
$writer.Write([uint16]0)              # Reserved
$writer.Write([uint16]1)              # Type = 1 (ICO)
$writer.Write([uint16]$frames.Count)  # Image count

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
    $dimByte = if ($f.Size -ge 256) { [byte]0 } else { [byte]$f.Size }
    $writer.Write($dimByte)                   # Width
    $writer.Write($dimByte)                   # Height
    $writer.Write([byte]0)                    # ColorCount
    $writer.Write([byte]0)                    # Reserved
    $writer.Write([uint16]1)                  # Planes
    $writer.Write([uint16]32)                 # BitCount
    $writer.Write([uint32]$f.Bytes.Length)    # BytesInRes
    $writer.Write([uint32]$offset)            # ImageOffset
    $offset += $f.Bytes.Length
}

foreach ($f in $frames) {
    $writer.Write($f.Bytes)
}
$writer.Flush()
$icoBytes = $icoStream.ToArray()
$writer.Dispose()
$icoStream.Dispose()

foreach ($outPath in $OutputPaths) {
    $parentDir = Split-Path -Parent $outPath
    if ($parentDir -and (-not (Test-Path -LiteralPath $parentDir))) {
        New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
    [System.IO.File]::WriteAllBytes($outPath, $icoBytes)
    Write-Host "Generated multi-size icon ($($icoBytes.Length) bytes): $outPath" -ForegroundColor Green
}
