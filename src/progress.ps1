# Rendering stays in PowerShell so native stderr redirection cannot buffer redraws.
function New-BenchProgressState {
    param([bool]$Interactive = ($Host.UI.SupportsVirtualTerminal -and -not [Console]::IsOutputRedirected))
    return @{ Interactive = $Interactive; Open = $false; LastText = ''; LastKey = ''; LastUpdate = -100000L; Quiet = $false; Errors = 0; Trial = '' }
}

function Format-BenchProgressLine {
    param([string]$Text, [int]$Width)
    # Leave the last terminal column unused to avoid wrapping. Metadata is ASCII.
    $textOnly = $Text -replace '[\x00-\x1f\x7f-\x9f]', ''
    $available = [Math]::Max(1, $Width - 1)
    if ($textOnly.Length -gt $available) {
        if ($available -lt 4) { return $textOnly.Substring(0, $available) }
        return $textOnly.Substring(0, $available - 3) + '...'
    }
    return $textOnly
}

function Clear-BenchProgress {
    param([hashtable]$State)
    if ($State.Open) {
        Write-Host -NoNewline "`r$([char]27)[2K"
        $State.Open = $false
    }
}

function Write-BenchProgress {
    param([hashtable]$State, $Event, [int]$Width = 0, [long]$Now = [Environment]::TickCount64)
    if ($State.Interactive -and $Width -eq 0) {
        try { $Width = [Console]::WindowWidth }
        catch { $State.Interactive = $false }
    }
    $trial = "$($Event.task)/$($Event.attempt)/$($Event.repeat)"
    if ($trial -ne $State.Trial) {
        $State.Quiet = $false
        $State.Errors = 0
        $State.Trial = $trial
    }
    $warning = ($Event.quiet -and -not $State.Quiet) -or ($Event.toolErrors -gt $State.Errors)
    if ($warning -and $State.Interactive) {
        Clear-BenchProgress -State $State
        if ($Event.quiet -and -not $State.Quiet) {
            Write-Host "[$($Event.task)] No events for at least 60 seconds. This does not prove a hang." -ForegroundColor Yellow
        }
        if ($Event.toolErrors -gt $State.Errors) {
            Write-Host "[$($Event.task)] Tool errors: $($Event.toolErrors). See the saved logs for details." -ForegroundColor Yellow
        }
    }
    $State.Quiet = $Event.quiet
    $State.Errors = $Event.toolErrors
    if ($State.Interactive -and $Width -gt 1) {
        $line = Format-BenchProgressLine -Text $Event.text -Width $Width
        if (-not $warning -and $line -eq $State.LastText -and $State.Open) { return }
        # Coalesce rapid tool boundaries; the one-second refresh picks up the latest state.
        if (-not $warning -and $State.Open -and ($Now - $State.LastUpdate) -lt 100) { return }
        $color = if ($Event.quiet -or $Event.toolErrors) { 'Yellow' } else { 'Cyan' }
        Write-Host -NoNewline "`r$([char]27)[2K$line" -ForegroundColor $color
        $State.Open = $true
        $State.LastText = $line
    }
    else {
        # Pipes and CI get plain lines, not cursor controls or every tool transition.
        $key = "$trial/$($Event.stage)/$($Event.quiet)/$($Event.toolErrors)"
        if ($key -eq $State.LastKey -and ($Now - $State.LastUpdate) -lt 30000) { return }
        Write-Host $Event.text
        $State.LastKey = $key
    }
    $State.LastUpdate = $Now
}
