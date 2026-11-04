# VulnAgent 第二阶段冒烟测试
# 前提：后端已在 http://localhost:3001 运行
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke.ps1

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3001/api'
$passed = 0
$failed = 0

function Check($name, $script) {
    try {
        & $script
        Write-Host "[PASS] $name" -ForegroundColor Green
        $script:passed++
    }
    catch {
        Write-Host "[FAIL] $name -> $($_.Exception.Message)" -ForegroundColor Red
        $script:failed++
    }
}

Write-Host '=== VulnAgent 冒烟测试（第二阶段） ===' -ForegroundColor Cyan
$script:taskId = $null

Check 'GET /health 返回 ok' {
    $h = Invoke-RestMethod "$base/health"
    if ($h.status -ne 'ok') { throw "status=$($h.status)" }
}

Check 'GET /settings 不返回明文密钥' {
    $s = Invoke-RestMethod "$base/settings"
    if ($s.model.apiKeyMasked -and $s.model.apiKeyMasked -match '^sk-[A-Za-z0-9]{20,}$') {
        throw '疑似返回明文密钥'
    }
}

Check 'GET /settings/models 返回模型目录' {
    $m = Invoke-RestMethod "$base/settings/models"
    if ($m.items.Count -lt 1) { throw '模型目录为空' }
}

Check 'POST /tasks 创建任务' {
    $body = @{
        name = '冒烟测试任务'
        targets = @(@{ ip = '192.168.56.101' })
        scope = @{ cidrs = @('192.168.56.0/24'); ports = '1-1000' }
        authorized = $true
        modelProvider = 'openai-compatible'
        modelName = 'deepseek-chat'
        tokenBudget = 20000
        timeBudgetMinutes = 10
        workerCount = 2
    } | ConvertTo-Json -Depth 5
    $task = Invoke-RestMethod "$base/tasks" -Method Post -Body $body -ContentType 'application/json; charset=utf-8'
    $script:taskId = $task.id
    if (-not $task.id) { throw '未返回任务 ID' }
}

Check 'GET /tasks/:id/engine 引擎快照（未启动）' {
    $e = Invoke-RestMethod "$base/tasks/$script:taskId/engine"
    if ($e.orchestratorStatus -ne 'idle') { throw "期望 idle，实际 $($e.orchestratorStatus)" }
}

Check 'POST /tasks/:id/engine/start 幂等（连续两次）' {
    $a = Invoke-RestMethod "$base/tasks/$script:taskId/engine/start" -Method Post
    $b = Invoke-RestMethod "$base/tasks/$script:taskId/engine/start" -Method Post
    if ($b.taskId -ne $a.taskId) { throw '重复启动返回了不同任务' }
}

Check 'GET /workflows/:id/graph 返回 source=live' {
    $g = Invoke-RestMethod "$base/workflows/$script:taskId/graph"
    if ($g.source -ne 'live') { throw "source=$($g.source)" }
    if ($g.nodes.Count -lt 1) { throw '图没有节点' }
    $orch = $g.nodes | Where-Object { $_.kind -eq 'orchestrator' }
    if (-not $orch) { throw '缺少 orchestrator 节点' }
}

Check 'GET /agents/sessions 返回会话列表结构' {
    $s = Invoke-RestMethod "$base/agents/sessions?taskId=$script:taskId"
    if ($null -eq $s.items) { throw '缺少 items' }
}

Check 'GET /tasks/:id/facts 黑板事实接口' {
    $f = Invoke-RestMethod "$base/tasks/$script:taskId/facts"
    if ($null -eq $f.counts) { throw '缺少 counts' }
}

Check 'GET /tasks/:id/intents 意图接口' {
    $i = Invoke-RestMethod "$base/tasks/$script:taskId/intents"
    if ($null -eq $i.counts) { throw '缺少 counts' }
}

Check 'GET /tasks/:id/hypotheses 假设接口' {
    $h = Invoke-RestMethod "$base/tasks/$script:taskId/hypotheses"
    if ($null -eq $h.items) { throw '缺少 items' }
}

Check 'POST /tasks/:id/hints 创建人工提示' {
    $body = @{ content = '优先检查 80 端口的默认页面' } | ConvertTo-Json
    $hint = Invoke-RestMethod "$base/tasks/$script:taskId/hints" -Method Post -Body $body -ContentType 'application/json; charset=utf-8'
    if ($hint.status -ne 'pending') { throw "期望 pending，实际 $($hint.status)" }
}

Check 'GET /tasks/:id/workers 返回 Worker 记录' {
    $w = Invoke-RestMethod "$base/tasks/$script:taskId/workers"
    if ($null -eq $w.items) { throw '缺少 items' }
}

Check 'GET /tasks/:id/evidence 证据接口' {
    $e = Invoke-RestMethod "$base/tasks/$script:taskId/evidence"
    if ($null -eq $e.total) { throw '缺少 total' }
}

Check 'POST /tasks/:id/engine/stop 停止引擎' {
    $s = Invoke-RestMethod "$base/tasks/$script:taskId/engine/stop" -Method Post -TimeoutSec 40
    if ($s.orchestratorStatus -notin @('stopped', 'completed')) { throw "停止后状态 $($s.orchestratorStatus)" }
}

Check 'DELETE /tasks/:id 清理任务' {
    Invoke-RestMethod "$base/tasks/$script:taskId" -Method Delete | Out-Null
}

Write-Host ''
Write-Host "通过 $passed 项，失败 $failed 项" -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
if ($failed -gt 0) { exit 1 }
