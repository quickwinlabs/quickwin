param(
    [Parameter(Mandatory=$true)]
    [string]$Command
)

$envCmd = "export MSYS2_PREFIX=C:/msys64/mingw64 && $Command"
& "C:\msys64\msys2_shell.cmd" "-defterm" "-here" "-no-start" "-mingw64" "-shell" "bash" "-c" $envCmd
