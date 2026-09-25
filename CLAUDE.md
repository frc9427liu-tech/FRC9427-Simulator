# CLAUDE.md — 給下一個 Claude 的交接記憶

這份檔案 Claude Code 開 session 時會自動讀。使用者是 FRC 9427 隊(GitHub: frc9427liu-tech),用繁體中文溝通。
最後更新:2026-09-25(上一個 session 交接)

## 這是什麼
FRC9427-Simulator:**Electron 桌面 APP**(不是網頁!使用者很在意),用 Three.js + Rapier 物理跑比賽場地,
透過 NetworkTables 接 WPILib 模擬中的**真實機器人程式**(隊上的 LEO repo:`frc9427liu-tech/...LEO`,
`Robot.java` 用 `m_drive.tankDrive(-leftY, -rightY)`,DriveIOSim 把出力發到 `Drive/左 出力`、`Drive/右 出力`)。

## 使用者的態度(很重要)
- 要**真的有進步、有驗證**,討厭亂做。曾抱怨「亂做沒有進步 我 3050 可以亂閃」「這真的有讀取功能還是唬爛我」。
  → 每個功能都要實際跑(無頭 Chromium + Playwright 已裝好)重現問題、修、再驗證,回報時講實測數字。
- 目標:做得比 **MoSim**(mosimulator.com,Unity)更強、更客製化。優先順序:建模 → 物理引擎 → 光線追蹤。
- 使用者用 Claude 訂閱(有每週上限),在意成本 → 一次做一個階段,做完請他看 claude.ai Settings → Usage。
- 使用者自己 merge PR(自動模式不能沒審就 merge)。說「發布」= 跑 release workflow。

## 檔案地圖
| 檔案 | 內容 |
|---|---|
| `index.html` | 主頁。script 順序:robotmap.js → screen.js → mechlab-core.js → rapier.js → physics.js → robotcustom.js → view3d(module) |
| `screen.js` | 2D 場地、遊戲邏輯、HUD(電池/電流)、`MAX_HELD`、`resetGame` |
| `physics.js` | 底盤物理。`configure(body)` 讀車體設定;DC 馬達模型+齒輪+電流限制+電池;Rapier 引擎(`engineInit/engineRobot/engineDrive/engineBalls`,1/120 s,斜角凸包可爬 BUMP,摩擦 combine=Min);`drive()` 裡有 `REVERSE` 左右互換反向 |
| `mechlab-core.js` | 馬達資料庫(Kraken X60/FOC、Vortex、NEO、Falcon)、Battery(6.75 V brownout / 7.5 V 恢復)、Arm/Elevator/Flywheel、PID、FF、Trapezoid。node 可 require |
| `mechlab-ui.js` / `mechlab.html` | 🔧 機構實驗室(Electron 裡用 `openLab()` 開新視窗) |
| `robotcustom.js` | 車體客製化對話框(BODY):隊號、保險桿顏色、尺寸、🧩 機構藍圖拖拉(intake/shooter/hopper)、底盤(含「底盤前後反過來」`drive.reverse`)、電池、匯入模型(IndexedDB) |
| `view3d.js` | 3D 畫面、LOOK 系統(`applyLook/buildCustomBody/buildBumpers`)、🌟 光線追蹤(RT 區段) |
| `pathtracer.js` | three-gpu-pathtracer 0.0.23 + three-mesh-bvh 用 esbuild 打包(three 外部化成 `./three.module.min.js`) |
| `rapier.js` | @dimforge/rapier3d-compat 0.20 打包成 IIFE,全域 `RAPIER` |
| `robotmap.js` | 工具列、`.robot-sim.json` 讀寫(`save`)、畫質選單(含 rt) |
| `server.js` | 本機伺服器,`/api/project` |
| `app/` | Electron:`main.js`(openLab、setWindowOpenHandler)、`preload.js`、`start.html`、`package.json`(版本號在這) |
| `tests/` | `mechlab.test.js`、`drive.test.js`、`engine.test.js`(vm ctx 要給 performance、crypto)→ `node tests/xxx.test.js` |

## 光追(RT)已知坑
- 路徑追蹤器不支援 InstancedMesh → 球用固定 640 顆 mesh 池(refit 不 rebuild)。
- ShaderMaterial、basic 透明、**多材質 mesh**(會造成材質 index 偏移全部變黃)在 RT 時隱藏。
- 閃爍修法:`rtSnapshot/rtMoved` 門檻(1 cm、0.01 rad…)+ 靜止 0.5 s 才進 RT;RT 中跳過 `updateCamera`。除錯:`_rt()`、`_scene()`、`RT.enters`。
- 使用者 RTX 3050 上還**沒回報**修好後的實機效果。

## 發布流程
- `.github/workflows/release.yml`(windows-latest):workflow_dispatch 時自動用 `app/package.json` 版本建 tag → 測試 → `npm run release`(electron-builder NSIS + electron-updater,latest.yml)。
- 這個環境的 git proxy **不能推 tag** → 用 GitHub MCP `actions_run_trigger` 在 main 上 dispatch。
- 已發布:v2.1.0。PR #1、#2 已 merge。

## 目前狀態 / 待辦(依序)
1. **PR #3**(分支 `claude/hello-9rozaw`,版本 2.1.1:修光追亂閃 + 底盤反向選項)等使用者 merge → 他說「發布」就 dispatch release 並確認 v2.1.1 的 exe/blockmap/latest.yml 都在。
2. **等使用者回報 W 鍵方向**:他說「intake 在前面我要按後面才能前進」。已確認訊號鏈正負號正確;發現 KitBot CAD 的 Front Bumper 在 -X。依回報決定 `drive.reverse` 預設值或轉模型方向。
3. **等使用者說「開始」**,再做贏過 MoSim 的計畫:
   - ① **全物理球**:球從 intake → hopper(可選網狀/透明/實心外觀,真的堆疊 50+ 顆)→ indexer → shooter 連續球流(依飛輪、indexer 轉速);新相機「車上攝影機」「跟著球飛」。
   - ② **CAD 零件標記**:匯入的 Onshape/GLB 模型可指定哪塊是 intake/手臂/turret,讓它會動。
   - ③ **強隊車庫**(參考 MoSim 的 1114 Simbotics、4414 HighTide)。
   - ④ 場地細節:FIRST logo 球、屋頂桁架、贊助看板、隊旗。
   - 之後才是:場地磨損、3v3/淘汰賽、真人對戰、AI 分析、手機版。
4. 成本估計已告知使用者:全部約 80~250 美金(API 折算),建議一階段一階段做。

## 注意
- WebFetch 連不到 instagram.com、mosimulator.com(使用者會傳截圖)。
- 回 PR/commit 不要寫模型名稱。
