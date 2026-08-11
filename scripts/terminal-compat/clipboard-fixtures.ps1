[CmdletBinding()]
param(
    [ValidateSet('plain', 'unicode', 'multiline', 'escape', 'large')]
    [string]$Case = 'plain',

    [switch]$CreateDropFiles
)

$esc = [char]27

switch ($Case) {
    'plain' {
        $value = "Write-Output 'IRIS_PASTE_PLAIN_OK'"
    }
    'unicode' {
        $value = "Write-Output 'IRIS_PASTE_UNICODE_OK 中文 繁體 日本語 한국어 😀'"
    }
    'multiline' {
        $value = @"
Write-Output 'IRIS_PASTE_LINE_1'
Write-Output 'IRIS_PASTE_LINE_2'
Write-Output 'IRIS_PASTE_LINE_3'
"@
    }
    'escape' {
        $value = "${esc}]0;IRIS_PASTE_ESC_SHOULD_REQUIRE_CONFIRMATION`aWrite-Output 'IRIS_PASTE_ESC_OK'"
    }
    'large' {
        $body = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' * 18000
        $value = "IRIS_LARGE_PASTE_BEGIN`n${body}`nIRIS_LARGE_PASTE_END"
    }
}

Set-Clipboard -Value $value
$bytes = [System.Text.Encoding]::UTF8.GetByteCount($value)
$sha256 = [System.Security.Cryptography.SHA256]::HashData(
    [System.Text.Encoding]::UTF8.GetBytes($value)
)
$digest = [Convert]::ToHexString($sha256).ToLowerInvariant()

Write-Host "Clipboard fixture loaded: case=$Case chars=$($value.Length) bytes=$bytes sha256=$digest"
if ($Case -eq 'escape') {
    Write-Host 'The payload contains ESC. Its raw content is intentionally not printed.'
}
if ($Case -eq 'large') {
    Write-Host 'The payload is larger than 1 MiB. Cancel the confirmation unless this run explicitly tests accepted large paste.'
}

if ($CreateDropFiles) {
    $fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'iris-terminal-compat-drop-files'
    New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
    $fixtures = @(
        'plain file.txt',
        '中文 空格.txt',
        'semicolon;echo-IRIS_INJECTION_FAIL.txt',
        'ampersand&whoami.txt',
        "quote'file.txt",
        'brackets[1].txt'
    )
    foreach ($name in $fixtures) {
        $path = Join-Path $fixtureRoot $name
        Set-Content -LiteralPath $path -Value "IRIS terminal drop fixture: $name" -Encoding utf8
    }
    Write-Host "Drop fixtures created under: $fixtureRoot"
    Get-ChildItem -LiteralPath $fixtureRoot | Select-Object -ExpandProperty FullName
    Write-Host 'The script never deletes this directory automatically. Remove it manually after testing.'
}
