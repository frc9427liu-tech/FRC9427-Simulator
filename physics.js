// ============================================================
//  真實物理(2026-09-23 v5)
//  以前:車子出力多少就立刻跑多快、球照固定 1 秒的假軌跡飛、碰撞用圓形大概擋一下。
//  現在:
//    - 底盤有質量:馬達特性 + 加速度上限(輪胎抓地力)+ 原地轉的輪胎摩擦
//    - 車子是方形(不是圓形),撞到牆、HUB、TOWER 會被擋下來,速度也會被吃掉
//    - 地上的球會滾、有摩擦力、會互相推擠、被車撞會噴出去
//    - 射出去的球有重力 + 空氣阻力,飛輪轉越快射越遠,車子邊開邊射球也會帶著車速
//    - HUB 照官方模型:入口 1.83 m 高、邊長 1.19 m;射太遠會被 HUB 後面的網子擋下來掉進去;
//      打到 HUB 側面會彈開;進球的球會從 HUB 後面的出口滾回中場
//  場地元件的位置和大小是從官方 AdvantageScope 場地模型(Field3d_2026FRCFieldV2)量出來的。
//  標「示意」的是還沒量到真實數字、先用合理值的參數,量到再改這裡就好。
//  讀 screen.js 的全域:pose, fieldBalls, shots, held, FIELD_W, FIELD_H, HUBS, HUB_TOP, BALL_R, MAX_HELD
// ============================================================
const PHYS = (() => {
  // ---------- 參數 ----------
  const G = 9.81;
  const ROBOT_HALF = 0.43;         // 含保險桿半邊長(公尺)
  const V_FREE = 4.4;              // 示意:全出力的極速(m/s),齒比/輪徑量到再改
  const TAU = 0.28;                // 示意:馬達加速的時間常數(秒),越小起步越快
  const A_MAX = 7.5;               // 輪胎抓地力上限(m/s²),大約 0.75 g
  const TRACK = 0.62;              // 左右輪距
  const SCRUB = 1.3;               // 坦克式原地轉有輪胎側滑,實際轉得比理論慢
  const BUMP_SLOW = 0.7;           // 開上 BUMP 速度打折

  const HUB_HALF = 0.595;          // HUB 本體 1.19 m 見方(官方模型)
  const OPEN_R = 0.58;             // HUB 頂部漏斗入口(六角形,用圓近似)
  const NET = { x0: 0.185, z0: 1.66, x1: 0.855, z1: 3.02, half: 0.71 };  // HUB 後方的網子(相對 HUB 中心,往中場方向)
  const TOWER_H = 1.99;
  // 障礙物(軸對齊方框):HUB 本體 + 兩座 TOWER
  const OBST = [
    ...HUBS.map(h => ({ x0: h.x - HUB_HALF, y0: h.y - HUB_HALF, x1: h.x + HUB_HALF, y1: h.y + HUB_HALF, h: HUB_TOP, hub: h })),
    { x0: 0, y0: 3.695, x1: 1.14, y1: 4.945, h: TOWER_H },                              // 藍方 TOWER
    { x0: FIELD_W - 1.14, y0: FIELD_H - 4.945, x1: FIELD_W, y1: FIELD_H - 3.695, h: TOWER_H },   // 紅方 TOWER(點對稱)
  ];
  // BUMP:HUB 左右兩側的斜坡(官方模型量的)
  const BUMPS = HUBS.flatMap(h => [
    { x0: h.x - 0.565, x1: h.x + 0.565, y0: h.y + 0.52, y1: h.y + 2.75 },
    { x0: h.x - 0.565, x1: h.x + 0.565, y0: h.y - 2.75, y1: h.y - 0.52 },
  ]);
  // HUB 的「後面」= 往中場的方向(藍 +x、紅 -x),網子和出口都在後面
  const hubSide = h => (h.x < FIELD_W / 2 ? 1 : -1);

  const BALL_M = 0.21;             // 示意:FUEL 泡棉球重量(kg)
  const DRAG_K = 0.5 * 1.2 * 0.5 * Math.PI * BALL_R * BALL_R / BALL_M;   // ½ρCdA/m
  const ROLL_DECEL = 1.6;          // 泡棉球在地毯上滾的減速(m/s²)
  // 出球仰角、飛輪→出球速度的比例都從 ⚙️ 機構設定來(robotmap.js;LEO 預設 60°、4 吋輪、效率 0.29)
  const PIVOT = 0.12, MUZZLE = 0.3, MUZZLE_Z = 0.55;
  const HUB_DELAY = 0.7;           // 球從 HUB 入口到後面出口的時間(示意)

  // ---------- 底盤 ----------
  const S = { vL: 0, vR: 0, v: 0, w: 0, blocked: false };
  const onBump = (x, y) => BUMPS.some(b => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1);

  // 方形車(會轉)跟方框障礙物:分離軸定理,回傳要把車推出去的方向和深度
  function obbVsBox(cx, cy, th, o) {
    const ux = Math.cos(th), uy = -Math.sin(th), vx = Math.sin(th), vy = Math.cos(th);
    const bx = (o.x0 + o.x1) / 2, by = (o.y0 + o.y1) / 2, hx = (o.x1 - o.x0) / 2, hy = (o.y1 - o.y0) / 2;
    const dx = bx - cx, dy = by - cy;
    let best = null;
    for (const [ax, ay] of [[1, 0], [0, 1], [ux, uy], [vx, vy]]) {
      const rR = ROBOT_HALF * (Math.abs(ux * ax + uy * ay) + Math.abs(vx * ax + vy * ay));
      const rB = hx * Math.abs(ax) + hy * Math.abs(ay);
      const d = dx * ax + dy * ay;
      const ov = rR + rB - Math.abs(d);
      if (ov <= 0) return null;
      if (!best || ov < best.depth) best = { nx: -Math.sign(d || 1) * ax, ny: -Math.sign(d || 1) * ay, depth: ov };
    }
    return best;
  }

  function drive(L, R, dt) {
    const slow = onBump(pose.x, pose.y) ? BUMP_SLOW : 1;
    // 馬達:目標速度 = 出力 × 極速,越接近越難加速(反電動勢);再被抓地力上限卡住
    const acc = (target, v) => Math.max(-A_MAX, Math.min(A_MAX, (target - v) / TAU));
    S.vL += acc(L * V_FREE * slow, S.vL) * dt;
    S.vR += acc(R * V_FREE * slow, S.vR) * dt;
    let v = (S.vL + S.vR) / 2, w = (S.vR - S.vL) / (TRACK * SCRUB);
    pose.th += w * dt;
    pose.x += v * Math.cos(pose.th) * dt;
    pose.y -= v * Math.sin(pose.th) * dt;

    // 碰撞:牆 + 障礙物,推出去之後把「往障礙物裡鑽」的速度吃掉(輪子打滑)
    S.blocked = false;
    const hitN = [];
    const ext = ROBOT_HALF * (Math.abs(Math.cos(pose.th)) + Math.abs(Math.sin(pose.th)));
    if (pose.x < ext) { pose.x = ext; hitN.push([1, 0]); }
    if (pose.x > FIELD_W - ext) { pose.x = FIELD_W - ext; hitN.push([-1, 0]); }
    if (pose.y < ext) { pose.y = ext; hitN.push([0, 1]); }
    if (pose.y > FIELD_H - ext) { pose.y = FIELD_H - ext; hitN.push([0, -1]); }
    for (const o of OBST) {
      const c = obbVsBox(pose.x, pose.y, pose.th, o);
      if (c) { pose.x += c.nx * c.depth; pose.y += c.ny * c.depth; hitN.push([c.nx, c.ny]); }
    }
    if (hitN.length) {
      S.blocked = true;
      const hx = Math.cos(pose.th), hy = -Math.sin(pose.th);
      for (const [nx, ny] of hitN) {
        const c = hx * nx + hy * ny;                    // 車頭跟牆面法線的夾角
        if (v * c < 0) v *= 1 - c * c;                  // 正面撞 = 停住;斜斜擦過 = 保留大部分速度
      }
      S.vL = v - w * TRACK * SCRUB / 2; S.vR = v + w * TRACK * SCRUB / 2;
    }
    S.v = v; S.w = w;
    return S;
  }

  // ---------- 地上的球 ----------
  let lastCapture = 0;
  const grid = new Map();
  const CELL = 0.2;
  function balls(dt, t, arm, rollerDir, onCapture) {
    const c = Math.cos(pose.th), s = Math.sin(pose.th);
    const ux = c, uy = -s, vx = s, vy = c;                 // 車頭方向 u、車左右 v(畫面座標)
    const front = ROBOT_HALF + (arm > 0.3 ? 0.06 + 0.28 * arm : 0);   // 手臂放下時前面多伸出一截
    const r = BALL_R;
    grid.clear();
    for (let i = fieldBalls.length - 1; i >= 0; i--) {
      const b = fieldBalls[i];
      if (b.fixed) continue;                                // 場外補給站的球不動
      // 滾動 + 摩擦
      if (b.vx || b.vy) {
        b.x += b.vx * dt; b.y += b.vy * dt;
        const sp = Math.hypot(b.vx, b.vy), ns = Math.max(0, sp - ROLL_DECEL * dt);
        if (ns < 0.02) { b.vx = b.vy = 0; } else { b.vx *= ns / sp; b.vy *= ns / sp; }
      }
      // 牆
      if (b.x < r) { b.x = r; b.vx = Math.abs(b.vx || 0) * 0.4; }
      if (b.x > FIELD_W - r) { b.x = FIELD_W - r; b.vx = -Math.abs(b.vx || 0) * 0.4; }
      if (b.y < r) { b.y = r; b.vy = Math.abs(b.vy || 0) * 0.4; }
      if (b.y > FIELD_H - r) { b.y = FIELD_H - r; b.vy = -Math.abs(b.vy || 0) * 0.4; }
      // HUB / TOWER
      for (const o of OBST) circleBox(b, o, 0.3);
      // 車子
      const dx = b.x - pose.x, dy = b.y - pose.y;
      const lx = dx * ux + dy * uy, ly = dx * vx + dy * vy;
      const inFront = lx > ROBOT_HALF - 0.05 && lx < front + r && Math.abs(ly) < 0.33;
      // 吸球速度上限:約每秒 11 顆(示意;原本 40ms 一顆 → 2.5 秒吸 38 顆,太誇張)
      if (inFront && arm > 0.6 && rollerDir > 0 && held < MAX_HELD && t - lastCapture > 90) {
        fieldBalls.splice(i, 1); lastCapture = t; onCapture(b);
        continue;
      }
      const fx = lx > 0 ? (Math.abs(ly) < 0.36 ? front : ROBOT_HALF) : ROBOT_HALF;
      if (lx < fx + r && lx > -ROBOT_HALF - r && Math.abs(ly) < ROBOT_HALF + r) {
        const penX = lx > 0 ? fx + r - lx : lx + ROBOT_HALF + r;
        const penY = ROBOT_HALF + r - Math.abs(ly);
        let nx, ny, pen;
        if (penX < penY) { const sg = lx > 0 ? 1 : -1; nx = ux * sg; ny = uy * sg; pen = penX; }
        else { const sg = ly > 0 ? 1 : -1; nx = vx * sg; ny = vy * sg; pen = penY; }
        b.x += nx * pen; b.y += ny * pen;
        // 車上那一點的速度(平移 + 旋轉),球被撞出去
        const pvx = S.v * ux + S.w * dy, pvy = S.v * uy - S.w * dx;
        const rel = (pvx - (b.vx || 0)) * nx + (pvy - (b.vy || 0)) * ny;
        if (rel > 0) { b.vx = (b.vx || 0) + nx * rel * 1.3; b.vy = (b.vy || 0) + ny * rel * 1.3; }
      }
      // 放進格子,等一下算球跟球
      const key = Math.floor(b.x / CELL) * 1000 + Math.floor(b.y / CELL);
      let cell = grid.get(key); if (!cell) grid.set(key, cell = []); cell.push(b);
    }
    // 球跟球:只檢查附近格子
    const D = 2 * r;
    for (const [key, cell] of grid) {
      const gx = Math.floor(key / 1000), gy = key % 1000;
      for (let ox = 0; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        if (ox === 0 && oy < 0) continue;
        const other = ox === 0 && oy === 0 ? cell : grid.get((gx + ox) * 1000 + gy + oy);
        if (!other) continue;
        for (let i = 0; i < cell.length; i++) {
          const a = cell[i];
          for (let j = other === cell ? i + 1 : 0; j < other.length; j++) {
            const b = other[j];
            const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
            if (d2 >= D * D || d2 < 1e-10) continue;
            const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, p = (D - d) / 2;
            a.x -= nx * p; a.y -= ny * p; b.x += nx * p; b.y += ny * p;
            const rel = ((a.vx || 0) - (b.vx || 0)) * nx + ((a.vy || 0) - (b.vy || 0)) * ny;
            if (rel > 0) {
              const k = rel * 0.65;                          // 恢復係數約 0.3(泡棉球)
              a.vx = (a.vx || 0) - nx * k; a.vy = (a.vy || 0) - ny * k;
              b.vx = (b.vx || 0) + nx * k; b.vy = (b.vy || 0) + ny * k;
            }
          }
        }
      }
    }
  }
  // 圓(球)跟方框:推出去 + 反彈
  function circleBox(b, o, e) {
    const qx = Math.max(o.x0, Math.min(o.x1, b.x)), qy = Math.max(o.y0, Math.min(o.y1, b.y));
    let dx = b.x - qx, dy = b.y - qy, d = Math.hypot(dx, dy);
    if (d >= BALL_R) return false;
    if (d < 1e-6) {       // 球心跑進方框裡:從最近的邊推出去
      const cand = [[b.x - o.x0, -1, 0], [o.x1 - b.x, 1, 0], [b.y - o.y0, 0, -1], [o.y1 - b.y, 0, 1]].sort((p, q) => p[0] - q[0])[0];
      dx = cand[1]; dy = cand[2]; d = 1;
      b.x += dx * (cand[0] + BALL_R); b.y += dy * (cand[0] + BALL_R);
    } else {
      b.x = qx + dx / d * BALL_R; b.y = qy + dy / d * BALL_R;
    }
    const nx = dx / d, ny = dy / d, vn = (b.vx || 0) * nx + (b.vy || 0) * ny;
    if (vn < 0) { b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; }
    return true;
  }

  // ---------- 飛行中的球 ----------
  // 出球速度 = 飛輪轉速(圈/秒)× 輪周長 × 出球效率(ROBOT.shootK,⚙️ 機構設定可改)
  function launch(aim, fly, spread) {
    const px = pose.x + Math.cos(pose.th) * PIVOT, py = pose.y - Math.sin(pose.th) * PIVOT;
    const a = aim + (spread ? (Math.random() - 0.5) * 0.035 : 0);
    const la = ROBOT.launchRad + (spread ? (Math.random() - 0.5) * 0.03 : 0);
    const sp = Math.abs(fly) * ROBOT.shootK * (spread ? 0.98 + Math.random() * 0.04 : 1);
    const dx = Math.cos(a), dy = -Math.sin(a);
    return {
      x: px + dx * MUZZLE, y: py + dy * MUZZLE, z: MUZZLE_Z,
      // 球會帶著車子的速度(邊開邊射要提前量)
      vx: dx * sp * Math.cos(la) + S.v * Math.cos(pose.th), vy: dy * sp * Math.cos(la) - S.v * Math.sin(pose.th),
      vz: sp * Math.sin(la), t: 0,
    };
  }
  // 推進一小步,發生事件就回傳:'score'(進球,帶 hub)、'ground'(落地)
  function flightStep(b, dt) {
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    b.vx -= DRAG_K * sp * b.vx * dt; b.vy -= DRAG_K * sp * b.vy * dt; b.vz -= (G + DRAG_K * sp * b.vz) * dt;
    const pz = b.z;
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt; b.t += dt;
    for (const o of OBST) {
      const h = o.hub;
      // 往下穿過 HUB 入口的高度、而且在入口範圍裡 = 進球
      if (h && pz >= HUB_TOP && b.z < HUB_TOP && Math.hypot(b.x - h.x, b.y - h.y) < OPEN_R) return { ev: 'score', hub: h };
      // 撞到 HUB 側面 / TOWER:水平反彈
      if (b.z < o.h && circleBox(b, o, 0.35)) { b.vx *= 0.8; b.vy *= 0.8; }
      // HUB 後面的網子:斜的,射太遠會被網子吃掉速度、往下掉(常常就掉進入口)
      if (h) {
        const sd = hubSide(h), xr = sd * (b.x - h.x), yr = b.y - h.y;
        if (Math.abs(yr) < NET.half && b.z > NET.z0 && b.z < NET.z1) {
          const xn = NET.x0 + (b.z - NET.z0) * (NET.x1 - NET.x0) / (NET.z1 - NET.z0);
          const vxr = sd * b.vx;
          if (xr > xn && xr - vxr * dt <= xn + 0.02 && vxr > 0) {
            b.x = h.x + sd * (xn - 0.02);
            b.vx = -sd * vxr * 0.12; b.vy *= 0.3; b.vz = Math.min(b.vz, 0) * 0.4;
          }
        }
      }
    }
    // 牆(場邊有透明擋板,當成夠高)
    if (b.x < BALL_R || b.x > FIELD_W - BALL_R) { b.vx *= -0.4; b.x = Math.max(BALL_R, Math.min(FIELD_W - BALL_R, b.x)); }
    if (b.y < BALL_R || b.y > FIELD_H - BALL_R) { b.vy *= -0.4; b.y = Math.max(BALL_R, Math.min(FIELD_H - BALL_R, b.y)); }
    if (b.z <= BALL_R) {
      b.z = BALL_R;
      if (b.vz < -1.5) { b.vz = -b.vz * 0.35; b.vx *= 0.7; b.vy *= 0.7; return { ev: 'bounce' }; }
      return { ev: 'ground' };
    }
    return null;
  }

  // 每幀:推進所有飛行中的球,回呼 onScore(hub, ball) / onMiss(ball)
  const hubQueue = [];     // 進了 HUB、等著從出口滾出來的球
  function flights(dt, t, onScore, onMiss) {
    const N = 4, h = dt / N;
    const out = [];
    for (const b of shots) {
      let done = false;
      for (let i = 0; i < N && !done; i++) {
        const r = flightStep(b, h);
        if (!r) continue;
        if (r.ev === 'score') { onScore(r.hub, b); hubQueue.push({ t: t + HUB_DELAY * 1000, hub: r.hub }); done = true; }
        else if (r.ev === 'bounce' || r.ev === 'ground') {
          if (b.robot) { b.robot = false; onMiss(b); }
          if (r.ev === 'ground') { fieldBalls.push({ x: b.x, y: b.y, vx: b.vx * 0.6, vy: b.vy * 0.6 }); done = true; }
        }
      }
      if (!done && b.t > 8) { fieldBalls.push({ x: b.x, y: b.y, vx: 0, vy: 0 }); done = true; }
      if (!done) {
        (b.hist || (b.hist = [])).unshift({ x: b.x, y: b.y, z: b.z });
        if (b.hist.length > 8) b.hist.pop();
        out.push(b);
      }
    }
    shots = out;
    // HUB 出口:球從 HUB 後面(中場那側)0.8 m 高的斜坡滾出來(示意)
    while (hubQueue.length && hubQueue[0].t <= t) {
      const q = hubQueue.shift(), sd = hubSide(q.hub);
      shots.push({ x: q.hub.x + sd * (HUB_HALF + 0.05), y: q.hub.y + (Math.random() - 0.5) * 0.9, z: 0.8,
                   vx: sd * (1.5 + Math.random()), vy: (Math.random() - 0.5) * 1.2, vz: 0.3, t: 0 });
    }
  }

  // ---------- 落點預測:用同一套物理跑一次(不含隨機散布) ----------
  function predict(aim, fly) {
    const b = launch(aim, fly, false);
    let firstGround = null;
    for (let i = 0; i < 720; i++) {                        // 最多 3 秒
      const r = flightStep(b, 1 / 240);
      if (!r) continue;
      if (r.ev === 'score') return { x: b.x, y: b.y, good: true, hub: r.hub };
      if (!firstGround) firstGround = { x: b.x, y: b.y };
      if (r.ev === 'ground') break;
    }
    const p = firstGround || { x: b.x, y: b.y };
    return { x: p.x, y: p.y, good: false };
  }
  // 射程:車子停著、這個飛輪轉速,球「往下穿過 HUB 入口高度」時離車中心幾公尺(不管網子和 HUB)。
  // 設定畫面跟測試用;LEO 預設(4 吋、效率 0.29、60°)在 80 圈/秒約 3.9 m
  function rangeAt(fly) {
    const sp = Math.abs(fly) * ROBOT.shootK, la = ROBOT.launchRad;
    let x = PIVOT + MUZZLE, z = MUZZLE_Z, vx = sp * Math.cos(la), vz = sp * Math.sin(la);
    for (let i = 0; i < 2400; i++) {
      const s = Math.hypot(vx, vz), pz = z;
      vx -= DRAG_K * s * vx / 240; vz -= (G + DRAG_K * s * vz) / 240;
      x += vx / 240; z += vz / 240;
      if (pz >= HUB_TOP && z < HUB_TOP) return x;
      if (z < 0) return null;            // 飛不到入口高度
    }
    return null;
  }

  return { drive, balls, flights, launch, predict, rangeAt, state: S, onBump, OBST, BUMPS };
})();
