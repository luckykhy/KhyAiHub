# adb-wireless.ps1 — shared "find the phone" + wireless-debugging helpers.
#
# WHY this file exists. More than one PowerShell entry point in this folder has
# to locate the phone:
#   · provision-shell-sidecar.ps1 — arms khyos' OWN privileged agent (the
#     built-in sidecar). Installing khyos is enough; no second app is needed.
#   · capture-adb-pairing*.js — the pairing probes used (pair-khyos-key.ps1 removed 2026-11-17: in-app SPAKE2 pairing replaced the PC-assisted route)
#     while building the self-bootstrap path.
# The addressing rules must be identical in both, otherwise the same phone gets
# two different answers depending on which script you ran — and the wireless
# serial form (mDNS, spaces, parentheses) is exactly the case where a naive
# regex silently drops the device you care about. So the rules live here once.
#
# This file has NO side effects: it only defines functions. Callers pull it in
# with  . (Join-Path $PSScriptRoot 'adb-wireless.ps1')  and then call them.
#
# NOTE ON ErrorActionPreference. Callers keep it at 'Continue': `& adb ... 2>&1`
# turns anything adb writes to stderr into an ErrorRecord, and adb writes to
# stderr even on success. Failures are detected through $LASTEXITCODE and
# explicit probes, never through the error stream.

function Resolve-Adb {
    <#
      Locate the adb binary without ever hardcoding a machine path.
      ANDROID_HOME -> ANDROID_SDK_ROOT -> the standard per-user SDK location
      -> PATH. The per-user location is derived from an environment variable,
      not a literal drive path, so the script stays portable across machines.
    #>
    $sdk = $env:ANDROID_HOME
    if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
    if ($sdk) {
        $candidate = Join-Path $sdk 'platform-tools\adb.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    if ($env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
        if (Test-Path $candidate) { return $candidate }
    }
    $onPath = Get-Command adb -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw 'adb not found. Set ANDROID_HOME, or put platform-tools on PATH.'
}

function Get-AdbDeviceRow {
    <#
      Return the serials of every device currently in the "device" state.
      The serial is NOT \S+: a wireless-debugging TLS transport shows up as
      e.g. "adb-ZYPZ261A01M6870010L-R9QdlL (2)._adb-tls-connect._tcp", with
      spaces and parentheses in it. Matching \S+ silently drops exactly the
      device we care about, which then looks like "no device attached".
    #>
    param([Parameter(Mandatory = $true)][string]$Adb)
    $raw = & $Adb devices 2>&1 | Out-String
    $rows = @()
    foreach ($line in ($raw -split "`r?`n")) {
        if ($line -match '^(.+?)\s+device\s*$') { $rows += $Matches[1].Trim() }
    }
    return $rows
}

function Resolve-WirelessConnectAddress {
    <#
      Resolve the "connect" endpoint of wireless debugging.

      The phone shows TWO different ports: the pairing port (used by
      `adb pair`) and the connect port (used by `adb connect`). Asking the
      user to copy the connect port by hand is a step they get wrong, so
      prefer mDNS: Android broadcasts the connect endpoint as
      _adb-tls-connect._tcp. Falls back to the caller-supplied address.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Adb,
        [string]$ConnectAddress = ''
    )
    if ($ConnectAddress) { return $ConnectAddress }
    $out = & $Adb mdns services 2>&1 | Out-String
    $m = [regex]::Match($out, '_adb-tls-connect\._tcp\s+([0-9\.]+:\d+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Connect-AdbWireless {
    <#
      Pair (optional) + connect over wireless debugging, then wait until the
      device reaches the "device" state.

      Returns the serial of the connected device — which for wireless
      debugging is simply the "ip:port" endpoint.

      Pairing is idempotent-ish: `adb pair` on an already-paired device fails
      with "already paired", which is harmless, so the message is printed and
      the flow continues to the connect step.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Adb,
        [string]$PairAddress = '',
        [string]$PairCode = '',
        [string]$ConnectAddress = ''
    )
    if ($PairAddress -and $PairCode) {
        Write-Host "[wireless] pairing with $PairAddress ..."
        $pairOut = & $Adb pair $PairAddress $PairCode 2>&1 | Out-String
        Write-Host ("[wireless] " + $pairOut.Trim())
    }
    $addr = Resolve-WirelessConnectAddress -Adb $Adb -ConnectAddress $ConnectAddress
    if (-not $addr) {
        throw ("Cannot resolve the wireless-debugging connect address. Pass -ConnectAddress <ip:port> " +
               "— the 'IP address & port' shown on the phone's wireless debugging screen.")
    }
    $connOut = & $Adb connect $addr 2>&1 | Out-String
    Write-Host ("[wireless] " + $connOut.Trim())
    for ($i = 0; $i -lt 40; $i++) {
        $rows = Get-AdbDeviceRow -Adb $Adb
        if ($rows -contains $addr) { return $addr }
        Start-Sleep -Milliseconds 500
    }
    throw "Wireless device $addr did not reach the 'device' state within 20s."
}

function Select-AdbTarget {
    <#
      Pick exactly one device, never guess.

      Order of preference:
        1. an explicit -Serial (must exist, or it is an error — a typo must
           not silently target another phone),
        2. the device this script just connected over wireless debugging,
        3. the only attached device,
        4. otherwise refuse and list the candidates.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Adb,
        [string]$Serial = '',
        [string]$Preferred = ''
    )
    $rows = Get-AdbDeviceRow -Adb $Adb
    if ($rows.Count -eq 0) {
        throw ("No adb device in the 'device' state. Wireless debugging must be enabled and paired on the phone.")
    }
    if ($Serial) {
        if ($rows -notcontains $Serial) {
            throw ("-Serial $Serial is not in the device list: " + ($rows -join ' | '))
        }
        return $Serial
    }
    if ($Preferred -and ($rows -contains $Preferred)) { return $Preferred }
    if ($rows.Count -gt 1) {
        throw ("More than one adb device is attached; refusing to guess. Re-run with -Serial <one of: " +
               ($rows -join ' | ') + ">")
    }
    return $rows[0]
}

function Invoke-AdbShell {
    <#
      Run one command through `adb shell` and return its combined output.
      The command is passed as a single argument, so quoting inside it stays
      the caller's business.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Adb,
        [string[]]$SerialArgs = @(),
        [Parameter(Mandatory = $true)][string]$Command
    )
    return (& $Adb @SerialArgs shell $Command 2>&1 | Out-String)
}

function Invoke-AdbWirelessSetup {
    <#
      Shared preamble for the scripts that may run over wireless debugging:
      resolve adb, optionally pair+connect, then choose the target device.

      Returns a hashtable: @{ Adb; Serial; SerialArgs }. Throws with a
      human-readable message when it cannot get there; callers decide how to
      report it.
    #>
    param(
        [string]$Serial = '',
        [string]$PairAddress = '',
        [string]$PairCode = '',
        [string]$ConnectAddress = ''
    )
    if (($PairAddress -and -not $PairCode) -or ($PairCode -and -not $PairAddress)) {
        throw '-PairAddress and -PairCode must be given together.'
    }
    $adb = Resolve-Adb
    & $adb start-server *> $null
    $preferred = ''
    if ($PairAddress -or $PairCode -or $ConnectAddress) {
        $preferred = Connect-AdbWireless -Adb $adb -PairAddress $PairAddress `
            -PairCode $PairCode -ConnectAddress $ConnectAddress
    }
    $target = Select-AdbTarget -Adb $adb -Serial $Serial -Preferred $preferred
    return @{ Adb = $adb; Serial = $target; SerialArgs = @('-s', $target) }
}
