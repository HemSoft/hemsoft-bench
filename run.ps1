[CmdletBinding()]
param(
    [string]$Config,
    [switch]$Execute,
    [switch]$KeepHistory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Config)) { $Config = Join-Path $PSScriptRoot 'run.json' }
$cli = Join-Path $PSScriptRoot 'src/cli.mjs'
$results = [System.Collections.Generic.List[object]]::new()
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$invocation = $null
$retention = Join-Path $PSScriptRoot 'src/retention.mjs'
. (Join-Path $PSScriptRoot 'src/progress.ps1')
$progressState = New-BenchProgressState

function Show-Result {
    param([string]$Line)
    $event = $Line | ConvertFrom-Json
    if ($event.PSObject.Properties.Name -contains 'type' -and $event.type -eq 'progress') {
        Write-BenchProgress -State $progressState -Event $event
        return
    }
    Clear-BenchProgress -State $progressState
    $result = Get-Content -LiteralPath $event.resultFile -Raw | ConvertFrom-Json
    $checks = 'not graded'
    if ($null -ne $result.grade) { $checks = "$($result.grade.passed)/$($result.grade.total)" }
    if ($result.PSObject.Properties.Name -contains 'recovery' -and $null -ne $result.recovery -and $result.recovery.state -eq 'graded') {
        $checks = "$($result.recovery.grade.passed)/$($result.recovery.grade.total) recovered"
    }
    $tokens = 'unknown'
    $cost = 'unknown'
    if ($result.PSObject.Properties.Name -contains 'metrics') {
        if ($result.metrics.usageComplete) { $tokens = $result.metrics.usage.totalTokens }
        elseif ($result.metrics.usage.totalTokens -gt 0) { $tokens = "$($result.metrics.usage.totalTokens)*" }
        if ($null -ne $result.metrics.estimatedCostUsd) {
            $cost = '{0:F4}' -f $result.metrics.estimatedCostUsd
        }
        elseif ($result.metrics.PSObject.Properties.Name -contains 'reportedEstimatedCostUsd' -and $null -ne $result.metrics.reportedEstimatedCostUsd) {
            $cost = '{0:F4}*' -f $result.metrics.reportedEstimatedCostUsd
        }
    }
    $results.Add([pscustomobject]@{
        Task = $result.task
        Status = $result.status
        Checks = $checks
        Seconds = [math]::Round($result.elapsedSeconds, 1)
        Tokens = $tokens
        'Est. USD' = $cost
        ResultFile = $event.resultFile
    })
    $color = if ($result.status -eq 'passed') { 'Green' } else { 'Yellow' }
    $gradeLabel = if ($null -ne $result.grade) { "$checks checks" } else { $checks }
    Write-Host "[$($result.task)] $($result.status): $gradeLabel, $([math]::Round($result.elapsedSeconds, 1))s" -ForegroundColor $color
    if ($result.status -eq 'timeout') {
        Write-Host '  Time limit reached. The run did not complete; any recovered grade is diagnostic only.' -ForegroundColor Yellow
    }
    if ($checks -like '*recovered') { Write-Host '  Recovered snapshot only. This does not count as a completed run.' -ForegroundColor Yellow }
    if ($result.PSObject.Properties.Name -contains 'recovery' -and $null -ne $result.recovery -and $result.recovery.PSObject.Properties.Name -contains 'error') { Write-Host "  Recovery: $($result.recovery.error)" }
    if ($result.PSObject.Properties.Name -contains 'error') { Write-Host "  $($result.error)" }
    if ($result.PSObject.Properties.Name -contains 'artifact' -and $null -ne $result.artifact) {
        Write-Host "  SVG for human review: $($result.artifact.file)" -ForegroundColor Cyan
    }
    Write-Host "  $($event.resultFile)"
}

function Invoke-Bench {
    param([string[]]$Arguments)
    & node $cli @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Benchmark command failed with exit code ${LASTEXITCODE}: $($Arguments -join ' ')"
    }
}

try {
    $Config = (Resolve-Path -LiteralPath $Config).Path
    $settings = Get-Content -LiteralPath $Config -Raw | ConvertFrom-Json
    $tasks = @($settings.tasks)
    if ($tasks.Count -eq 0) { throw 'Configure at least one task.' }
    foreach ($task in $tasks) {
        if ($task -notin @('resilient-scheduler', 'kangaroo-bike', 'world-clock')) {
            throw "Unknown task: $task"
        }
    }
    $limits = @(
        '--config', $Config,
        '--repeat', [string]$settings.repeat,
        '--wall-seconds', [string]$settings.wallSeconds,
        '--max-requests', [string]$settings.maxRequests,
        '--max-estimated-usd', [string]$settings.maxEstimatedUsd
    )

    # Validate every plan before starting any container or paid request.
    foreach ($task in $tasks) {
        $null = (Invoke-Bench -Arguments (@('run', $task) + $limits)) -join "`n" | ConvertFrom-Json
    }
    Write-Host "Model: $($settings.model.provider)/$($settings.model.model), thinking $($settings.model.thinking)" -ForegroundColor Cyan
    Write-Host "Tasks: $($tasks -join ', '), $($settings.repeat) attempt(s) each"
    Write-Host "Per attempt: $($settings.wallSeconds)s configured, $($settings.maxRequests) requests, USD $($settings.maxEstimatedUsd) estimated limit"
    if (-not $Execute) {
        Write-Host 'Plan only. Add -Execute to check readiness and make model calls.'
        return
    }

    Write-Host 'Checking Pi, Docker, and the pinned sandbox image...'
    Invoke-Bench -Arguments @('doctor')
    Write-Host 'Checking reference solutions and sandbox tools without inference...'
    Invoke-Bench -Arguments @('verify')
    $retentionArgs = @('begin', [string]$PID)
    if ($KeepHistory) { $retentionArgs += '--keep-history' }
    $leaseJson = & node $retention @retentionArgs
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare result retention. No model calls started.' }
    $invocation = ($leaseJson -join "`n") | ConvertFrom-Json
    Write-Host "Removed $($invocation.removed) previous run folders. Keep history: $([bool]$KeepHistory)"
    $limits += @('--invocation', $invocation.id)
    Invoke-Bench -Arguments @('self-test', '--config', $Config, '--wall-seconds', '60', '--progress-json', '--invocation', $invocation.id) | ForEach-Object {
        $check = $_ | ConvertFrom-Json
        if ($check.PSObject.Properties.Name -contains 'type' -and $check.type -eq 'progress') {
            Write-BenchProgress -State $progressState -Event $check
        }
        else {
            Clear-BenchProgress -State $progressState
            Write-Host "Sandbox self-test: $($check.status)"
        }
    }

    Write-Host 'Starting model calls. Cost estimates are not a hard billing cap.'
    try {
        foreach ($task in $tasks) {
            Invoke-Bench -Arguments (@('run', $task) + $limits + @('--execute', '--progress-json')) | ForEach-Object {
                Show-Result -Line $_
            }
        }
    }
    finally {
        Clear-BenchProgress -State $progressState
        $expected = $tasks.Count * [int]$settings.repeat
        Write-Host "`nResults for this invocation: $($results.Count)/$expected attempts recorded, $([math]::Round($clock.Elapsed.TotalSeconds, 1))s total" -ForegroundColor Cyan
        if ($results.Count -gt 0) {
            $results | Format-Table Task, Status, Checks, Seconds, Tokens, 'Est. USD' -AutoSize | Out-Host
            Write-Host '* Observed usage/cost is incomplete, not a full total.' -ForegroundColor DarkGray
            foreach ($row in $results) { Write-Host "$($row.Task): $($row.ResultFile)" }
        }
        if ($results.Count -lt $expected) { Write-Host 'Run stopped early. Remaining attempts were not completed.' -ForegroundColor Yellow }
        Write-Host 'Costs are provider estimates, not billing totals. Unknown usage is not zero.'
        Write-Host "All run artifacts: $(Join-Path $PSScriptRoot '.local/runs')"
    }
}
catch {
    Clear-BenchProgress -State $progressState
    # Keep a nonzero exit code for automation without PowerShell's error stack display.
    if ($results.Count -gt 0 -and $results[$results.Count - 1].Status -eq 'timeout') {
        Write-Host 'Benchmark stopped at the configured time limit. Results were saved. No automatic retry of the stopped run will be made.' -ForegroundColor Yellow
    }
    else {
        Write-Host "Benchmark stopped: $($_.Exception.Message)" -ForegroundColor Red
    }
    exit 1
}
finally {
    Clear-BenchProgress -State $progressState
    if ($null -ne $invocation) {
        & node $retention end $invocation.id
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Could not release the run lock. Check .local/run-lock before starting another run.' -ForegroundColor Red
            exit 1
        }
    }
}
