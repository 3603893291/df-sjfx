# Resize one bitmap source into the icon sizes the app package needs.
#   16..256 -> 32bpp BMP (the ICO assembler in make-icon.js eats the DIB directly, so no PNG decoder here)
#   512     -> PNG master (kept for the future APK / other-platform icons)
# Why PowerShell: this project has zero npm deps (no sharp), and .NET System.Drawing is the only JPEG decoder on box.
# Don't run this directly -- run: node tools/make-icon.js
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI unless there's a BOM,
#       so non-ASCII comments silently corrupt the parser (a stray multibyte tail eats the next token).
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Paths always come from parameters, never as literals in this file (same encoding reason).
$src_img = [System.Drawing.Image]::FromFile((Resolve-Path $Src).Path)
Write-Output ("source " + $src_img.Width + "x" + $src_img.Height)
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out | Out-Null }

# Center-crop to the largest square first: a squashed icon looks worse than a cropped one.
$side = [Math]::Min($src_img.Width, $src_img.Height)
$from = New-Object System.Drawing.Rectangle `
  ([int](($src_img.Width - $side) / 2), [int](($src_img.Height - $side) / 2), $side, $side)

foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
  $bmp = New-Object System.Drawing.Bitmap ($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.DrawImage($src_img, (New-Object System.Drawing.Rectangle (0, 0, $s, $s)), $from, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save((Join-Path $Out ("icon-" + $s + ".bmp")), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bmp.Dispose()
}

$big = New-Object System.Drawing.Bitmap (512, 512, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bg = [System.Drawing.Graphics]::FromImage($big)
$bg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$bg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$bg.DrawImage($src_img, (New-Object System.Drawing.Rectangle (0, 0, 512, 512)), $from, [System.Drawing.GraphicsUnit]::Pixel)
$bg.Dispose()
$big.Save((Join-Path $Out "icon-512.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()
$src_img.Dispose()
Write-Output "ok"
