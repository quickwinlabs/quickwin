param(
    [Parameter(Mandatory=$true)]
    [string]$ExePath,
    [Parameter(Mandatory=$true)]
    [string]$JsFile,
    [switch]$Compress
)

$exeBytes = [System.IO.File]::ReadAllBytes((Resolve-Path $ExePath))
$jsBytes = [System.Text.Encoding]::UTF8.GetBytes((Get-Content -Raw $JsFile))

$magicBytes = [System.Text.Encoding]::ASCII.GetBytes("QWJS")
if ($Compress) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "node.exe not found in PATH; required for brotli compression (-Compress)"
    }
    $tmpIn = [System.IO.Path]::GetTempFileName()
    $tmpOut = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllBytes($tmpIn, $jsBytes)
        & node -e "const fs=require('fs');const z=require('zlib');const p={[z.constants.BROTLI_PARAM_MODE]:z.constants.BROTLI_MODE_TEXT,[z.constants.BROTLI_PARAM_QUALITY]:z.constants.BROTLI_MAX_QUALITY,[z.constants.BROTLI_PARAM_LGWIN]:z.constants.BROTLI_MAX_WINDOW_BITS};fs.writeFileSync(process.argv[2],z.brotliCompressSync(fs.readFileSync(process.argv[1]),{params:p}))" $tmpIn $tmpOut
        if ($LASTEXITCODE -ne 0) {
            throw "node brotli compression failed (exit $LASTEXITCODE)"
        }
        $jsBytes = [System.IO.File]::ReadAllBytes($tmpOut)
    } finally {
        Remove-Item $tmpIn, $tmpOut -Force -ErrorAction SilentlyContinue
    }
    $magicBytes = [System.Text.Encoding]::ASCII.GetBytes("QWBR")
}

$lenBytes = [System.BitConverter]::GetBytes($jsBytes.Length)
$result = $exeBytes + $jsBytes + $lenBytes + $magicBytes
[System.IO.File]::WriteAllBytes($ExePath, $result)

$tag = if ($Compress) { "brotli-compressed" } else { "raw" }
Write-Host "Embedded $($jsBytes.Length) bytes of $tag JS into $ExePath"
