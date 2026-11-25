# Launch the integrated Markdown workbench and keep its server logs in this folder.
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPreviewPort = 8766
$taskPreviewUrl = "http://127.0.0.1:$taskPreviewPort/"
$taskListener = Get-NetTCPConnection -LocalPort $taskPreviewPort -State Listen -ErrorAction SilentlyContinue
if ($taskListener) {
    # Probe the app and document root: Node may have been launched with a relative script path.
    # This also checks that the existing listener is actually responding, without restarting it.
    $taskMatchesWorkbench = $false
    try {
        $taskInfo = Invoke-RestMethod -Uri "${taskPreviewUrl}api/info" -TimeoutSec 2
        $taskExpectedPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'slides/index.md'))
        if ($taskInfo.app -eq 'lab-marp-workbench' -and $taskInfo.defaultPath) {
            $taskActualPath = [System.IO.Path]::GetFullPath([string]$taskInfo.defaultPath)
            $taskMatchesWorkbench = [string]::Equals($taskActualPath, $taskExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)
        }
    } catch { $taskMatchesWorkbench = $false }
    if (-not $taskMatchesWorkbench) {
        throw "Port $taskPreviewPort is in use by another application. Close it or change taskPreviewPort."
    }
}
if (-not $taskListener) {
    $env:LAB_SLIDES_PORT = "$taskPreviewPort"
    $taskNode = (Get-Command node.exe).Source
    Start-Process -FilePath $taskNode -ArgumentList @('"' + (Join-Path $PSScriptRoot 'server.cjs') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput "$PSScriptRoot/workbench.log" -RedirectStandardError "$PSScriptRoot/workbench-error.log" | Out-Null
    # Wait for the first page to render before opening the browser.
    $taskReady = $false
    for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
        try { Invoke-WebRequest -Uri $taskPreviewUrl -UseBasicParsing -TimeoutSec 2 | Out-Null; $taskReady = $true; break }
        catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $taskReady) { throw 'Workbench did not start. See workbench-error.log.' }
}
# The browser now contains both the Markdown editor and the slide preview.
# NoBrowser allows startup checks without opening extra tabs; double-click still opens the browser.
if (-not $NoBrowser) { Start-Process $taskPreviewUrl }
