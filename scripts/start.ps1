# VulnAgent 一键启动脚本（Windows PowerShell）
# 用法：
#   pwsh -File scripts\start.ps1            # 首次运行会自动安装依赖
#   pwsh -File scripts\start.ps1 -SkipInstall

param(
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '=== VulnAgent 开发环境检查 ===' -ForegroundColor Cyan

$nodeVersion = (node --version)
Write-Host "Node.js: $nodeVersion"
$npmVersion = (npm --version)
Write-Host "npm:     $npmVersion"

if (-not (Test-Path (Join-Path $root '.env'))) {
    Write-Host '未找到 .env，正在从 .env.example 复制...' -ForegroundColor Yellow
    Copy-Item (Join-Path $root '.env.example') (Join-Path $root '.env')
    $key = & node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    (Get-Content (Join-Path $root '.env') -Raw -Encoding utf8) -replace 'VA_ENCRYPTION_KEY=', "VA_ENCRYPTION_KEY=$key" |
        Set-Content (Join-Path $root '.env') -Encoding utf8 -NoNewline
    Write-Host "已生成 .env 并写入随机加密主密钥。" -ForegroundColor Green
}

if (-not $SkipInstall -and -not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host '正在安装依赖（首次执行耗时较长）...' -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
}

Write-Host ''
Write-Host '启动后端 http://localhost:3001/api 与前端 http://localhost:5173' -ForegroundColor Green
Write-Host '按 Ctrl+C 停止。' -ForegroundColor DarkGray
Write-Host ''

node (Join-Path $root 'scripts\dev.mjs')
