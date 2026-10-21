param(
    [string]$Version = "1.1.3"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$pluginDirectory = Join-Path $repositoryRoot "nonebot_plugin_rework"
$manifestPath = Join-Path $repositoryRoot "bepinex-bot-manifest.json"
if (-not (Test-Path -LiteralPath (Join-Path $pluginDirectory "tosu_plugin\index.html"))) {
    throw "nonebot_plugin_rework/tosu_plugin/index.html is missing."
}

$basePath = [IO.Path]::GetFullPath($pluginDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$relativePaths = [string[]]@(Get-ChildItem -LiteralPath $pluginDirectory -File -Recurse |
    Where-Object { $_.FullName -notmatch '[\\/]__pycache__([\\/]|$)' -and $_.Extension -ne ".pyc" } |
    ForEach-Object { $_.FullName.Substring($basePath.Length).Replace('\', '/') })
[Array]::Sort($relativePaths, [StringComparer]::Ordinal)

$hash = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
$separator = [byte[]]@(0)
$buffer = [byte[]]::new(131072)
$textExtensions = @(".css", ".html", ".js", ".json", ".mjs", ".py", ".txt")
try {
    foreach ($relativePath in $relativePaths) {
        $hash.AppendData([Text.Encoding]::UTF8.GetBytes($relativePath))
        $hash.AppendData($separator)
        $filePath = Join-Path $pluginDirectory $relativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ($textExtensions -contains [IO.Path]::GetExtension($filePath).ToLowerInvariant()) {
            $text = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($filePath))
            $text = $text.Replace("`r`n", "`n").Replace("`r", "`n")
            $hash.AppendData([Text.Encoding]::UTF8.GetBytes($text))
        }
        else {
            $stream = [IO.File]::OpenRead($filePath)
            try {
                while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $hash.AppendData($buffer, 0, $read)
                }
            }
            finally {
                $stream.Dispose()
            }
        }
        $hash.AppendData($separator)
    }
    $directoryHash = [Convert]::ToHexString($hash.GetHashAndReset())
}
finally {
    $hash.Dispose()
}

$manifest = [ordered]@{
    version = $Version
    directorySha256 = $directoryHash
    archiveUrl = "https://github.com/MCPsDE/nonebot-plugin-for-osumania4k/archive/refs/heads/main.zip"
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Wrote $manifestPath"
Write-Host "Directory SHA-256: $directoryHash"
