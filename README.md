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

## 🤖 自訂機器人

模擬器上方按 **🤖 自訂機器人**,把畫面裡的車換成你們自己的:

- **3D 模型**:Onshape 在組合件上按右鍵 → Export → 格式選 GLTF(.glb);SolidWorks / Fusion / Blender 匯出 .glb 也可以。可以旋轉、縮放、自動縮到車身尺寸、自動加保險桿,按 👀 看一下 可以邊調邊看
- **保險桿**:紅 / 藍、隊號、隊徽圖片(印在保險桿上)
- **尺寸**:含保險桿的長 × 寬,碰撞和吸球口跟著變
- **底盤動力**:馬達(Kraken / Vortex / NEO / Falcon)、每邊幾顆、減速比、輪徑、車重、輪胎摩擦、電流限制 → 用真的直流馬達模型算加速、極速、打滑
- **電池**:開路電壓、內阻 → 全力加速時電壓會掉,太低會 Brownout(畫面左上角顯示電壓和底盤電流)

設定存在專案的 `.robot-sim.json`(`robot` 欄位,可以 commit 給隊友);模型檔和隊徽比較大,存在這台電腦的瀏覽器。

## 🔧 機構實驗室

模擬器上方按 **🔧 機構實驗室**(或直接開 `mechlab.html`),單獨模擬一個機構的馬達、電流和控制:

- **三種機構**:A 單關節旋轉手臂(重力矩 m·g·r·cos θ)、B 線性升降台(重力 + 滑軌摩擦)、C 雙輪飛輪(轉動慣量 + 風阻 + 射球掉速)
- **馬達資料庫**:Kraken X60(含 FOC)、NEO Vortex、NEO V1.1、Falcon 500,用官方 12 V 規格反推 R / kT / kV
- **傳動與保護**:馬達數量、減速比、齒輪箱效率(預設 85%)、定子 / 供電電流限制(超過就自動降電壓)、電壓爬升率
- **電池**:內阻造成電壓下降,低於 6.75 V 會 Brownout
- **控制**:跟 WPILib 一樣每 20 ms 跑一次 PID + 前饋(kS / kG / kV / kA)+ 梯形運動曲線;🧮 可以依物理模型自動算出理想前饋
- **圖表**:位置 / 轉速、電壓、電流、功率與發熱四張即時圖,可以匯出 CSV;另有上升時間、超越量、穩定時間、馬達溫度(估算)
- 手機、平板也能開

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
| `mechlab.html` `mechlab-core.js` `mechlab-ui.js` | 🔧 機構實驗室(`-core` 是物理和控制,node 也能跑) |
| `robotcustom.js` | 🤖 自訂機器人(模型、保險桿、尺寸、底盤馬達、電池) |
| `rapier.js` | 3D 物理引擎 [Rapier](https://rapier.rs)(Apache-2.0,WASM 打包成一個檔,離線可用) |
| `pathtracer.js` | 🌟 光線追蹤:[three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) + three-mesh-bvh(MIT)打包,讀本機的 three.js |
| `tests/` | 自動測試:`node tests/mechlab.test.js`、`node tests/drive.test.js`、`node tests/engine.test.js` |
| `robotmap.js` | ⚙️ 機構設定(讓任何程式都能對應) |
| `demo.js` `keyboard.js` | 展示模式、鍵盤操作 |
| `server.js` `sim-ws.gradle` | 小伺服器、讓 WPILib 模擬器接受網頁搖桿 |
| `app/` | 桌面軟體(Electron) |
| `assets/` | 官方場地 / KitBot 3D 模型(來自 [AdvantageScope](https://github.com/Mechanical-Advantage/AdvantageScopeAssets)) |

FRC 9427 · 2026
