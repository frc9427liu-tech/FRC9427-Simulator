# 結束模擬:關掉 LEO 模擬器(port 3300,java)和搖桿網頁(port 8765,node)
# 只關名字對得上的程式,不會誤殺剛好佔用同一個 port 的其他程式(紅隊建議)
$expect = @{ 3300 = 'java'; 8765 = 'node' }
foreach ($port in $expect.Keys) {
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
        $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -like "$($expect[$port])*") { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        elseif ($p) { Write-Host "port $port 被 $($p.ProcessName) 佔用,不是模擬器,不動它" -ForegroundColor Yellow }
    }
}
# 模擬器的 cmd 視窗(標題是 LEO-Simulator)也一起關
Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*LEO-Simulator*' } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host '已結束模擬' -ForegroundColor Green
Start-Sleep -Seconds 2
