# Renders terminal-style PNG screenshots of the real db:proofs / db:queries
# output into docs/evidence/. Lines below are verbatim crops of the captured
# transcripts (see .txt files in docs/evidence/); re-render with:
#   powershell -ExecutionPolicy Bypass -File scripts/render-evidence.ps1

Add-Type -AssemblyName System.Drawing

$fontName = 'Consolas'
$fontSize = 13
$pad = 14
$lineH = 24
$titleH = 32

function Render-Terminal {
  param([string]$Title, [string[]]$Lines, [string]$OutPath)
  $font = New-Object System.Drawing.Font($fontName, $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $green = [System.Drawing.Color]::FromArgb(118, 214, 124)
  $white = [System.Drawing.Color]::FromArgb(222, 222, 226)
  $yellow = [System.Drawing.Color]::FromArgb(230, 220, 118)
  $gray = [System.Drawing.Color]::FromArgb(150, 152, 158)
  $red = [System.Drawing.Color]::FromArgb(240, 120, 120)
  $bg = [System.Drawing.Color]::FromArgb(28, 30, 32)
  $titlebg = [System.Drawing.Color]::FromArgb(46, 48, 54)

  $probe = New-Object System.Drawing.Bitmap(1, 1)
  $pg = [System.Drawing.Graphics]::FromImage($probe)
  $maxW = 0
  foreach ($l in $Lines) {
    $w = [int][Math]::Ceiling($pg.MeasureString($l, $font).Width)
    if ($w -gt $maxW) { $maxW = $w }
  }
  $pg.Dispose(); $probe.Dispose()

  $W = $maxW + $pad * 2 + 24
  $H = $titleH + $lineH * $Lines.Count + $pad * 2
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.TextRenderingHint = 'AntiAliasGridFit'
  $g.Clear($bg)

  $g.FillRectangle((New-Object System.Drawing.SolidBrush($titlebg)), 0, 0, $W, $titleH)
  $dots = @(0xE6, 0xED, 0xC3)   # macOS-style dots
  $dx = 12
  foreach ($c in $dots) {
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $c, $c, $c))
    $g.FillEllipse($b, $dx, $titleH / 2 - 4, 9, 9)
    $b.Dispose(); $dx += 15
  }
  $g.DrawString($Title, $font, (New-Object System.Drawing.SolidBrush($gray)), 62, $titleH / 2 - 9)

  $y = $titleH + $pad
  foreach ($l in $Lines) {
    $brush = $white
    if ($l -match '^\s*PASS') { $brush = $green }
    elseif ($l -match '^\s*rejected:') { $brush = $yellow }
    elseif ($l -match '^\s*(ERROR|EXECUTE|SQLSTATE)') { $brush = $red }
    elseif ($l -match 'index used:|expecting index|seq scan on') { $brush = $green }
    $g.DrawString($l, $font, (New-Object System.Drawing.SolidBrush($brush)), $pad, $y)
    $y += $lineH
  }

  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  Write-Output "wrote $OutPath"
}

$dir = Join-Path (Split-Path $PSScriptRoot -Parent) 'docs\evidence'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# ---- Three rejected invalid states (proofs 1, 12, 21) ----
Render-Terminal -Title 'Proof 1  README §5.3 example 1  illegal transition paid -> cancelled' -Lines @(
  '  PASS  paid -> cancelled is not a legal edge'
  '        rejected: cancel an order after payment was captured'
  '        orders_illegal_status_transition / 23514 -- illegal order transition: paid -> cancelled by buyer'
) -OutPath (Join-Path $dir 'violation-1-state-transition.png')

Render-Terminal -Title 'Proof 18  README §5.3 example 2  two sellers in one order' -Lines @(
  '  PASS  an order cannot mix two sellers'
  '        rejected: add a line from a different seller''s product'
  '        order_items_single_seller_per_order / 23514 -- product a1b2c3d4-0000-4000-8000-00000000006d belongs to seller a1b2c3d4-0000-4000-8000-00000000000b, but order'
) -OutPath (Join-Path $dir 'violation-2-mixed-sellers.png')

Render-Terminal -Title 'Proof 22  README §5.3 example 3  review before delivery' -Lines @(
  '  PASS  a review requires a delivered order'
  '        rejected: review an order that is still awaiting dispatch'
  '        reviews_order_must_be_completed / 23514 -- order ORD-E8C3D8 is paid; a review requires an order that reached ''completed'''
) -OutPath (Join-Path $dir 'violation-3-review.png')

# ---- Two heavy-query plans (Phase B, real output) ----
Render-Terminal -Title 'npm run db:queries  Heavy Query 1  Phase B (20k products)' -Lines @(
  '  1. A buyer browses the catalogue'
  '    expecting index: products_category_browse_idx'
  '    Limit (actual rows=10 loops=1)'
  '      Buffers: shared hit=44'
  '      ->  Nested Loop (actual rows=10 loops=1)'
  '            Buffers: shared hit=44'
  '            ->  Nested Loop (actual rows=10 loops=1)'
  '                  Buffers: shared hit=24'
  '                  ->  Index Scan using products_category_browse_idx on products p (actual rows=10 loops=1)'
  '                        Index Cond: (category = ''spices''::text)'
  '                        Buffers: shared hit=4'
  '                  ->  Index Scan using seller_profiles_pkey on seller_profiles sp (actual rows=1 loops=10)'
  '                        Index Cond: (user_id = p.seller_id)'
  '                        Filter: (status = ''active''::seller_status)'
  '                  ->  Index Scan using currencies_pkey on currencies c (actual rows=1 loops=10)'
  '                        Index Cond: ((code)::bpchar = (p.currency_code)::bpchar)'
  '    Planning Time: 6.389 ms'
  '    Execution Time: 0.265 ms'
  ''
  '    index used:    YES'
  '    seq scan on products: no'
) -OutPath (Join-Path $dir 'plan-browse-products.png')

Render-Terminal -Title 'npm run db:queries  Heavy Query 2  Phase B (10k pending orders)' -Lines @(
  '  4. A seller works their queue'
  '    expecting index: orders_seller_queue_idx'
  '    Limit (actual rows=10 loops=1)'
  '      Buffers: shared hit=42'
  '      ->  Index Scan using orders_seller_queue_idx on orders o (actual rows=10 loops=1)'
  '            Index Cond: (seller_id = ''a1b2c3d4-0000-4000-8000-00000000000a''::uuid)'
  '            Buffers: shared hit=42'
  '            SubPlan 1'
  '              ->  Aggregate (actual rows=1 loops=10)'
  '                    Buffers: shared hit=30'
  '                    ->  Bitmap Heap Scan on order_items oi (actual rows=1 loops=10)'
  '                          Recheck Cond: (order_id = o.id)'
  '                          Heap Blocks: exact=10'
  '                          Buffers: shared hit=30'
  '                          ->  Bitmap Index Scan on order_items_order_idx (actual rows=1 loops=10)'
  '                                Index Cond: (order_id = o.id)'
  '                                Buffers: shared hit=20'
  '    Planning Time: 1.179 ms'
  '    Execution Time: 0.953 ms'
  ''
  '    index used:    YES'
  '    seq scan on orders: no'
  ''
  '  SUMMARY'
  '  PASS  01_browse_products.sql uses products_category_browse_idx'
  '        index scan, no sequential scan on the driving table'
  '  PASS  04_seller_orders.sql uses orders_seller_queue_idx'
  '        index scan, no sequential scan on the driving table'
  '  2/2 index checks passed. Phase A output is included above for honesty, not as the claim.'
) -OutPath (Join-Path $dir 'plan-seller-queue.png')