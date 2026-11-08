# Khy OS desktop-pet asset compositor (Windows / PowerShell 5.1+)
#
# Purpose: stamp the REAL Khy OS trademark (from the brand geometry source of truth,
#          delivery/brand/png/khy-os-mark-256.png) into the blank gold plates that the
#          pet artwork reserves (omamori face / chest badge), producing pet images that
#          carry an undistorted trademark.
#
# Why not let the image model paint the logo: generative models distort logos into
#          look-alike-but-wrong marks. A trademark must be pixel-exact from the
#          geometry source of truth (delivery/brand/khy-brand-geometry.js).
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/brand/build-pet-assets.ps1
#
# Requires: System.Drawing (built into Windows .NET Framework / PowerShell 5.1).
#
# Outputs:
#   works/design/khy-mascot/pet/khy-pet-*.png       2048 master (trademark baked in)
#   works/design/khy-mascot/pet/512/khy-pet-*.png    512 thumbnails (shipped to apps)
#   works/design/khy-mascot/pet/_contact-sheet.jpg   2x2 visual check sheet
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 as ANSI when there is no
#       UTF-8 BOM, so non-ASCII comments can corrupt parsing.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$srcDir = Join-Path $repo 'works\design\khy-mascot'
$outDir = Join-Path $srcDir 'pet'
$thumbDir = Join-Path $outDir '512'
$markPath = Join-Path $repo 'delivery\brand\png\khy-os-mark-256.png'

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
New-Item -ItemType Directory -Force -Path $thumbDir | Out-Null

# Blank gold plate geometry in the 2048x2048 master, in original pixels.
# Centers were picked by visual inspection of each master; plateD is the visible rim.
$plates = @(
  @{ file = 'khy-pet-female-idle.jpg';  cx = 671;  cy = 886;  markD = 104 },
  @{ file = 'khy-pet-female-lucky.jpg'; cx = 1178; cy = 1147; markD = 86 },
  # 2026-11-08 new idle art: face was re-rendered, so the chest plate moved
  # slightly; center measured on the 2048 master as 1134,1040.
  @{ file = 'khy-pet-male-idle.png';    cx = 1134; cy = 1040; markD = 56 },
  @{ file = 'khy-pet-male-lucky.jpg';   cx = 1116; cy = 1726; markD = 54 },
  # Koi (third character): the chest plate is left blank in the artwork;
  # the real trademark is stamped here.
  @{ file = 'khy-pet-koi-idle.png';     cx = 996;  cy = 1146; markD = 100 }
)

function New-InkMatrix {
  param([double]$r, [double]$g, [double]$b, [double]$alphaScale)
  $m = New-Object System.Drawing.Imaging.ColorMatrix
  $m.Matrix00 = 0; $m.Matrix01 = 0; $m.Matrix02 = 0; $m.Matrix03 = 0; $m.Matrix04 = $r
  $m.Matrix10 = 0; $m.Matrix11 = 0; $m.Matrix12 = 0; $m.Matrix13 = 0; $m.Matrix14 = $g
  $m.Matrix20 = 0; $m.Matrix21 = 0; $m.Matrix22 = 0; $m.Matrix23 = 0; $m.Matrix24 = $b
  $m.Matrix30 = 0.33 * $alphaScale; $m.Matrix31 = 0.33 * $alphaScale; $m.Matrix32 = 0.33 * $alphaScale
  $m.Matrix33 = 0; $m.Matrix34 = 0
  $m.Matrix40 = 0; $m.Matrix41 = 0; $m.Matrix42 = 0; $m.Matrix43 = 1; $m.Matrix44 = 0
  return $m
}

$mark = [System.Drawing.Image]::FromFile($markPath)
# Ink (#14110E) silhouette: alpha follows RGB luminance, so bright mark body survives.
$inkAttrs = New-Object System.Drawing.Imaging.ImageAttributes
$inkAttrs.SetColorMatrix((New-InkMatrix (20 / 255) (17 / 255) (14 / 255) 1.0))
# Soft warm shadow under the stamp to read as an embossed seal.
$shadowAttrs = New-Object System.Drawing.Imaging.ImageAttributes
$shadowAttrs.SetColorMatrix((New-InkMatrix 0.18 0.12 0.06 0.6))

$names = @()
foreach ($p in $plates) {
  $src = Join-Path $srcDir $p.file
  $base = [System.Drawing.Image]::FromFile($src)
  $bmp = New-Object System.Drawing.Bitmap $base.Width, $base.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($base, 0, 0, $base.Width, $base.Height)

  $d = [int]$p.markD
  $x = [int]$p.cx - [int]($d / 2)
  $y = [int]$p.cy - [int]($d / 2)

  $g.DrawImage(
    $mark,
    (New-Object System.Drawing.Rectangle ($x + 2), ($y + 3), $d, $d),
    0, 0, $mark.Width, $mark.Height,
    [System.Drawing.GraphicsUnit]::Pixel,
    $shadowAttrs
  )
  $g.DrawImage(
    $mark,
    (New-Object System.Drawing.Rectangle $x, $y, $d, $d),
    0, 0, $mark.Width, $mark.Height,
    [System.Drawing.GraphicsUnit]::Pixel,
    $inkAttrs
  )

  $name = [System.IO.Path]::GetFileNameWithoutExtension($p.file)
  $bmp.Save((Join-Path $outDir ($name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)

  $thumb = New-Object System.Drawing.Bitmap 512, 512
  $tg = [System.Drawing.Graphics]::FromImage($thumb)
  $tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $tg.DrawImage($bmp, 0, 0, 512, 512)
  $thumb.Save((Join-Path $thumbDir ($name + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)

  $tg.Dispose(); $thumb.Dispose(); $g.Dispose(); $bmp.Dispose(); $base.Dispose()
  $names += $name
  Write-Output ("composited {0}" -f $name)
}
$mark.Dispose()

# 2x2 contact sheet for a one-glance placement check.
$sheet = New-Object System.Drawing.Bitmap 1400, 1400
$sg = [System.Drawing.Graphics]::FromImage($sheet)
$sg.Clear([System.Drawing.Color]::White)
$sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
for ($i = 0; $i -lt $names.Count; $i++) {
  $img = [System.Drawing.Image]::FromFile((Join-Path $outDir ($names[$i] + '.png')))
  $col = $i % 2
  $row = [Math]::Floor($i / 2)
  $sg.DrawImage($img, ($col * 700), ($row * 700), 700, 700)
  $img.Dispose()
}
$sheet.Save((Join-Path $outDir '_contact-sheet.jpg'), [System.Drawing.Imaging.ImageFormat]::Jpeg)
$sg.Dispose(); $sheet.Dispose()
Write-Output 'contact sheet written'
