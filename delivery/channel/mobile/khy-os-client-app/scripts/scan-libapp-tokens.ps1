# khyos-structured-link-20261114 T1: count wire-token occurrences in libapp.so.
# Evidence channel for A-phase judgment T1 (proto_v / idempotency / parent_span /
# structured all > 0). The four tokens are string literals the envelope/render
# code must carry; AOT keeps string constants, so count>0 proves the code path
# shipped in this binary. Exit 1 when any count is 0.
param(
  [Parameter(Mandatory = $true)][string]$SoPath
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $SoPath)) {
  Write-Output "so-missing: $SoPath"
  exit 2
}

$bytes = [System.IO.File]::ReadAllBytes($SoPath)
$latin1 = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
$tokens = @('proto_v', 'idempotency', 'parent_span', 'structured')

Write-Output ("file=" + $SoPath)
Write-Output ("bytes=" + $bytes.Length)
Write-Output ("sha256=" + (Get-FileHash -Algorithm SHA256 $SoPath).Hash)

$fail = $false
foreach ($t in $tokens) {
  $count = ([regex]::Matches($latin1, [regex]::Escape($t))).Count
  Write-Output ("count[" + $t + "]=" + $count)
  if ($count -le 0) { $fail = $true }
}

if ($fail) {
  Write-Output "verdict=FAIL (some token count is 0)"
  exit 1
}
Write-Output "verdict=PASS (all token counts > 0)"
exit 0
