// ============================================================
//  9427 FRC 模擬器(桌面軟體版)
//  像 VS Code 一樣:打開先看到起始畫面 →「開啟機器人專案資料夾」或點最近開過的專案 →
//  自己跑那個專案的 gradlew simulateJava + 網頁伺服器 + 模擬畫面;關視窗就全部一起關。
//  任何隊伍的 GradleRIO 專案都能開,不用改他們的程式(sim-ws.gradle 是從外面加進去的)。
//  網頁本身(index.html、screen.js、view3d.js…)跟瀏覽器版是同一份。
// ============================================================
const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const SIM_PORT = 3300;
const DEFAULT_PROJECT = 'C:\\Users\\frc94\\Downloads\\FRC\\LEO';   // 第一次開時放進「最近開過」
const TITLE = '9427 FRC 模擬器';
// 打包後網頁檔放在 resources/web、伺服器程式放在 resources/server;開發時(npm start)就是上一層資料夾
const WEB_DIR = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..');
const SERVER_JS = app.isPackaged ? path.join(process.resourcesPath, 'server', 'server.js') : path.join(__dirname, '..', 'server.js');
const { createServer } = require(SERVER_JS);

let simStage = '';
let startWin = null, splash = null, win = null, simProc = null, server = null, webPort = 0;
let weStartedSim = false, quitting = false, switching = false, project = null;
let logPath = '';

// ---------- 只能開一個 ----------
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { const w = win || startWin || splash; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });

// ---------- 設定檔(最近開過的專案) ----------
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() { try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch { return {}; } }
function saveCfg(c) { try { fs.mkdirSync(path.dirname(cfgPath()), { recursive: true }); fs.writeFileSync(cfgPath(), JSON.stringify(c, null, 2)); } catch {} }

// GradleRIO 專案 = 有 gradlew.bat + build.gradle(build.gradle 裡通常有 edu.wpi.first.GradleRIO)
function checkProject(dir) {
  if (!dir || !fs.existsSync(path.join(dir, 'gradlew.bat')) || !fs.existsSync(path.join(dir, 'build.gradle')))
    return { ok: false, why: '裡面要有 gradlew.bat 和 build.gradle(WPILib 建立的機器人專案才有)。' };
  let gradle = '';
  try { gradle = fs.readFileSync(path.join(dir, 'build.gradle'), 'utf8'); } catch {}
  return { ok: true, warn: /edu\.wpi\.first\.GradleRIO/.test(gradle) ? '' : 'build.gradle 裡沒看到 GradleRIO,可能不是 FRC 專案' };
}
function recents() {
  const cfg = loadCfg();
  let list = Array.isArray(cfg.recents) ? cfg.recents : [];
  if (!cfg.seeded) {                 // 第一次開:LEO 在的話先放進去
    if (checkProject(DEFAULT_PROJECT).ok && !list.some(r => r.path === DEFAULT_PROJECT))
      list.push({ path: DEFAULT_PROJECT, name: path.basename(DEFAULT_PROJECT), last: 0 });
    saveCfg({ ...cfg, recents: list, seeded: true });
  }
  return list.map(r => ({ ...r, exists: checkProject(r.path).ok }));
}
function addRecent(dir) {
  const cfg = loadCfg();
  const list = (Array.isArray(cfg.recents) ? cfg.recents : []).filter(r => r.path.toLowerCase() !== dir.toLowerCase());
  list.unshift({ path: dir, name: path.basename(dir), last: Date.now() });
  saveCfg({ ...cfg, recents: list.slice(0, 8), seeded: true });
}
function removeRecent(dir) {
  const cfg = loadCfg();
  saveCfg({ ...cfg, recents: (cfg.recents || []).filter(r => r.path !== dir) });
}

// WPILib 的 JDK:C:\Users\Public\wpilib\<年份>\jdk,挑年份最新的
function findJdk() {
  const base = 'C:\\Users\\Public\\wpilib';
  let years = [];
  try { years = fs.readdirSync(base).filter(n => /^\d{4}$/.test(n)).sort((a, b) => b - a); } catch {}
  for (const y of years) {
    const jdk = path.join(base, y, 'jdk');
    if (fs.existsSync(path.join(jdk, 'bin', 'java.exe'))) return jdk;
  }
  return null;
}

// ---------- 小工具 ----------
function portOpen(port) {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = ok => { s.destroy(); res(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(800, () => done(false));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function say(msg, sub) {
  if (splash && !splash.isDestroyed()) splash.webContents.executeJavaScript(`setMsg(${JSON.stringify(msg)}, ${JSON.stringify(sub || '')})`).catch(() => {});
}
function logTail(n = 30) {
  try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(l => l.trim()).slice(-n).join('\n'); } catch { return ''; }
}
// 出錯:跳訊息,然後回到起始畫面(不是整個關掉,換個專案就好)
async function fail(title, detail) {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
  const r = await dialog.showMessageBox({ type: 'error', title: TITLE, message: title, detail,
    buttons: logPath && fs.existsSync(logPath) ? ['確定', '打開完整紀錄檔'] : ['確定'] });
  if (r.response === 1) await shell.openPath(logPath);
  stopSim();
  project = null;
  showStart();
}

// 佔用 3300 的程式(pid + 名字)
function simOwners() {
  const out = [];
  try {
    const ns = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    for (const line of ns.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && +m[1] === SIM_PORT) pids.add(m[2]);
    }
    for (const pid of pids) {
      const info = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      out.push({ pid, name: (info.trim().match(/^"([^"]+)"/) || [])[1] || '' });
    }
  } catch {}
  return out;
}
function killJavaOnSim() {
  for (const o of simOwners()) if (/^java/i.test(o.name)) { try { execFileSync('taskkill', ['/PID', o.pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
}

// ---------- 啟動模擬器(跑專案的 gradlew simulateJava) ----------
function startSim(dir, jdk) {
  logPath = path.join(app.getPath('userData'), 'simulator.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'w' });
  log.write(`[${new Date().toLocaleString('zh-TW')}] 專案=${dir}\nJAVA_HOME=${jdk}\n\n`);
  const gradlew = path.join(dir, 'gradlew.bat');         // 一定要絕對路徑(這台電腦的 cmd 不搜目前資料夾)
  const initScript = path.join(WEB_DIR, 'sim-ws.gradle');
  // .bat 要透過 cmd 跑;windowsHide = 不跳黑色視窗
  // cmd /s /c 會把「整串命令」最外面那一對引號拿掉,所以外面要再包一層,
  // 不然 gradlew 路徑的引號被吃掉 → 「檔案名稱、目錄名稱或磁碟區標籤語法錯誤」(2026-09-23 冷啟動實測)
  simProc = spawn('cmd.exe', ['/d', '/s', '/c', `""${gradlew}" simulateJava -I "${initScript}""`], {
    cwd: dir, env: { ...process.env, JAVA_HOME: jdk }, windowsHide: true, windowsVerbatimArguments: true,
  });
  weStartedSim = true;
  simProc.stdout.pipe(log, { end: false });
  simProc.stderr.pipe(log, { end: false });
  // 看 Gradle 輸出到哪一步,啟動畫面顯示「現在在做什麼」(使用者嫌乾等很久)
  simStage = '準備中(第一次開要啟動 Gradle,比較久)';
  simProc.stdout.on('data', buf => {
    const s = String(buf);
    if (/Task :compileJava(?! UP-TO-DATE)/.test(s)) simStage = '編譯你的程式…';
    else if (/Task :compileJava UP-TO-DATE/.test(s)) simStage = '程式沒改過,不用重新編譯 ✓';
    if (/Task :simulateJava/.test(s)) simStage = '啟動機器人程式…';
    if (/Robot program starting/.test(s)) simStage = '機器人程式開機中…';
  });
  const me = simProc;
  me.on('exit', code => { log.write(`\n[模擬器結束,代碼 ${code}]\n`); if (simProc === me) simProc = null; });
}

// ---------- 關模擬器:只關自己開的 ----------
function stopSim() {
  if (!weStartedSim) return;
  weStartedSim = false;
  if (simProc && simProc.pid) { try { execFileSync('taskkill', ['/PID', String(simProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
  simProc = null;
  // 模擬器本體(java)是 Gradle 開的,不一定在上面那棵程序樹裡 → 找佔用 3300 的程式,是 java 才關
  killJavaOnSim();
}
function cleanup() {
  if (server) { try { server.close(); } catch {} server = null; }
  stopSim();
}
app.on('will-quit', cleanup);
process.on('exit', cleanup);

// ---------- 網頁伺服器:8765 被佔(例如瀏覽器版 server.js 開著)就往後找空的 port ----------
async function startServer() {
  for (let port = 8765; port < 8785; port++) {
    const srv = createServer({ webDir: WEB_DIR, port, getProject: () => project, canSwitch: true, onSwitch: switchProject });
    const ok = await new Promise(res => { srv.once('error', () => res(false)); srv.listen(port, '0.0.0.0', () => res(true)); });
    if (ok) { webPort = port; return srv; }
  }
  return null;
}

// ---------- 起始畫面(像 VS Code 的歡迎頁) ----------
function showStart() {
  if (startWin && !startWin.isDestroyed()) { startWin.show(); startWin.focus(); return; }
  startWin = new BrowserWindow({
    // 一建立就顯示(深色底,不會閃白)。以前等 ready-to-show 才顯示,
    // 2026-09-23 使用者開一次就卡在「程式有跑、視窗一直沒出來」
    width: 960, height: 640, minWidth: 720, minHeight: 480, title: TITLE, backgroundColor: '#0d1117', show: true,
    icon: path.join(WEB_DIR, 'icon.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  startWin.on('page-title-updated', e => e.preventDefault());
  startWin.focus();
  // 起始畫面按 X = 整個關掉(正在開專案的時候例外)
  startWin.on('closed', () => { startWin = null; if (!win && !splash && !opening) app.quit(); });
  startWin.loadFile(path.join(__dirname, 'start.html'));
}

// 📖 新手教學(help.html,跟網頁檔放一起,由內建伺服器提供)
let helpWin = null;
ipcMain.handle('open-help', () => {
  if (helpWin && !helpWin.isDestroyed()) { helpWin.show(); helpWin.focus(); return; }
  helpWin = new BrowserWindow({ width: 1100, height: 820, title: '新手教學 · ' + TITLE, backgroundColor: '#0d1117', autoHideMenuBar: true,
                                icon: path.join(WEB_DIR, 'icon.ico') });
  helpWin.on('page-title-updated', e => e.preventDefault());
  helpWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  helpWin.on('closed', () => { helpWin = null; });
  helpWin.loadFile(path.join(WEB_DIR, 'help.html'));
});

ipcMain.handle('recents', () => recents());
ipcMain.handle('remove-recent', (_e, dir) => { removeRecent(dir); return recents(); });
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(startWin, { title: '選機器人專案資料夾(裡面要有 gradlew.bat)', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('open-project', async (_e, dir) => {
  const c = checkProject(dir);
  if (!c.ok) {
    await dialog.showMessageBox(startWin, { type: 'warning', title: TITLE, message: '這個資料夾不是機器人專案', detail: c.why });
    return { ok: false };
  }
  if (c.warn) {
    const r = await dialog.showMessageBox(startWin, { type: 'question', title: TITLE, message: c.warn, detail: '還是要試著開嗎?', buttons: ['開開看', '取消'] });
    if (r.response !== 0) return { ok: false };
  }
  openProject(dir);           // 不等:起始畫面會被關掉
  return { ok: true };
});

// ---------- 開專案 ----------
let opening = false;
async function openProject(dir) {
  if (opening) return;
  opening = true;
  try {
    const jdk = findJdk();
    if (!jdk) {
      await dialog.showMessageBox({ type: 'error', title: TITLE, message: '找不到 WPILib',
        detail: '這台電腦還沒裝 WPILib 2026。\n請先到 https://github.com/wpilibsuite/allwpilib/releases 下載安裝 WPILib,再打開模擬器。' });
      return;
    }
    // 3300 已經有別的模擬器在跑(不是我們開的)
    let connectOnly = false;
    if (await portOpen(SIM_PORT)) {
      const owners = simOwners();
      const isJava = owners.some(o => /^java/i.test(o.name));
      // 自動測試用:FRC_SIM_AUTOCHOICE=0/1/2 直接選(不跳視窗)
      const auto = process.env.FRC_SIM_AUTOCHOICE;
      const r = auto != null ? { response: +auto } : await dialog.showMessageBox(startWin, {
        type: 'warning', title: TITLE, message: '已經有一個模擬器在跑了',
        detail: `佔用 port ${SIM_PORT} 的程式:${owners.map(o => `${o.name}(${o.pid})`).join('、') || '不明'}\n\n` +
          '「直接連上」= 用正在跑的那個(它跑的不一定是你選的專案)\n「關掉它再開」= 關掉它,改跑你選的專案',
        buttons: ['直接連上', isJava ? '關掉它再開' : '關掉它再開(它不是 java,不能關)', '取消'], defaultId: 0, cancelId: 2,
      });
      if (r.response === 2) return;
      if (r.response === 1) {
        if (!isJava) return;
        killJavaOnSim();
        for (let i = 0; i < 20 && await portOpen(SIM_PORT); i++) await sleep(250);
      } else connectOnly = true;
    }
    project = dir;
    addRecent(dir);

    splash = new BrowserWindow({ width: 460, height: 260, frame: false, resizable: false, show: false, backgroundColor: '#0d1117',
                                 icon: path.join(WEB_DIR, 'icon.ico') });
    await splash.loadFile(path.join(__dirname, 'splash.html'));
    splash.show();
    if (startWin && !startWin.isDestroyed()) startWin.close();

    if (!connectOnly) {
      say('模擬器啟動中… 第一次約 30 秒', dir);
      startSim(dir, jdk);
      const t0 = Date.now();
      while (!(await portOpen(SIM_PORT))) {
        if (quitting) return;
        if (!simProc) return fail('模擬器啟動失敗(程式可能編譯不過)', `紀錄檔最後幾行:\n\n${logTail()}`);
        if (Date.now() - t0 > 180000) return fail('模擬器 3 分鐘都沒起來', `紀錄檔最後幾行:\n\n${logTail()}`);
        say(simStage, `已經 ${Math.round((Date.now() - t0) / 1000)} 秒`);
        await sleep(500);
      }
    }

    say('打開畫面…');
    win = new BrowserWindow({
      width: 1500, height: 900, show: false, title: `${TITLE} — ${path.basename(dir)}`, backgroundColor: '#0d1117',
      icon: path.join(WEB_DIR, 'icon.ico'), autoHideMenuBar: true,
      webPreferences: { backgroundThrottling: false },     // 視窗被擋住時也不要降速(模擬畫面要一直跑)
    });
    win.on('page-title-updated', e => e.preventDefault());
    // F11 全螢幕
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    });
    // 網頁上的外部連結用瀏覽器開,不要在這個視窗裡開
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    const reveal = () => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); if (splash && !splash.isDestroyed()) splash.destroy(); splash = null; };
    win.once('ready-to-show', reveal);
    setTimeout(reveal, 6000);    // ready-to-show 偶爾不會來(起始畫面就遇過),最多等 6 秒就直接顯示
    const me = win;
    // 使用者按 X = 整個關掉;換專案時是程式關的(me._switching),不能跟著關
    me.on('closed', () => { if (win === me) win = null; if (!me._switching) app.quit(); });
    await win.loadURL(`http://localhost:${webPort}/`);
  } finally {
    opening = false;
  }
}

// 網頁按「換專案」→ POST /api/switch-project → 關模擬器、關畫面、回到起始畫面
function switchProject() {
  switching = true;
  stopSim();
  project = null;
  showStart();                                   // 先開起始畫面,關掉模擬畫面時才不會「全部視窗都關了」
  if (win && !win.isDestroyed()) { win._switching = true; win.close(); }
  win = null;
  switching = false;
}

// ---------- 主流程 ----------
async function main() {
  Menu.setApplicationMenu(null);
  if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) {
    await dialog.showMessageBox({ type: 'error', title: TITLE, message: '程式檔案不完整', detail: `找不到 ${WEB_DIR}\\index.html` });
    return app.quit();
  }
  server = await startServer();
  if (!server) {
    await dialog.showMessageBox({ type: 'error', title: TITLE, message: '網頁伺服器開不起來', detail: 'port 8765~8784 都被佔用了。' });
    return app.quit();
  }
  showStart();
  warmGradle();
  checkUpdates();
}

// Gradle 暖機:起始畫面一打開,就在背景對「最近開的專案」跑一個什麼都不做的 Gradle 指令,
// 讓 Gradle daemon 先啟動。使用者選專案時就不用再等 daemon(剛開機時可省 10~20 秒)。
// 失敗也沒關係,只是沒暖到。
function warmGradle() {
  try {
    const first = recents().find(r => r.exists);
    const jdk = findJdk();
    if (!first || !jdk) return;
    const gradlew = path.join(first.path, 'gradlew.bat');
    const p = spawn('cmd.exe', ['/d', '/s', '/c', `""${gradlew}" --daemon -q help"`], {
      cwd: first.path, env: { ...process.env, JAVA_HOME: jdk }, windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore',
    });
    p.on('error', () => {});
  } catch {}
}

// ---------- 自動更新(GitHub Releases:frc9427liu-tech/FRC9427-Simulator) ----------
// 打開時背景檢查;有新版就自己下載,下載完問要不要現在重開更新(不重開的話,下次關掉時自動裝)。
// 沒網路、GitHub 連不到都不影響使用,安靜跳過。
function checkUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', () => {});
  autoUpdater.on('update-downloaded', async info => {
    const r = await dialog.showMessageBox({
      type: 'info', title: TITLE, buttons: ['現在重開更新', '等一下(關掉時自動更新)'], defaultId: 0, cancelId: 1,
      message: `新版本 ${info.version} 已經下載好了`,
      detail: '更新會重新開啟模擬器。正在操作的話可以先選「等一下」,關掉軟體時會自動裝好。',
    });
    if (r.response === 0) { cleanup(); autoUpdater.quitAndInstall(true, true); }
  });
  autoUpdater.checkForUpdates().catch(() => {});
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!switching && !opening) app.quit(); });
app.whenReady().then(main).catch(e => dialog.showErrorBox(TITLE, String(e && e.stack || e)));
