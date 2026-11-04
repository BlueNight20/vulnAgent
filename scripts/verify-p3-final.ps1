# 第三阶段收尾验收脚本
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-p3-final.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-p3-final.ps1 -TaskId <id>
param(
    [string]$BaseUrl = 'http://localhost:3001/api',
    [string]$TargetIp = '192.168.56.101',
    [int]$TokenBudget = 200000,
    [int]$TimeBudgetMinutes = 40,
    [int]$WaitSeconds = 900,
    [string]$TaskId = ''
)

$ErrorActionPreference = 'Stop'

function Section($text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

Section 'MCP 服务可用性'

$servers = Invoke-RestMethod "$BaseUrl/mcp/servers"
foreach ($srv in $servers.items) {
    $status = $srv.status
    $color = if ($status -eq 'online') { 'Green' } elseif ($status -eq 'unknown') { 'DarkGray' } else { 'Red' }
    Write-Host ("  {0,-28} {1,-12} tools={2}" -f $srv.name, $status, $srv.toolCount) -ForegroundColor $color
}

$tools = Invoke-RestMethod "$BaseUrl/mcp/tools"
Write-Host ("  工具目录总数：{0}" -f $tools.items.Count)

if ([string]::IsNullOrWhiteSpace($TaskId)) {
    $settings = Invoke-RestMethod "$BaseUrl/settings"
    if (-not $settings.model.apiKeyConfigured) {
        Write-Host '模型 API Key 未配置，请在系统设置页填写' -ForegroundColor Red
        exit 1
    }
    Write-Host ("  模型：{0}" -f $settings.model.modelName)

    $ports = '22,80,443,445,8080'
    $body = @"
{
  "name": "DC-1 第三阶段收尾验收",
  "targets": [ { "ip": "$TargetIp", "note": "DC-1" } ],
  "scope": { "cidrs": [ "192.168.56.0/24" ], "ports": "$ports" },
  "authorizationRef": "LAB-AUTH-2026-004",
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
    Section '启动编排'
    Write-Host ("  任务：{0}" -f $TaskId)
    Invoke-RestMethod "$BaseUrl/tasks/$TaskId/engine/start" -Method Post | Out-Null

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $lastCycle = -1
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 20
        $snap = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/engine"
        if ($snap.cycle -ne $lastCycle) {
            $lastCycle = $snap.cycle
            Write-Host ("  轮次 {0} | 状态={1} | Worker={2} | tokens={3}" -f `
                $snap.cycle, $snap.orchestratorStatus, $snap.activeWorkers, $snap.tokensUsed)
        }
        if ($snap.orchestratorStatus -in @('completed', 'stalled', 'stopped', 'failed', 'needs_input')) { break }
    }
}

$engine = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/engine"
$facts = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/facts"
$workers = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/workers"
$calls = Invoke-RestMethod "$BaseUrl/mcp/calls?taskId=$TaskId&pageSize=200"
$conflicts = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/facts/conflicts"
$intents = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/intents"
$cards = Invoke-RestMethod "$BaseUrl/tasks/$TaskId/result-cards"
$approvals = Invoke-RestMethod "$BaseUrl/approvals?taskId=$TaskId"
$graph = Invoke-RestMethod "$BaseUrl/workflows/$TaskId/graph"

Section '编排结果'

$stopReason = if ($engine.stopReason) { $engine.stopReason } else { '—' }
Write-Host ("  状态       : {0}" -f $engine.orchestratorStatus)
Write-Host ("  停止原因   : {0}" -f $stopReason)
Write-Host ("  轮次       : {0}" -f $engine.cycle)
Write-Host ("  Token      : {0} / {1}" -f $engine.tokensUsed, $engine.tokenBudget)
Write-Host ("  时间预算   : {0} 分钟" -f $TimeBudgetMinutes)
Write-Host ("  工作流图   : source={0} nodes={1} edges={2}" -f $graph.source, $graph.nodes.Count, $graph.edges.Count)

Section 'Worker 执行情况'

foreach ($w in $workers.items) {
    Write-Host ("  [{0,-10}] {1,-30} profile={2,-14} tokens={3,-6} evidence={4}" -f `
        $w.status, $w.title, $w.profileId, $w.tokensSpent, $w.evidenceIds.Count)
}

Section '事实与证据'

$kinds = $facts.kindCounts
$t1 = if ($kinds.target_state) { $kinds.target_state } else { 0 }
$t2 = if ($kinds.target_negative) { $kinds.target_negative } else { 0 }
$t3 = if ($kinds.probe_error) { $kinds.probe_error } else { 0 }
$t4 = if ($kinds.inference) { $kinds.inference } else { 0 }

Write-Host ("  事实总数   : {0}" -f $facts.total)
Write-Host ("    目标状态 : {0}" -f $t1) -ForegroundColor Green
Write-Host ("    目标否定 : {0}" -f $t2) -ForegroundColor Yellow
Write-Host ("    探测失败 : {0}" -f $t3) -ForegroundColor Red
Write-Host ("    模型推断 : {0}" -f $t4) -ForegroundColor DarkGray
Write-Host ("  冲突组     : {0}" -f $conflicts.items.Count)

$observed = @($facts.items | Where-Object { $_.observationKind -eq 'target_state' -or $_.observationKind -eq 'target_negative' } | Select-Object -First 8)
if ($observed.Count -gt 0) {
    Write-Host '  事实样例：'
    foreach ($f in $observed) {
        $toolName = if ($f.sourceTool) { $f.sourceTool } else { '—' }
        Write-Host ("    [{0}/{1}] {2} {3}" -f $f.status, $f.observationKind, $f.subject, $f.predicate)
        Write-Host ("        {0}" -f ($f.object -replace "`r?`n", ' ').Substring(0, [Math]::Min(110, $f.object.Length)))
        Write-Host ("        tool={0} evidence={1}" -f $toolName, $f.sourceEvidenceIds.Count) -ForegroundColor DarkGray
    }
}

Section '工具调用统计'

$total = $calls.total
$success = @($calls.items | Where-Object { $_.status -eq 'success' }).Count
$errorC = @($calls.items | Where-Object { $_.status -eq 'error' }).Count
$denied = @($calls.items | Where-Object { $_.status -eq 'denied' }).Count
$timeout = @($calls.items | Where-Object { $_.status -eq 'timeout' }).Count

Write-Host ("  总调用     : {0}" -f $total)
Write-Host ("    成功     : {0}" -f $success) -ForegroundColor Green
Write-Host ("    错误     : {0}" -f $errorC) -ForegroundColor Red
Write-Host ("    超时     : {0}" -f $timeout) -ForegroundColor Yellow
Write-Host ("    被拒绝   : {0}" -f $denied)

$failureGroups = $calls.items | Where-Object { $_.failureKind } | Group-Object failureKind
if ($failureGroups) {
    Write-Host '  失败原因分类：'
    foreach ($g in $failureGroups) {
        Write-Host ("    {0,-20} {1}" -f $g.Name, $g.Count)
    }
}

Section '意图与结果卡'

$counts = $intents.counts
if ($counts) {
    $parts = @()
    foreach ($p in $counts.PSObject.Properties) { $parts += ("{0}={1}" -f $p.Name, $p.Value) }
    Write-Host ("  意图：{0}" -f ($parts -join ' '))
}
Write-Host ("  结果卡：{0}" -f $cards.items.Count)
foreach ($c in ($cards.items | Select-Object -First 3)) {
    $synth = if ($c.synthetic) { '降级' } else { '结构化' }
    Write-Host ("    [{0}] {1}" -f $synth, $c.objective)
}

Section '审批状态'

Write-Host ("  待审批：{0}" -f $approvals.items.Count)
foreach ($a in $approvals.items) {
    Write-Host ("    {0} 目标={1} 过期={2}" -f $a.toolName, $a.targetIp, $a.expiresAt)
}

Section '健康检查'

$stuck = @($workers.items | Where-Object { $_.status -eq 'running' }).Count
Write-Host ("  仍为 running 的 Worker：{0}" -f $stuck)
if ($stuck -gt 0) { Write-Host '  警告：存在未结束的 Worker' -ForegroundColor Yellow }

Write-Host ''
Write-Host "任务 ID: $TaskId" -ForegroundColor Green
