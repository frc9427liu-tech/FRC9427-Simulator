# 9427 FRC 模擬器(桌面軟體版)

不用接機器人,在電腦上跑**任何一隊的 WPILib 機器人程式**:用網頁搖桿 / 鍵盤 / Xbox 手把操作,看 3D 場地上的機器人怎麼動。
像 VS Code 一樣「開啟資料夾」就好,**不用改那份程式**。

## 需要什麼

- Windows 電腦
- **WPILib 2026**(官方安裝檔:<https://github.com/wpilibsuite/allwpilib/releases>)。模擬器會自己找 `C:\Users\Public\wpilib\<年份>\jdk`
- 一個 GradleRIO 機器人專案(VS Code 用 WPILib 建的那種,裡面有 `gradlew.bat` 和 `build.gradle`)

## 怎麼用

1. 雙擊 `FRC-Simulator.exe`(桌面捷徑「9427 FRC 模擬器」)
2. 起始畫面:
   - **📂 開啟機器人專案資料夾** → 選你在 VS Code 打開的那個資料夾
   - 或點「最近開過的專案」(最多記 8 個;資料夾被搬走會顯示 ⚠️,按 ✕ 從清單移除,不會刪檔案)
3. 等它編譯、啟動模擬器(第一次約 30 秒),模擬畫面會自己打開
4. 右上角按 **啟用** 就能開始操作
5. 想換別的專案:按模擬畫面上方的 **📁 換專案**,會關掉目前的模擬器回到起始畫面
6. 關視窗 = 全部一起關(只關自己開的模擬器,不會亂關別的程式)

- 已經有一個模擬器在跑(例如用舊的「LEO 模擬搖桿」開的)時,會問你要「直接連上」還是「關掉它再開」
- 程式編譯不過時,會直接顯示錯誤訊息最後幾行;完整紀錄在 `%APPDATA%\9427 FRC 模擬器\simulator.log`
- F11 全螢幕

## 別的隊伍 / 學弟妹的程式:⚙️ 機構設定

每一隊馬達的 CAN ID、SmartDashboard 名字都不一樣。第一次開一個新專案,按模擬畫面上方的 **⚙️ 機構設定**,
告訴模擬器哪個數值是左輪、右輪、手臂、砲台、飛輪……

設定會存成專案資料夾裡的 **`.robot-sim.json`**。它只是模擬器用的設定,**不會影響機器人程式**,可以一起 commit 進 git,
下一個人打開同一個專案就不用再設。LEO 沒有這個檔也能跑(模擬器內建 LEO 的預設)。

## 手機 / 平板

跟瀏覽器版一樣:手機連同一個 Wi-Fi(或筆電的行動熱點),打開模擬畫面最下面寫的網址。
手機可以看、可以操作,但**不能改機構設定、不能換專案**(只有跑模擬器的那台電腦可以)。

## 自己重新打包(改了程式之後)

```
cd C:\FRC\VirtualJoystick\app
npm install
npm run dist
```

產出 `dist\FRC-Simulator.exe`(免安裝版,約 107 MB)。網頁檔(上一層資料夾的 `*.html`、`*.js`、`assets\` 等)會用萬用字元自動包進去,
新增 `.js` 檔不用改設定。`npm start` 可以不打包直接跑(開發用)。

## 檔案

| 檔案 | 做什麼 |
|---|---|
| `main.js` | 主程式:起始畫面、找 WPILib、跑 `gradlew simulateJava`、開視窗、關閉時收拾 |
| `start.html` / `preload.js` | 起始畫面(開啟資料夾、最近開過的專案) |
| `splash.html` | 啟動中的小視窗 |
| `../server.js` | 網頁伺服器 + `/api/project` API(瀏覽器版和桌面版共用同一份) |
| `../sim-ws.gradle` | 從外面加進 Gradle 的設定:打開模擬器的 WebSocket、關掉 WPILib 內建模擬視窗。**不改專案本身** |

### API(給網頁用)

| | |
|---|---|
| `GET /api/project` | 目前開的專案:`{ name, path, config, canSwitch }` |
| `PUT /api/project/config` | 存 `.robot-sim.json`(JSON 物件,上限 256KB,只接受這台電腦) |
| `POST /api/switch-project` | 回到起始畫面(只有桌面版有) |
