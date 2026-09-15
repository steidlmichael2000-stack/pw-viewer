<#
    make-icons.ps1 - erzeugt die PWA-Icons (Scan-Wuerfel aus Punkten).
    Muss nur einmal laufen bzw. wenn sich das Icon aendern soll.

    Motiv: die zwoelf Kanten eines gedrehten Wuerfels, abgetastet als
    Punktwolke. Vordere Punkte sind groesser und heller als hintere, das
    gibt die Tiefe.
#>
[CmdletBinding()] param()
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$BG    = [System.Drawing.Color]::FromArgb(255, 10, 13, 15)    # #0a0d0f
$BLUE  = @(74, 144, 217)                                       # #4a90d9 (hinten)
$LIGHT = @(156, 197, 238)                                      # #9cc5ee (vorne)
$SS    = 4                                                     # Supersampling

function Get-Dots {
    # Blickrichtung: 35 Grad um die Hochachse, 24 Grad geneigt.
    $ay = [math]::PI * 35 / 180
    $ax = [math]::PI * 24 / 180

    $V = @(@(-1,-1,-1), @(1,-1,-1), @(1,1,-1), @(-1,1,-1),
           @(-1,-1, 1), @(1,-1, 1), @(1,1, 1), @(-1,1, 1))
    $E = @(@(0,1),@(1,2),@(2,3),@(3,0), @(4,5),@(5,6),@(6,7),@(7,4),
           @(0,4),@(1,5),@(2,6),@(3,7))

    $seen = @{}
    foreach ($e in $E) {
        for ($i = 0; $i -lt 6; $i++) {
            $t = $i / 5.0
            $a = $V[$e[0]]; $b = $V[$e[1]]
            $x = $a[0] + ($b[0] - $a[0]) * $t
            $y = $a[1] + ($b[1] - $a[1]) * $t
            $z = $a[2] + ($b[2] - $a[2]) * $t

            # Drehung um die Hochachse ...
            $x2 =  $x * [math]::Cos($ay) + $z * [math]::Sin($ay)
            $z2 = -$x * [math]::Sin($ay) + $z * [math]::Cos($ay)
            # ... dann neigen.
            $y2 = $y * [math]::Cos($ax) - $z2 * [math]::Sin($ax)
            $z3 = $y * [math]::Sin($ax) + $z2 * [math]::Cos($ax)

            $k = 1 / (1 + $z3 * 0.20)          # einfache Perspektive
            $px = $x2 * $k; $py = $y2 * $k

            $key = "{0:N2}/{1:N2}" -f $px, $py  # gemeinsame Eckpunkte nur einmal
            if ($seen.ContainsKey($key)) { continue }

            $d = [math]::Max(0.0, [math]::Min(1.0, ($k - 0.80) / 0.45))
            $seen[$key] = [pscustomobject]@{
                X = $px * 0.30
                Y = $py * 0.30
                R = 0.016 + 0.012 * $d
                C = [System.Drawing.Color]::FromArgb(
                        [int](140 + 105 * $d),
                        [int]($BLUE[0] + ($LIGHT[0] - $BLUE[0]) * $d),
                        [int]($BLUE[1] + ($LIGHT[1] - $BLUE[1]) * $d),
                        [int]($BLUE[2] + ($LIGHT[2] - $BLUE[2]) * $d))
            }
        }
    }
    return @($seen.Values)
}

function New-Icon {
    param([int] $Size, [string] $Path, [bool] $Maskable)

    $S   = $Size * $SS
    $bmp = [System.Drawing.Bitmap]::new($S, $S)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'

    if ($Maskable) {
        # Randlos - den Zuschnitt uebernimmt Android selbst.
        $g.Clear($BG)
    } else {
        $g.Clear([System.Drawing.Color]::Transparent)
        $rad   = $S * 0.22
        $shape = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $shape.AddArc(0, 0, 2*$rad, 2*$rad, 180, 90)
        $shape.AddArc($S-2*$rad, 0, 2*$rad, 2*$rad, 270, 90)
        $shape.AddArc($S-2*$rad, $S-2*$rad, 2*$rad, 2*$rad, 0, 90)
        $shape.AddArc(0, $S-2*$rad, 2*$rad, 2*$rad, 90, 90)
        $shape.CloseFigure()
        $g.FillPath([System.Drawing.SolidBrush]::new($BG), $shape)
        $shape.Dispose()
    }

    $dots = Get-Dots

    # Punktfeld mittig in die sichere Flaeche einpassen.
    $inset = if ($Maskable) { 0.21 } else { 0.11 }
    $minX = ($dots | ForEach-Object { $_.X - $_.R } | Measure-Object -Minimum).Minimum
    $maxX = ($dots | ForEach-Object { $_.X + $_.R } | Measure-Object -Maximum).Maximum
    $minY = ($dots | ForEach-Object { $_.Y - $_.R } | Measure-Object -Minimum).Minimum
    $maxY = ($dots | ForEach-Object { $_.Y + $_.R } | Measure-Object -Maximum).Maximum
    $mx = ($maxX + $minX) / 2; $my = ($maxY + $minY) / 2
    $k  = ($S * (1 - 2 * $inset)) / [math]::Max($maxX - $minX, $maxY - $minY)

    foreach ($d in $dots) {
        $X = $S/2 + ($d.X - $mx) * $k
        $Y = $S/2 + ($d.Y - $my) * $k
        $R = $d.R * $k
        $brush = [System.Drawing.SolidBrush]::new($d.C)
        $g.FillEllipse($brush, [float]($X-$R), [float]($Y-$R), [float](2*$R), [float](2*$R))
        $brush.Dispose()
    }
    $g.Dispose()

    # Herunterrechnen glaettet die Kanten.
    $out = [System.Drawing.Bitmap]::new($Size, $Size)
    $go  = [System.Drawing.Graphics]::FromImage($out)
    $go.InterpolationMode = 'HighQualityBicubic'
    $go.PixelOffsetMode   = 'HighQuality'
    $go.DrawImage($bmp, 0, 0, $Size, $Size)
    $go.Dispose()
    $out.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $out.Dispose(); $bmp.Dispose()
    Write-Host "  $([IO.Path]::GetFileName($Path)) ($Size x $Size)"
}

$root = $PSScriptRoot
Write-Host "Icons werden erzeugt:" -ForegroundColor Cyan
New-Icon -Size 192 -Path (Join-Path $root "icon-192.png")          -Maskable $false
New-Icon -Size 512 -Path (Join-Path $root "icon-512.png")          -Maskable $false
New-Icon -Size 512 -Path (Join-Path $root "icon-maskable-512.png") -Maskable $true
Write-Host "Fertig." -ForegroundColor Green
