// ============================================================
//  展示模式:虛擬駕駛自己開車 → 吸球 → 開到射擊點 → 對準 → 射球,一直循環
//  重點:它是「按搖桿」,不是直接移動畫面上的車。
//  搖桿訊號照樣送進模擬器,LEO 程式算出馬達出力,畫面再照出力動 —— 跟真人用手把一模一樣。
//  讀 screen.js / index.html 的全域:pose, held, fieldBalls, HUBS, state, BTN, enabled, setEnabled, sd
// ============================================================
(() => {
  const btn = document.createElement('button');
  btn.id = 'demoBtn';
  btn.textContent = '🎬 展示模式';
  btn.title = '虛擬駕駛自動操作 LEO 程式:吸球 → 對準 → 射球。再按一次、按空白鍵或停用就停下';
  document.getElementById('resetPose').before(btn);

  let on = false, phase = 'idle', phaseT = 0, target = null, stuckT = 0, lastDist = 1e9, spotIdx = 0;
  const hint = document.createElement('div');
  hint.className = 'demo-tag';
  document.getElementById('stage').append(hint);

  const drv = () => state[0], op = () => state[1];
  function release() {
    for (const s of state) { s.axes.fill(0); s.buttons.fill(false); s.pov.u = s.pov.d = s.pov.l = s.pov.r = 0; }
  }
  function setPhase(p) { phase = p; phaseT = performance.now(); stuckT = performance.now(); lastDist = 1e9; }
  function start() {
    if (!halOk) { toast('⚠️ 模擬器還沒連上,等一下再按'); return; }
    if (!ROBOT.demoOK) { toast('展示模式是照 LEO 的按鍵寫的,這個專案不能用'); return; }
    on = true; release(); setEnabled(true); setPhase('armDown');
    btn.classList.add('on'); btn.textContent = '⏹ 停止展示';
  }
  function stop(msg) {
    if (!on) return;
    on = false; release(); phase = 'idle';
    btn.classList.remove('on'); btn.textContent = '🎬 展示模式';
    hint.textContent = ''; hint.style.display = 'none';
    if (msg) toast(msg);
  }
  btn.onclick = () => on ? stop() : start();
  window.demoMode = { start, stop, get phase() { return phase; }, get on() { return on; } };

  // 手臂:LEO 的 ▲▼ 是「按著就一直轉」(約 25 圈/秒,軟限位還沒開),
  // 而且位置從模擬器傳回來有延遲 → 不能「看到到了才放開」,會一路轉過頭(實測轉到 -444 圈)。
  // 改成「點一下 → 放開 → 等 0.4 秒讀位置 → 再點」,每次按多久照距離算,幾次就收斂
  const ARM_RPS = 25;
  let tapUntil = 0, nextTap = 0, tapDir = 0;
  function armTo(lo, hi) {
    const now = performance.now(), p = op().pov;
    if (now < tapUntil) { p.d = tapDir > 0 ? 1 : 0; p.u = tapDir < 0 ? 1 : 0; return false; }
    p.d = p.u = 0;
    if (now < nextTap) return false;
    const a = ROBOT.armRaw();
    if (a >= lo && a <= hi) return true;
    const err = (lo + hi) / 2 - a;
    tapDir = Math.sign(err);                       // ▼ 讓位置變大、▲ 變小
    tapUntil = now + Math.max(30, Math.min(1500, Math.abs(err) / ARM_RPS * 1000 * 0.85));
    nextTap = tapUntil + 400;
    return false;
  }

  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  // 坦克式:u 是想要的輪子出力(-1~1)。LEO 會把搖桿平方(小推比較細),所以這裡先開根號抵銷
  const axis = u => { u = Math.max(-1, Math.min(1, u)); return -Math.sign(u) * Math.sqrt(Math.abs(u)); };
  function tank(left, right) { drv().axes[1] = axis(left); drv().axes[5] = axis(right); }
  // 開到 (tx, ty),回傳剩下的距離。ref = 用車頭(吸球)還是車中心當基準
  // v5 起車子有慣性、數值回傳又有延遲 → 用「0.25 秒後會朝哪」來算誤差(提前量),不然會一直轉過頭繞圈
  // (實測:展示模式在射擊點附近繞了 30 秒到不了)
  const LEAD = 0.25;
  const headingSoon = () => pose.th + PHYS.state.w * LEAD;
  function driveTo(tx, ty, { ref = 0, maxV = 0.75, slow = 1.0 } = {}) {
    const rx = pose.x + Math.cos(pose.th) * ref, ry = pose.y - Math.sin(pose.th) * ref;
    const dist = Math.hypot(tx - rx, ty - ry);
    const err = wrap(Math.atan2(-(ty - ry), tx - rx) - headingSoon());
    // 快到了就慢下來(車子會滑),方向偏太多就先原地轉
    const fwd = Math.min(maxV, 0.12 + dist / slow * maxV) * Math.max(0, Math.cos(err)) ** 3;
    const turn = Math.max(-0.5, Math.min(0.5, err * 0.6));
    tank(fwd - turn, fwd + turn);
    return dist;
  }
  function turnTo(bearing, fwd = 0) {
    const aim = headingSoon() + ROBOT.turretRad();
    const err = wrap(bearing - aim);
    // 差 1 度以內就放開搖桿,不然最小出力會一直左右抖,永遠停不下來開火(實測在兩個射擊點之間來回跑了 90 秒)
    const turn = Math.abs(err) < 0.02 ? 0 : Math.sign(err) * Math.min(0.4, 0.06 + Math.abs(err) * 0.6);
    tank(fwd - turn, fwd + turn);
    return Math.abs(wrap(bearing - pose.th - ROBOT.turretRad()));
  }
  // 從車子到 (x, y) 的直線會不會撞到 HUB / TOWER(往外多留半個車身)
  function pathBlocked(x, y) {
    for (const o of PHYS.OBST) {
      const m = 0.5;
      for (let k = 0.1; k <= 1; k += 0.1) {
        const px = pose.x + (x - pose.x) * k, py = pose.y + (y - pose.y) * k;
        if (px > o.x0 - m && px < o.x1 + m && py > o.y0 - m && py < o.y1 + m) return true;
      }
    }
    return false;
  }
  const badBalls = new Map();    // 追不到的球,10 秒內不要再挑
  // 自己聯盟那個 HUB(藍,左邊)。射擊點:HUB 斜後方兩個角落,避開中間的 TOWER
  const hub = () => HUBS[0];
  // 射擊距離:用物理算 LEO 射擊轉速(80 圈/秒)的射程;算不出來就用 3.9 m
  const spots = () => [135, -135].map(d => {
    const RANGE = PHYS.rangeAt(80) || 3.9;
    const a = d * Math.PI / 180;
    return { x: hub().x + Math.cos(a) * RANGE, y: hub().y - Math.sin(a) * RANGE };
  });
  function pickBall() {
    // 挑離車頭最近、而且不在 HUB 旁邊、在我們這半場的球
    const fx = pose.x + Math.cos(pose.th) * 0.6, fy = pose.y - Math.sin(pose.th) * 0.6;
    const now = performance.now();
    for (const [b, t] of badBalls) if (now - t > 10000) badBalls.delete(b);
    let best = null, bd = 1e9;
    for (const b of fieldBalls) {
      if (b.fixed || badBalls.has(b)) continue;
      // 貼牆的球車頭伸不到(車中心離牆最近 0.45),會一直頂牆
      if (b.x < 0.8 || b.y < 0.8 || b.x > FIELD_W / 2 + 0.6 || b.y > FIELD_H - 0.8) continue;
      if (PHYS.OBST.some(o => b.x > o.x0 - 0.6 && b.x < o.x1 + 0.6 && b.y > o.y0 - 0.6 && b.y < o.y1 + 0.6)) continue;
      const d = Math.hypot(b.x - fx, b.y - fy);
      if (d < bd && !pathBlocked(b.x, b.y)) { bd = d; best = b; }
    }
    return best;
  }

  const LABEL = { armDown: '放下 Intake', collect: '去吸球', armUp: '收起 Intake', approach: '開到射擊點',
                  aim: '對準 HUB', shoot: '發射!' };
  function step() {
    if (!on) return;
    if (!enabled) return stop('展示模式已停止(機器人被停用)');
    const now = performance.now(), el = (now - phaseT) / 1000;
    hint.style.display = '';
    hint.textContent = `🎬 展示模式・${LABEL[phase] || ''}・車上 ${held} 顆`;
    op().axes[3] = 0; op().buttons[BTN.A - 1] = false;

    if (phase === 'armDown') {
      tank(0, 0);
      if (armTo(7.5, ARM_DOWN_ROT) || el > 10) { op().pov.d = op().pov.u = 0; setPhase('collect'); }
    } else if (phase === 'collect') {
      op().buttons[BTN.LB - 1] = true;
      if (!target || !fieldBalls.includes(target)) target = pickBall();
      if (!target) return setPhase('armUp');
      const d = driveTo(target.x, target.y, { ref: 0.6, maxV: 0.55 });
      // 卡住(3 秒沒更靠近)就換一顆
      if (d < lastDist - 0.05) { lastDist = d; stuckT = now; }
      else if (now - stuckT > 3000) { badBalls.set(target, now); target = null; lastDist = 1e9; stuckT = now; tank(-0.4, -0.4); }
      if (held >= 12 || el > 25) { op().buttons[BTN.LB - 1] = false; setPhase('armUp'); }
    } else if (phase === 'armUp') {
      op().buttons[BTN.LB - 1] = false;
      tank(0, 0);
      if (armTo(-0.5, 1.5) || el > 10) { op().pov.u = 0; spotIdx = pose.y < FIELD_H / 2 ? 0 : 1; setPhase('approach'); }
    } else if (phase === 'approach') {
      const s = spots()[spotIdx];
      op().axes[3] = 1;                                   // 路上先把飛輪轉起來
      const d = driveTo(s.x, s.y, { maxV: 0.7, slow: 1.5 });
      if (d < lastDist - 0.05) { lastDist = d; stuckT = now; }
      else if (now - stuckT > 4000) { spotIdx = 1 - spotIdx; lastDist = 1e9; stuckT = now; }
      // 差不多到了(0.4 m 內)就交給「對準」:對準的時候會自己往前/往後微調距離
      if (d < 0.4 || el > 20) { tank(0, 0); setPhase('aim'); }
    } else if (phase === 'aim') {
      op().axes[3] = 1;
      const bearing = Math.atan2(-(hub().y - pose.y), hub().x - pose.x);
      // 距離不對就邊轉邊前後修(落點預測告訴我們差多少)
      const off = lastAim && lastAim.facing && !lastAim.good ? lastAim.toHub - lastAim.range : 0;
      const err = turnTo(bearing, Math.abs(off) > 0.05 ? Math.max(-0.25, Math.min(0.25, off * 0.5)) : 0);
      // 跟畫面上的落點預測圈用同一套算法:圈變綠、而且車子已經停穩 0.3 秒才開火
      // (第一版一對準就射,車還在轉 → 8 顆全歪)
      const steady = lastAim && lastAim.good && err < 0.05 && Math.abs(ROBOT.driveL()) < 0.1 && Math.abs(ROBOT.driveR()) < 0.1
        && Math.abs(PHYS.state.v) < 0.05 && Math.abs(PHYS.state.w) < 0.05;   // 車子有慣性了,出力歸零還會滑一下,要真的停住
      if (!steady) stuckT = now;
      if (steady && now - stuckT > 300) { tank(0, 0); setPhase('shoot'); }
      else if (el > 12) { spotIdx = 1 - spotIdx; setPhase('approach'); }   // 對不到就換另一個射擊點
    } else if (phase === 'shoot') {
      tank(0, 0);
      op().axes[3] = 1;
      op().buttons[BTN.A - 1] = !!(lastAim && lastAim.good);             // 被撞歪了就先停火
      if (lastAim && !lastAim.good) setPhase('aim');
      else if (held === 0 || el > 8) { op().buttons[BTN.A - 1] = false; op().axes[3] = 0; target = null; setPhase('armDown'); }
    }
  }
  setInterval(step, 20);
  // 手動碰搖桿就把控制權還給人
  document.addEventListener('pointerdown', e => { if (on && e.target.closest && e.target.closest('.pads')) stop('你接手了,展示模式已停止'); }, true);
})();
