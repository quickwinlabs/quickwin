param(
    [Parameter(Mandatory=$true)]
    [string]$Command
)

& "C:\msys64\msys2_shell.cmd" "-defterm" "-here" "-no-start" "-ucrt64" "-shell" "bash" "-c" $Command