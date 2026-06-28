param(
    [Parameter(Mandatory=$true)]
    [string]$ExePath,
    [Parameter(Mandatory=$true)]
    [string]$JsFile
)

$exeBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $ExePath))
$jsBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Content -Raw $JsFile))
$lenBytes = [System.BitConverter]::GetBytes($jsBytes.Length)
$magicBytes = [System.Text.Encoding]::ASCII.GetBytes("QWJS")

$result = $exeBytes + $jsBytes + $lenBytes + $magicBytes
[System.IO.File]::WriteAllBytes($ExePath, $result)

Write-Host "Embedded $($jsBytes.Length) bytes of JS into $ExePath"
