// ============================================================
//  模擬畫面:從上往下看場地 + 下方側面圖
//  讀的是 index.html 裡的 values(SmartDashboard 數值)、state(搖桿)、enabled、mode
// ============================================================
const FIELD_W = 16.54, FIELD_H = 8.07;         // 場地大小(公尺)
const TRACK = 0.62, MAX_SPEED = 4.0;           // 左右輪距、全速(示意值)
const TURRET_DEG_PER_ROT = 18;                 // 砲台:馬達 1 圈 = 18 度(示意,5 圈 = 90 度)
const ARM_DOWN_ROT = 10;                       // 手臂:跟 Constants 的 kDownLimitRotations 一樣
// HUB 中心:官方場地模型量的(藍方 HUB 本體 x 4.03~5.22 → 中心 4.625)
const HUBS = [{ x: 4.625, y: FIELD_H / 2, c: '#2f81f7' }, { x: FIELD_W - 4.625, y: FIELD_H / 2, c: '#f85149' }];
const HUB_R = 0.6;
const HUB_BLOCK = HUB_R + 0.43;                // 車中心離 HUB 中心最近只能到這裡(HUB 半徑 + 半個車身)

const canvas = document.getElementById('field');
let ctx = canvas.getContext('2d');
const mainCtx = ctx;
// 側面圖放在場地下面自己的小畫布,不要蓋住場地
const sideCanvas = document.createElement('canvas');
sideCanvas.style.cssText = 'width:100%;height:130px;display:block;margin-top:8px;border-radius:10px;background:#0d1117';
canvas.parentElement.after(sideCanvas);   // 放在 stage 外面(stage 裡是場地畫面)
const sideCtx = sideCanvas.getContext('2d');
// NaN / Infinity 也當 0,不然位置沾到一次 NaN 就永遠壞掉(紅隊發現)
const sd = k => { const v = values['/SmartDashboard/' + k]; return typeof v === 'number' && Number.isFinite(v) ? v : 0; };

// ---------- 遊戲狀態 ----------
const pose = { x: 2.2, y: FIELD_H / 2, th: 0 };
let fieldBalls = [], shots = [], marks = [], pops = [];
let held = 3, score = 0, missed = 0;
let wheelL = 0, wheelR = 0, spin = 0, flySpin = 0, lastT = performance.now(), lastShot = 0, lastMark = 0;
let follow = true;
const cam = { x: pose.x, y: pose.y, scale: 0 };
const MAX_HELD = 40;      // 車上最多幾顆(2026 的機器人都是大球籃)
const FIRE_MS = 100;      // 連發間隔(毫秒)
const HUB_TOP = 1.83;     // HUB 入口高度(公尺,官方模型漏斗頂 = 72 英寸)
let lastIntake = 0, lastIntakePop = 0, lastEmptyPop = 0, lastPublish = 0;
const BALL_R = 0.075;   // 跟 3D 一樣(2026 的球直徑約 15 公分)

function resetGame() {
  pose.x = 2.2; pose.y = FIELD_H / 2; pose.th = 0;
  held = 8; score = 0; missed = 0; shots = []; marks = []; pops = [];
  fieldBalls = [];
  if (typeof PHYS !== 'undefined') Object.assign(PHYS.state, { vL: 0, vR: 0, v: 0, w: 0 });
  // 官方場地模型載入後,開場的球照官方擺法放(456 顆)。
  // 場外補給站(OUTPOST)裡的球標成 fixed:物理不算它們,車也碰不到
  const staged = window.View3D && window.View3D.stagedFuel;
  if (staged && staged.length) {
    fieldBalls = staged.map(p => ({ x: p.x, y: p.y, vx: 0, vy: 0,
      fixed: p.x < 0 || p.y < 0 || p.x > FIELD_W || p.y > FIELD_H }));
    return;
  }
  // 還沒載入就先用自己排的:場上幾百顆球(用固定亂數種子,每次重來擺法都一樣)
  let seed = 9427;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const free = (x, y) => HUBS.every(h => Math.hypot(h.x - x, h.y - y) > HUB_R + 0.3) && Math.hypot(x - 2.2, y - FIELD_H / 2) > 1.0;
  // 中線那一大片排得整整齊齊的球海(跟 2026 REBUILT 真的場地一樣)
  const gap = BALL_R * 2 + 0.01;
  for (let x = FIELD_W / 2 - 0.7; x <= FIELD_W / 2 + 0.7; x += gap)
    for (let y = 1.3; y <= FIELD_H - 1.3; y += gap)
      fieldBalls.push({ x: x + (rnd() - 0.5) * 0.01, y: y + (rnd() - 0.5) * 0.01 });
  // 其他地方散一些
  const target = fieldBalls.length + 160;
  while (fieldBalls.length < target) {
    const x = 0.4 + rnd() * (FIELD_W - 0.8), y = 0.4 + rnd() * (FIELD_H - 0.8);
    if (free(x, y)) fieldBalls.push({ x, y });
  }
}
resetGame();
// 官方場地載入完成 → 換成官方的球擺法(只在還沒開始玩的時候換,免得打斷)
window.addEventListener('view3d-field-loaded', () => { if (score === 0 && missed === 0) resetGame(); });

// ---------- 畫面上方的按鈕 ----------
let view = '3d', camMode = 'chase', mounted3d = false;
document.getElementById('resetPose').onclick = resetGame;
document.querySelectorAll('#viewSeg button').forEach(b => b.onclick = () => {
  view = b.dataset.v;
  document.querySelectorAll('#viewSeg button').forEach(x => x.classList.toggle('sel', x === b));
});
document.querySelectorAll('#camSeg button').forEach(b => b.onclick = () => {
  camMode = b.dataset.c;
  follow = camMode === 'chase' || camMode === 'fpv';    // 2D:跟車/第一人稱 = 跟隨,全場/轉播 = 看全場
  if (window.View3D && mounted3d) window.View3D.setCamera(camMode);
  document.querySelectorAll('#camSeg button').forEach(x => x.classList.toggle('sel', x === b));
});
document.getElementById('fullBtn').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen(); else stageEl.requestFullscreen().catch(() => {});
};
// 3D 還沒載入好(或電腦不支援 WebGL)就先用 2D
function set3dVisible(on) {
  canvas.style.visibility = on ? 'hidden' : 'visible';
  const c3 = [...stageEl.querySelectorAll('canvas')].find(c => c !== canvas);
  if (c3) c3.style.visibility = on ? 'visible' : 'hidden';
}

// ---------- 地毯紋理(只做一次) ----------
const carpet = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#3b424a'; g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 2600; i++) {
    const v = 50 + Math.random() * 30;
    g.fillStyle = `rgba(${v},${v + 4},${v + 10},0.35)`;
    g.fillRect(Math.random() * 128, Math.random() * 128, 1.2, 1.2);
  }
  return c;
})();
let carpetPattern = null;

function resize() {
  const r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d);
}
window.addEventListener('resize', resize);

// ============================================================
//  每一幀
// ============================================================
function frame(t) {
  // physics.js 在 screen.js 後面載入;第一幀可能比它早跑 → 以前直接 ReferenceError,整個畫面停住(2026-09-23 實測)
  if (typeof PHYS === 'undefined') { lastT = t; requestAnimationFrame(frame); return; }
  // 任何一幀出錯都不能讓畫面永遠停住:錯誤印出來,下一幀照跑
  try { frameBody(t); } catch (e) { console.error('[模擬畫面] 這一幀出錯:', e); }
  requestAnimationFrame(frame);
}
function frameBody(t) {
  // 時間倒退(dt < 0)物理會整個爆掉(實測車子被彈到 HUB 另一邊),所以夾在 0 ~ 0.05 秒
  const dt = Math.max(0, Math.min(0.05, (t - lastT) / 1000)); lastT = Math.max(lastT, t);
  if (!canvas.width || Math.abs(canvas.width - canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1)) > 2) resize();

  // --- 從模擬器讀回來的數值 ---
  // 哪個數值是哪個機構,由 robotmap.js 決定(⚙️ 機構設定;LEO 有內建預設)
  const L = ROBOT.driveL(), R = ROBOT.driveR();
  const arm = ROBOT.armFrac();
  const turret = ROBOT.turretRad();
  const fly = ROBOT.fly(), orbit = ROBOT.orbit(), idx = ROBOT.idx();
  const rollerDir = ROBOT.intakeDir(state[1].buttons);

  // --- 底盤:有質量、有加速度、會被牆/HUB/TOWER 擋住(physics.js) ---
  const ds = PHYS.drive(L, R, dt);
  const vL = ds.vL, vR = ds.vR, v = ds.v, w = ds.w;
  wheelL += vL * dt; wheelR += vR * dt;
  spin += dt * orbit * 0.15;
  flySpin += dt * fly * 0.6;

  // 輪胎痕
  if ((Math.abs(v) > 0.3 || Math.abs(w) > 1) && t - lastMark > 60) {
    lastMark = t;
    const c = Math.cos(pose.th), s = Math.sin(pose.th);
    for (const side of [-1, 1]) marks.push({ x: pose.x - s * side * 0.33, y: pose.y - c * side * 0.33, life: 3 });
  }
  for (const k of marks) k.life -= dt;
  while (marks.length && marks[0].life <= 0) marks.shift();

  // --- 地上的球:滾動、互相推擠、被車撞開;手臂放下 + 滾輪吸 → 車頭前面的球吸進來 ---
  const fx = pose.x + Math.cos(pose.th) * (0.45 + arm * 0.3), fy = pose.y - Math.sin(pose.th) * (0.45 + arm * 0.3);
  PHYS.balls(dt, t, arm, rollerDir, () => {
    held++;
    if (t - lastIntakePop > 700) { pops.push({ x: fx, y: fy, txt: `+球 (${held})`, c: '#3fb950', life: 0.8 }); lastIntakePop = t; }
  });
  // 吐球:從車頭往前滾出去
  if (rollerDir < 0 && held > 0 && t - lastShot > 150) {
    lastShot = t; held--;
    const c = Math.cos(pose.th), s = Math.sin(pose.th), j = (Math.random() - 0.5) * 0.4;
    fieldBalls.push({ x: fx + c * 0.1 + s * j * 0.3, y: fy - s * 0.1 + c * j * 0.3,
                      vx: c * (1.8 + v) + s * j, vy: -s * (1.8 + v) + c * j });
  }

  // --- 發射:飛輪夠快 + Indexer 在送 + 車上有球 → 連發 ---
  const aim = pose.th + turret;
  // 落點預測:飛輪有在轉就算出球會掉在哪,畫一個圈 + 告訴駕駛要往前還往後
  // (以前看不出射程,從起點射 8 顆全沒進也不知道為什麼)
  const aimPt = Math.abs(fly) > 5 ? predictLanding(aim, fly) : null;
  if (Math.abs(fly) > 5 && ROBOT.feeding() && t - lastShot > FIRE_MS) {
    lastShot = t;
    if (held > 0) {
      held--;
      // 真的拋物線:出球速度 = 飛輪轉速 × 比例,有重力、空氣阻力,還會帶著車速;一點點散布
      shots.push(Object.assign(PHYS.launch(aim, fly, true), { robot: true }));
    } else if (t - lastEmptyPop > 1500) {
      lastEmptyPop = t;
      pops.push({ x: pose.x, y: pose.y - 0.6, txt: '沒球了', c: '#d29922', life: 0.9 });
    }
  }
  PHYS.flights(dt, t, hub => {
    score++; hub.flash = 0.6;
    if (t - (hub.lastPop || 0) > 600) { pops.push({ x: hub.x, y: hub.y - 0.8, txt: `進球! ${score}`, c: '#3fb950', life: 1.2 }); hub.lastPop = t; }
  }, () => { missed++; });
  for (const p of pops) { p.life -= dt; p.y -= dt * 0.4; }
  pops = pops.filter(p => p.life > 0);
  for (const hh of HUBS) if (hh.flash) hh.flash = Math.max(0, hh.flash - dt);

  // --- 鏡頭 ---
  const W = canvas.width, H = canvas.height;
  const full = Math.min(W / FIELD_W, H / FIELD_H), near = W / 5;
  const target = follow ? near : full;
  cam.scale = cam.scale ? cam.scale + (target - cam.scale) * Math.min(1, dt * 5) : target;
  const halfW = W / 2 / cam.scale, halfH = H / 2 / cam.scale;
  const tx = follow ? Math.min(FIELD_W - halfW, Math.max(halfW, pose.x)) : FIELD_W / 2;
  const ty = follow ? Math.min(FIELD_H - halfH, Math.max(halfH, pose.y)) : FIELD_H / 2;
  cam.x += (tx - cam.x) * Math.min(1, dt * 6); cam.y += (ty - cam.y) * Math.min(1, dt * 6);
  const S = cam.scale;

  const st = { L, R, arm, turret, fly, orbit, idx, rollerDir, aim, aimPt };
  lastAim = aimPt;
  const use3d = view === '3d' && window.View3D;
  if (use3d) {
    if (!mounted3d) { window.View3D.mount(stageEl); window.View3D.setCamera(camMode); mounted3d = true; }
    window.View3D.render({
      pose, arm, turret, fly, flySpin, orbitSpin: spin, rollerDir, held, fieldBalls, shots,
      enabled, hubs: HUBS, wheelL, wheelR, time: t, aimPt, hubTop: HUB_TOP,
    });
    updatePops3D();
  } else {
    draw(W, H, S, st);
    clearPopEls();
  }
  set3dVisible(use3d);
  drawSide(st);
  updateHud();
  // 每 50ms 把位置和球發到 NetworkTables,給 AdvantageScope 的官方 3D 場地用
  if (t - lastPublish > 50 && window.publishSimToNT) { lastPublish = t; window.publishSimToNT(pose, fieldBalls, shots); }
  renderLegend(L, R, arm, fly, orbit, idx, rollerDir);
}

// ---------- 射程 ----------
// 用 physics.js 同一套拋物線(重力 + 空氣阻力 + 車速 + 網子)模擬一顆不帶散布的球
function predictLanding(aim, fly) {
  const p = PHYS.predict(aim, fly);
  const x = p.x, y = p.y, d = Math.hypot(x - pose.x, y - pose.y);
  const hub = p.good;
  // 離最近的 HUB 還差多少:沿著砲口方向,把「車到 HUB 的距離」跟「射程」相減
  const near = HUBS.reduce((a, b) => Math.hypot(b.x - pose.x, b.y - pose.y) < Math.hypot(a.x - pose.x, a.y - pose.y) ? b : a);
  const toHub = Math.hypot(near.x - pose.x, near.y - pose.y);
  // 砲口有沒有大致對著 HUB(差 25 度以內才給前後建議,不然先叫他轉砲台)
  const bearing = Math.atan2(-(near.y - pose.y), near.x - pose.x);
  const off = Math.abs(Math.atan2(Math.sin(bearing - aim), Math.cos(bearing - aim)));
  return { x, y, good: !!hub, range: d, toHub, facing: off < 0.44 };
}

// ============================================================
//  畫圖
// ============================================================
function draw(W, H, S, st) {
  const d = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, W, H);

  // 世界座標 → 畫面
  ctx.setTransform(S, 0, 0, S, W / 2 - cam.x * S, H / 2 - cam.y * S);
  const px = 1 / S;   // 1 個畫面像素 = 幾公尺

  // 地毯
  if (!carpetPattern) carpetPattern = ctx.createPattern(carpet, 'repeat');
  ctx.save(); ctx.scale(0.01, 0.01); ctx.fillStyle = carpetPattern; ctx.fillRect(0, 0, FIELD_W * 100, FIELD_H * 100); ctx.restore();

  // 聯盟區、線
  ctx.fillStyle = 'rgba(47,129,247,0.10)'; ctx.fillRect(0, 0, 3.98, FIELD_H);
  ctx.fillStyle = 'rgba(248,81,73,0.10)'; ctx.fillRect(FIELD_W - 3.98, 0, 3.98, FIELD_H);
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = '#2f81f7'; line(3.98, 0, 3.98, FIELD_H);
  ctx.strokeStyle = '#f85149'; line(FIELD_W - 3.98, 0, FIELD_W - 3.98, FIELD_H);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; line(FIELD_W / 2, 0, FIELD_W / 2, FIELD_H);
  ctx.beginPath(); ctx.arc(FIELD_W / 2, FIELD_H / 2, 1.2, 0, 7); ctx.stroke();
  // 牆
  ctx.lineWidth = 0.12; ctx.strokeStyle = '#9fb3c8'; ctx.strokeRect(-0.06, -0.06, FIELD_W + 0.12, FIELD_H + 0.12);
  ctx.lineWidth = 0.04; ctx.strokeStyle = '#ffffff22'; ctx.strokeRect(0.05, 0.05, FIELD_W - 0.1, FIELD_H - 0.1);

  // 輪胎痕
  ctx.fillStyle = '#000';
  for (const k of marks) { ctx.globalAlpha = Math.min(0.25, k.life / 12); ctx.fillRect(k.x - 0.03, k.y - 0.03, 0.06, 0.06); }
  ctx.globalAlpha = 1;

  // 目標(Hub)
  for (const hh of HUBS) {
    ctx.save(); ctx.translate(hh.x, hh.y);
    ctx.fillStyle = '#00000055'; hex(0.06, 0.06, HUB_R + 0.05); ctx.fill();
    ctx.fillStyle = '#1c2530'; hex(0, 0, HUB_R + 0.05); ctx.fill();
    ctx.lineWidth = 0.06; ctx.strokeStyle = hh.c; hex(0, 0, HUB_R); ctx.stroke();
    ctx.fillStyle = hh.flash ? `rgba(63,185,80,${0.2 + hh.flash})` : '#0e141b'; hex(0, 0, HUB_R * 0.62); ctx.fill();
    ctx.strokeStyle = '#ffffff33'; ctx.lineWidth = 0.02; hex(0, 0, HUB_R * 0.62); ctx.stroke();
    ctx.restore();
  }

  // 場上的球
  for (const b of fieldBalls) ball(b.x, b.y, BALL_R, 0);

  // 落點預測圈(畫在車子底下,飛行中的球在上面)
  if (st.aimPt) {
    const a = st.aimPt, col = a.good ? '#3fb950' : '#d29922';
    ctx.setLineDash([0.12, 0.08]); ctx.lineWidth = 0.025; ctx.strokeStyle = col + '88';
    line(pose.x, pose.y, a.x, a.y); ctx.setLineDash([]);
    ctx.lineWidth = 0.05; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(a.x, a.y, 0.28, 0, 7); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(a.x, a.y, 0.06, 0, 7); ctx.fill();
  }

  drawRobot(st, px);

  // 飛行中的球(越高越大,影子留在地上)
  for (const b of shots) {
    const h = b.z || 0;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(b.x + h * 0.15, b.y + h * 0.15, 0.08, 0.06, 0, 0, 7); ctx.fill();
    ball(b.x, b.y - h * 0.25, 0.09 + h * 0.035, 0);
  }

  // 飄字
  for (const p of pops) {
    ctx.globalAlpha = Math.min(1, p.life * 2);
    worldText(p.txt, p.x, p.y, 16 * d * px, p.c, 'bold');
  }
  ctx.globalAlpha = 1;

}

// 側面圖(2D、3D 都畫)
function drawSide(st) {
  const d = window.devicePixelRatio || 1;
  const sr = sideCanvas.getBoundingClientRect();
  if (sideCanvas.width !== Math.round(sr.width * d)) { sideCanvas.width = Math.round(sr.width * d); sideCanvas.height = Math.round(sr.height * d); }
  ctx = sideCtx; ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawSideView(sideCanvas.width, sideCanvas.height, d, st);
  ctx = mainCtx;
}

// ---------- 畫面上的 HUD、RSL 燈、飄字(用 HTML 疊在畫面上,2D/3D 共用) ----------
const hudEl = document.getElementById('hud'), rslEl = document.getElementById('rsl'), stageEl = document.getElementById('stage');
let hudT = 0, lastAim = null;
// 射擊提示:飛輪有轉才出現。落點在 HUB 裡 = 綠;差多少就叫他往前/往後
function aimHint(a) {
  if (!a) return '';
  if (a.good) return `<div style="color:#3fb950">🎯 瞄準 OK,落點在 HUB 裡 —— 可以發射(A)</div>`;
  if (!a.facing) return `<div style="color:#d29922">↻ 砲口沒對準 HUB:轉砲台(操作手左搖桿左右)或轉車頭</div>`;
  const diff = a.toHub - a.range;   // > 0:球會落在 HUB 前面 → 要往前開
  return `<div style="color:#d29922">${diff > 0 ? '⬆ 往前開' : '⬇ 往後退'} ${Math.abs(diff).toFixed(1)} 公尺`
    + `(離 HUB ${a.toHub.toFixed(1)} m,這個轉速射程 ${a.range.toFixed(1)} m)</div>`;
}
function updateHud() {
  const now = performance.now();
  rslEl.classList.toggle('on', !enabled || Math.floor(now / 250) % 2 === 0);  // 停用恆亮、啟用閃爍
  if (now - hudT < 100) return; hudT = now;
  const modeTxt = { teleop: '遙控', auto: '自動', test: '測試' }[mode];
  // 超過極限警告:軟限位還沒打開時,模擬器裡的手臂/砲台會一直轉下去,真的機器人就是撞壞
  const armOver = ROBOT.armOver(), turDeg = ROBOT.turretRad() * 180 / Math.PI;
  const warns = [];
  if (armOver) warns.push(`⚠️ 手臂跑到 ${armOver.toFixed(1)},超過行程!真的機器人會撞壞`);
  if (Math.abs(turDeg) > 100) warns.push(`⚠️ 砲台轉了 ${turDeg.toFixed(0)}°,超過極限!線會被扯斷`);
  hudEl.innerHTML =
    `<div style="color:${enabled ? '#3fb950' : '#8b98a5'}">${modeTxt}・${enabled ? '啟用中' : '停用'}</div>` +
    `<div>🏀 車上 ${held}/${MAX_HELD} &nbsp; 🎯 進球 ${score} &nbsp; ✖ ${missed}</div>` +
    aimHint(lastAim) +
    warns.map(w => `<div class="warn">${w}</div>`).join('');
}
const popEls = new Map();
function updatePops3D() {
  for (const p of pops) {
    let el = popEls.get(p);
    if (!el) { el = document.createElement('div'); el.className = 'pop'; el.textContent = p.txt; el.style.color = p.c; stageEl.append(el); popEls.set(p, el); }
    const s = window.View3D.project(p.x, p.y, 1.2 + (1.2 - p.life));
    el.style.display = s.visible ? '' : 'none';
    el.style.left = s.x + 'px'; el.style.top = s.y + 'px'; el.style.opacity = Math.min(1, p.life * 2);
  }
  for (const [p, el] of popEls) if (!pops.includes(p)) { el.remove(); popEls.delete(p); }
}
function clearPopEls() { for (const el of popEls.values()) el.remove(); popEls.clear(); }

function drawRobot(st, px) {
  const { arm, turret, fly, orbit, rollerDir } = st;
  ctx.save();
  ctx.translate(pose.x, pose.y);
  ctx.rotate(-pose.th);

  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.45)'; roundRect(-0.43 + 0.06, -0.43 + 0.08, 0.86, 0.86, 0.05); ctx.fill();

  // Intake(車頭,x 正方向):放下越多伸越長
  const armLen = 0.06 + arm * 0.28;
  ctx.fillStyle = '#56606b'; ctx.fillRect(0.38, -0.36, armLen, 0.06); ctx.fillRect(0.38, 0.30, armLen, 0.06);
  for (const k of [0.45, 1]) {
    const rx = 0.38 + armLen * k - 0.035;
    ctx.fillStyle = rollerDir ? (rollerDir > 0 ? '#3fb950' : '#d29922') : '#8b98a5';
    ctx.fillRect(rx, -0.33, 0.07, 0.66);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 0.012;
    const off = ((wheelL * 0 + performance.now() / 1000 * 3 * rollerDir) % 0.1 + 0.1) % 0.1;
    for (let yy = -0.33 + off; yy < 0.33; yy += 0.1) line(rx, yy, rx + 0.07, yy + 0.03);
  }

  // 輪子(每邊 3 顆,紋路跟著輪子轉)
  for (const side of [-1, 1]) {
    const dist = side > 0 ? wheelR : wheelL;   // 車頭朝 +x、畫面 y 往下,所以 +1 是右邊
    for (const wx of [-0.27, 0, 0.27]) {
      ctx.fillStyle = '#111'; roundRect(wx - 0.08, side * 0.3 - 0.035, 0.16, 0.07, 0.02); ctx.fill();
      ctx.strokeStyle = '#444'; ctx.lineWidth = 0.01;
      const off = ((-dist % 0.04) + 0.04) % 0.04;
      for (let xx = wx - 0.08 + off; xx < wx + 0.08; xx += 0.04) line(xx, side * 0.3 - 0.035, xx, side * 0.3 + 0.035);
    }
  }

  // 車架
  ctx.fillStyle = '#6e7781'; roundRect(-0.36, -0.26, 0.72, 0.52, 0.02); ctx.fill();
  ctx.fillStyle = '#2b3138'; ctx.fillRect(-0.33, -0.23, 0.66, 0.46);
  ctx.fillStyle = '#6e7781'; ctx.fillRect(-0.02, -0.23, 0.04, 0.46); ctx.fillRect(-0.33, -0.02, 0.66, 0.04);

  // 保險桿(紅色,印隊號)
  ctx.fillStyle = enabled ? '#c8102e' : '#9b1c2c';
  const b = 0.43, t = 0.085;
  roundRect(-b, -b, 2 * b, t, 0.03); ctx.fill(); roundRect(-b, b - t, 2 * b, t, 0.03); ctx.fill();
  roundRect(-b, -b, t, 2 * b, 0.03); ctx.fill(); roundRect(b - t, -b, t, 0.1, 0.02); ctx.fill(); roundRect(b - t, b - 0.1, t, 0.1, 0.02); ctx.fill();
  worldText('9427', 0, -b + t / 2, 0.07, '#fff', 'bold', 'Arial');
  worldText('9427', 0, b - t / 2, 0.07, '#fff', 'bold', 'Arial');

  // Orbit 轉盤 + 車上的球
  ctx.fillStyle = '#161b22'; ctx.beginPath(); ctx.arc(-0.08, 0, 0.19, 0, 7); ctx.fill();
  ctx.strokeStyle = Math.abs(orbit) > 0.5 ? '#4da3ff' : '#4a5767'; ctx.lineWidth = 0.02; ctx.stroke();
  // 車上的球:最多畫 3 圈(內 5、中 9、外 13 顆),看得出滿不滿就好
  const rings = [[0.05, 5], [0.1, 9], [0.15, 13]];
  let left = Math.round(Math.min(held, MAX_HELD) / MAX_HELD * 27);
  for (const [rr, n] of rings) {
    for (let i = 0; i < n && left > 0; i++, left--) {
      const a = spin * (rr > 0.08 ? -1 : 1) + i * Math.PI * 2 / n;
      ball(-0.08 + Math.cos(a) * rr, Math.sin(a) * rr, 0.035, 0, true);
    }
  }

  // Turret 砲台
  ctx.save();
  ctx.translate(0.12, 0);
  ctx.rotate(-turret);
  if (Math.abs(fly) > 5) { ctx.shadowColor = '#f0883e'; ctx.shadowBlur = 25 * (window.devicePixelRatio || 1); }
  ctx.fillStyle = '#39424d'; ctx.beginPath(); ctx.arc(0, 0, 0.13, 0, 7); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = Math.abs(fly) > 5 ? '#f0883e' : '#8b98a5';
  roundRect(0, -0.055, 0.3, 0.11, 0.02); ctx.fill();
  ctx.fillStyle = '#161b22'; ctx.fillRect(0.24, -0.035, 0.06, 0.07);
  // 飛輪(在砲台上轉)
  ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 0.012;
  for (let k = 0; k < 4; k++) { const a = flySpin + k * Math.PI / 2; line(0, 0, Math.cos(a) * 0.09, Math.sin(a) * 0.09); }
  ctx.restore();

  ctx.restore();
}

// 側面圖(場地下面那條):手臂角度、飛輪
function drawSideView(W, H, d, st) {
  const w = W, h = H, x0 = 0, y0 = 0;
  ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#8b98a5'; ctx.font = `${11 * d}px "Microsoft JhengHei", sans-serif`;
  ctx.fillText('側面圖', x0 + 8 * d, y0 + 15 * d);

  const u = h / 1.0;                 // 1 公尺 = u 像素
  const gx = x0 + w * 0.3, gy = y0 + h * 0.88;
  ctx.strokeStyle = '#4a5767'; ctx.lineWidth = 1 * d; lineP(x0 + 6 * d, gy, x0 + w - 6 * d, gy);
  // 車身
  ctx.fillStyle = '#c8102e'; ctx.fillRect(gx - 0.43 * u, gy - 0.2 * u, 0.86 * u, 0.1 * u);
  ctx.fillStyle = '#2b3138'; ctx.fillRect(gx - 0.36 * u, gy - 0.45 * u, 0.72 * u, 0.25 * u);
  for (const wx of [-0.27, 0, 0.27]) {
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(gx + wx * u, gy - 0.05 * u, 0.05 * u, 0, 7); ctx.fill();
  }
  // Intake 手臂:收起 = 往上立著(約 100 度),放下 = 平伸出去
  const pivX = gx + 0.36 * u, pivY = gy - 0.42 * u;
  const ang = (1 - st.arm) * (Math.PI * 0.55) - 0.12;   // 0 = 水平往前
  const ax = pivX + Math.cos(ang) * 0.42 * u, ay = pivY + Math.sin(-ang) * 0.42 * u + st.arm * 0.2 * u;
  ctx.strokeStyle = '#8b98a5'; ctx.lineWidth = 0.05 * u; ctx.lineCap = 'round'; lineP(pivX, pivY, ax, ay); ctx.lineCap = 'butt';
  ctx.fillStyle = st.rollerDir ? (st.rollerDir > 0 ? '#3fb950' : '#d29922') : '#56606b';
  ctx.beginPath(); ctx.arc(ax, ay, 0.05 * u, 0, 7); ctx.fill();
  ctx.fillStyle = '#e6edf3'; ctx.beginPath(); ctx.arc(pivX, pivY, 0.02 * u, 0, 7); ctx.fill();
  // 砲台 + 飛輪
  const fxp = gx + 0.1 * u, fyp = gy - 0.62 * u;
  ctx.fillStyle = '#39424d'; ctx.fillRect(gx - 0.05 * u, gy - 0.62 * u, 0.3 * u, 0.17 * u);
  ctx.fillStyle = '#161b22'; ctx.beginPath(); ctx.arc(fxp, fyp, 0.09 * u, 0, 7); ctx.fill();
  const on = Math.abs(st.fly) > 5;
  ctx.strokeStyle = on ? '#f0883e' : '#6e7781'; ctx.lineWidth = 0.015 * u;
  ctx.beginPath(); ctx.arc(fxp, fyp, 0.09 * u, 0, 7); ctx.stroke();
  for (let k = 0; k < 5; k++) { const a = flySpin + k * Math.PI * 2 / 5; lineP(fxp, fyp, fxp + Math.cos(a) * 0.08 * u, fyp + Math.sin(a) * 0.08 * u); }
  // 標籤
  ctx.font = `${14 * d}px "Microsoft JhengHei", sans-serif`; ctx.fillStyle = '#e6edf3';
  ctx.fillText(st.arm > 0.95 ? '手臂:放下' : st.arm < 0.05 ? '手臂:收起' : `手臂:${Math.round(st.arm * 100)}%`, x0 + w * 0.64, y0 + h * 0.45);
  ctx.textAlign = 'left';
  ctx.fillStyle = on ? '#f0883e' : '#8b98a5';
  ctx.fillText(`飛輪:${Math.abs(st.fly).toFixed(0)} 圈/秒`, x0 + w * 0.64, y0 + h * 0.7);
  ctx.textAlign = 'left';
}

// ---------- 小工具 ----------
// 在世界座標寫字(canvas 的字不能小於 1px,所以先放大再縮回來)
function worldText(s, x, y, size, color, weight, family) {
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 20, size / 20);
  ctx.font = `${weight || ''} 20px ${family || '"Microsoft JhengHei", sans-serif'}`;
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(s, 0, 0); ctx.restore();
}
function line(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
const lineP = line;
function hex(x, y, r) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } ctx.closePath(); }
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
const roundRectPx = roundRect;
function ball(x, y, r, _, noShadow) {
  if (!noShadow) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(x + r * 0.3, y + r * 0.3, r, 0, 7); ctx.fill(); }
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, '#fff3b0'); g.addColorStop(0.5, '#f2c12e'); g.addColorStop(1, '#a8800f');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
}
function hudBox(x, y, lines, fs) {
  const pad = fs * 0.6, lh = fs * 1.45;
  const w = Math.max(...lines.map(([s]) => ctx.measureText(s).width)) + pad * 2;
  ctx.fillStyle = 'rgba(13,17,23,0.8)'; roundRectPx(x, y, w, lh * lines.length + pad, fs * 0.5); ctx.fill();
  lines.forEach(([s, c], i) => { ctx.fillStyle = c; ctx.fillText(s, x + pad, y + pad / 2 + lh * (i + 0.72)); });
}

resize();
requestAnimationFrame(frame);
