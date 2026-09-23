# 9427 FRC 模擬器

不用接機器人,在電腦上跑**任何一隊的 WPILib 機器人程式**:用螢幕搖桿 / 鍵盤 / Xbox 手把操作,看官方 2026 REBUILT 場地的 3D 畫面,球、碰撞、射球都有真實物理。

## ⬇️ 下載

到 [Releases](https://github.com/frc9427liu-tech/FRC9427-Simulator/releases/latest) 下載 `FRC9427-Simulator-Setup-版本.exe`,雙擊安裝(不用管理員權限)。
**之後有新版,軟體打開時會自己下載更新**,不用再來這裡下載。

需要:Windows、[WPILib 2026](https://github.com/wpilibsuite/allwpilib/releases)(模擬器要用它的 Java 來跑你的程式)。

> Windows 可能跳「Windows 已保護您的電腦」:按「其他資訊」→「仍要執行」。(沒有花錢買程式碼簽章,所以會這樣)

## 🚀 怎麼用

1. 打開「9427 FRC 模擬器」→ **📂 開啟機器人專案資料夾**(選 VS Code 裡打開的那個資料夾,裡面有 `gradlew.bat`)
2. 第一次會編譯,等 10~30 秒
3. 右上角按 **啟用**,開始操作
4. 不是 LEO 的專案:按 **⚙️ 機構設定**,告訴模擬器哪個數值是左輪、手臂、飛輪…(存成專案裡的 `.robot-sim.json`)

詳細說明:[使用說明.md](使用說明.md)

## 🛠️ 發新版(給維護的人)

1. 改好程式,把 `app/package.json` 的 `version` 加一(例如 2.0.0 → 2.0.1)
2. `cd app` → `npm install`(第一次)→ `npm run dist`
3. 到 GitHub 開新的 Release(tag 跟版本一樣,例如 `v2.0.1`),把 `app/dist/` 裡這 3 個檔案傳上去:
   - `FRC9427-Simulator-Setup-2.0.1.exe`
   - `FRC9427-Simulator-Setup-2.0.1.exe.blockmap`
   - `latest.yml` ← **一定要傳**,大家的軟體是看這個檔知道有新版
   或是一行指令:`gh release create v2.0.1 dist/FRC9427-Simulator-Setup-2.0.1.exe dist/FRC9427-Simulator-Setup-2.0.1.exe.blockmap dist/latest.yml`
4. 大家下次打開軟體就會自動更新

## 📁 檔案

| | |
|---|---|
| `index.html` `screen.js` `view3d.js` | 搖桿網頁、2D / 3D 畫面 |
| `physics.js` | 物理(底盤、球、射球、場地碰撞) |
| `robotmap.js` | ⚙️ 機構設定(讓任何程式都能對應) |
| `demo.js` `keyboard.js` | 展示模式、鍵盤操作 |
| `server.js` `sim-ws.gradle` | 小伺服器、讓 WPILib 模擬器接受網頁搖桿 |
| `app/` | 桌面軟體(Electron) |
| `assets/` | 官方場地 / KitBot 3D 模型(來自 [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScopeAssets)) |

FRC 9427 · 2026
