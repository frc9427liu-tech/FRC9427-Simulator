# 一鍵啟動:LEO 模擬器 + 模擬搖桿網頁。由「啟動模擬搖桿.bat」呼叫。
# 已經在跑的部分會跳過,重複按也沒關係。

$ErrorActionPreference = 'Continue'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = 'C:\Users\frc94\Downloads\FRC\LEO'   # LEO 搬家的話改這裡
$jdk     = 'C:\Users\Public\wpilib\2026\jdk'

function Test-Port($port) {
    [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

if (-not (Test-Path "$project\gradlew.bat")) {
    Write-Host "找不到 LEO 專案:$project" -ForegroundColor Red
    Write-Host "專案搬家了的話,用記事本打開 start.ps1 改第 6 行的路徑。"
    Read-Host '按 Enter 關閉'
    exit 1
}

# 1. 模擬器
if (Test-Port 3300) {
    Write-Host '模擬器已經在跑了' -ForegroundColor Green
} else {
    Write-Host '啟動 LEO 模擬器(第一次大約 30 秒)…' -ForegroundColor Cyan
    Start-Process -FilePath "$here\sim-run.bat" -ArgumentList "`"$project`"" -WindowStyle Minimized
}

# 2. 網頁伺服器
if (Test-Port 8765) {
    Write-Host '搖桿網頁已經在跑了' -ForegroundColor Green
} else {
    Start-Process node -ArgumentList "`"$here\server.js`"" -WindowStyle Hidden
}

# 3. 等模擬器起來再開網頁(網頁自己也會一直重連,所以等不到也沒關係)
$deadline = (Get-Date).AddSeconds(90)
while (-not (Test-Port 3300) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
if (-not (Test-Port 3300)) {
    Write-Host '模擬器還沒起來,看一下工作列上「LEO 模擬器」那個視窗有沒有紅字錯誤。' -ForegroundColor Yellow
}
# 用「App 視窗」打開(沒有網址列、分頁,看起來像獨立程式);找不到 Chrome/Edge 就用預設瀏覽器
$url = 'http://localhost:8765'
$browser = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($browser) { Start-Process $browser -ArgumentList "--app=$url", '--window-size=1500,900' }
else { Start-Process $url }
