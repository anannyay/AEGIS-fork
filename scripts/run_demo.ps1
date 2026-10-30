param(
    [int]$Port = 8000,
    [switch]$StopExisting,
    [switch]$NoModel
)

$ErrorActionPreference = "Stop"
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$venvPython = Join-Path $repoRoot ".venv\Scripts\python.exe"
$python = if (Test-Path -LiteralPath $venvPython) {
    $venvPython
} else {
    (Get-Command python -ErrorAction Stop).Source
}

$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count) {
    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
    if (-not $StopExisting) {
        throw "Port $Port is already serving process $($processIds -join ', '). Stop it, or rerun with -StopExisting. This guard prevents demoing a stale AEGIS checkout."
    }

    foreach ($processId in $processIds) {
        $process = Get-Process -Id $processId -ErrorAction Stop
        if ($process.ProcessName -notmatch "python") {
            throw "Refusing to stop non-Python process $processId ($($process.ProcessName)) on port $Port."
        }
        Stop-Process -Id $processId -Force
    }
    Start-Sleep -Milliseconds 600
}

Set-Location -LiteralPath $repoRoot
if ($NoModel) {
    $env:AEGIS_ASSISTANT_MAX_CALLS = "0"
}

Write-Host ""
Write-Host "AEGIS-Care demo source" -ForegroundColor Cyan
Write-Host "  $repoRoot"
Write-Host "Python"
Write-Host "  $python"
Write-Host "URL"
Write-Host "  http://127.0.0.1:$Port/" -ForegroundColor Green
Write-Host ""
Write-Host "Keep this terminal open. Press Ctrl+C after the demo."
Write-Host ""

& $python -m aegis_care.cli serve --host 127.0.0.1 --port $Port
