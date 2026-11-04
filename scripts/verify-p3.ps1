# 第三阶段真实链路验证脚本
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-p3.ps1
param(
    [string]$BaseUrl = 'http://localhost:3001/api',
    [string]$TargetIp = '192.168.56.101',
    [int]$TokenBudget = 150000,
    [int]$TimeBudgetMinutes = 30,
    [int]$WaitSeconds = 300,
    [string]$TaskId = ''
)

$ErrorActionPreference = 'Stop'

Write-Host '=== 第三阶段真实链路验证 ===' -ForegroundColor Cyan

if ([string]::IsNullOrWhiteSpace($TaskId)) {
    $settings = Invoke-RestMethod "$BaseUrl/settings"
    if (-not $settings.model.apiKeyConfigured) {
        Write-Host '模型 API Key 未配置，请先在系统设置页填写' -ForegroundColor Red
        exit 1
    }
    Write-Host "模型：$($settings.model.modelName) @ $($settings.model.baseUrl)"

    # PowerShell 5.1 把含逗号字符串当数组，且默认用 ISO-8859-1 编码 Body，
    # 因此手工构造 JSON 并显式转 UTF-8 字节发送。
    $ports = '80,443,445,8080'
    $body = @"
{
  "name": "DC-1 第三阶段终验",
  "targets": [ { "ip": "$TargetIp", "note": "DC-1" } ],
  "scope": { "cidrs": [ "192.168.56.0/24" ], "ports": "$ports" },
  "authorizationRef": "LAB-AUTH-2026-003",
  "authorized": true,
  "modelProvider": "openai-compatible",
  "modelName": "$($settings.model.modelName)",
  "tokenBudget": $TokenBudget,
  "timeBudgetMinutes": $TimeBudgetMinutes,
  "workerCount": 2
}
"@
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $task = Invoke-RestMethod "$BaseUrl/tasks" -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8'
    $TaskId = $task.id
    Write-Host "任务已创建：$TaskId"
    Invoke-RestMethod "$BaseUrl/tasks/$TaskId/engine/start" -Method Post | Out-Null
    Write-Host '引擎已启动，等待执行…'

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        $snap = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/engine"
        Write-Host ("  状态={0} 轮次={1} Worker={2} tokens={3}" -f `
            $snap.orchestratorStatus, $snap.cycle, $snap.activeWorkers, $snap.tokensUsed)
        if ($snap.orchestratorStatus -in @('completed', 'stalled', 'stopped', 'failed', 'needs_input')) { break }
    }
}

$engine = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/engine"
$facts = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/facts"
$workers = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/workers"
$calls = Invoke-RestMethod "$BaseUrl/mcp/calls?taskId=$TaskId&pageSize=100"
$cards = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/result-cards"
$approvals = Invoke-RestMethod "$BaseUrl/approvals?taskId=$TaskId"

$stopReason = if ($engine.stopReason) { $engine.stopReason } else { '—' }
$successCalls = ($calls.items | Where-Object { $_.status -eq 'success' }).Count

$kinds = $facts.kindCounts
$kTarget = if ($kinds.target_state) { $kinds.target_state } else { 0 }
$kNegative = if ($kinds.target_negative) { $kinds.target_negative } else { 0 }
$kProbe = if ($kinds.probe_error) { $kinds.probe_error } else { 0 }
$kInfer = if ($kinds.inference) { $kinds.inference } else { 0 }

Write-Host ''
Write-Host '=== 执行结果 ===' -ForegroundColor Cyan
Write-Host ("编排状态   : {0}" -f $engine.orchestratorStatus)
Write-Host ("停止原因   : {0}" -f $stopReason)
Write-Host ("轮次       : {0}" -f $engine.cycle)
Write-Host ("Token      : {0} / {1}" -f $engine.tokensUsed, $engine.tokenBudget)
Write-Host ("事实总数   : {0}" -f $facts.total)
Write-Host ("  目标状态 : {0}" -f $kTarget)
Write-Host ("  目标否定 : {0}" -f $kNegative)
Write-Host ("  探测失败 : {0}" -f $kProbe)
Write-Host ("  模型推断 : {0}" -f $kInfer)
Write-Host ("工具调用   : {0}（成功 {1}）" -f $calls.total, $successCalls)
Write-Host ("结果卡     : {0}" -f $cards.items.Count)
Write-Host ("待审批     : {0}" -f $approvals.items.Count)

Write-Host ''
Write-Host '=== Worker 执行明细 ===' -ForegroundColor Cyan
foreach ($w in $workers.items) {
    Write-Host ("  [{0}] {1} profile={2} tokens={3} evidence={4}" -f `
        $w.status, $w.title, $w.profileId, $w.tokensSpent, $w.evidenceIds.Count)
}

Write-Host ''
Write-Host '=== 事实样例（前 5 条） ===' -ForegroundColor Cyan
foreach ($f in ($facts.items | Select-Object -First 5)) {
    $toolName = if ($f.sourceTool) { $f.sourceTool } else { '—' }
    Write-Host ("  [{0}/{1}] {2} {3} {4}" -f $f.status, $f.observationKind, $f.subject, $f.predicate, $f.object)
    Write-Host ("      tool={0} evidence={1}" -f $toolName, $f.sourceEvidenceIds.Count)
}

Write-Host ''
Write-Host "任务 ID: $TaskId" -ForegroundColor Green
