// ============================================================
//  真實物理(2026-09-23 v5)
//  以前:車子出力多少就立刻跑多快、球照固定 1 秒的假軌跡飛、碰撞用圓形大概擋一下。
//  現在:
//    - 底盤有質量:馬達特性 + 加速度上限(輪胎抓地力)+ 原地轉的輪胎摩擦
//    - 車子是方形(不是圓形),撞到牆、HUB、TOWER、TRENCH 底座會被擋下來,速度也會被吃掉
//    - 地上的球會滾、有摩擦力、會互相推擠、被車撞會噴出去
//    - 射出去的球有重力 + 空氣阻力,飛輪轉越快射越遠,車子邊開邊射球也會帶著車速
//    - HUB 照官方模型:入口 1.83 m 高、邊長 1.19 m;射太遠會被 HUB 後面的網子擋下來掉進去;
//      打到 HUB 側面會彈開;進球的球會從 HUB 後面的出口滾回中場
//  場地元件的位置和大小是從官方 AdvantageScope 場地模型(Field3d_2026FRCFieldV2)量出來的。
//  標「示意」的是還沒量到真實數字、先用合理值的參數,量到再改這裡就好。
//  2026-09-24 v6:底盤改用真實馬達 + 電池模型(mechlab-core.js),車身尺寸可以自訂(robotcustom.js)
//  讀 screen.js 的全域:pose, fieldBalls, shots, held, FIELD_W, FIELD_H, HUBS, HUB_TOP, BALL_R, MAX_HELD
// ============================================================
const PHYS = (() => {
  // ---------- 參數 ----------
  const G = 9.81;
  // 車身尺寸和底盤動力都從 🤖 自訂機器人(robotcustom.js)來,這裡是預設值(LEO / KitBot 大小)
  let HX = 0.43, HY = 0.43;        // 含保險桿的半長(前後)、半寬(左右)
  let TRACK = 0.62;                // 左右輪距
  const SCRUB = 1.3;               // 坦克式原地轉有輪胎側滑,實際轉得比理論慢
  const BUMP_SLOW = 0.7;           // 開上 BUMP 速度打折
  const SCRUB_K = 0.35;            // 轉彎側滑阻力 ≈ 0.35 × 車重(6 輪中間輪較低的 drop-center 大約這樣)
  let INTAKE_HALF = 0.33;          // 車頭吸球口的半寬

  // ---------- 底盤動力(2026-09-24 v6:真實馬達 + 電池) ----------
  // 以前:目標速度 = 出力 × 固定極速,用固定時間常數追上去(示意)。
  // 現在:每一邊 n 顆馬達 → 減速箱 → 輪子,用機構實驗室(mechlab-core.js)同一套直流馬達模型:
  //   馬達電流 I = (V − ω/kV) / R、推力 F = n·kT·I·G·η / r_輪
  //   推力超過輪胎抓地力(μ·m·g/2)就打滑 → 加速度上限跟車重、輪胎有關
  //   所有馬達的電流一起從電池抽 → 電壓掉下來,車就變慢;太低會 Brownout
  //   控制器的定子 / 供電電流限制一樣有作用(限制越低,起步越溫和、越不容易 Brownout)
  const ML = typeof MechLab !== 'undefined' ? MechLab : null;
  let DRV = null;                  // { gb, ctrlL, ctrlR, battery, mass, mu, wheelR }
  const DRIVE_DEFAULT = { motor: 'krakenX60', perSide: 2, ratio: 7.31, wheelIn: 4, mass: 60, mu: 1.1, efficiency: 0.97,
                          statorLimit: 80, supplyLimit: 60 };
  const BATT_DEFAULT = { openV: 12.6, resistance: 0.02 };
  function configure(body) {
    body = body || {};
    const len = +body.length || 0.86, wid = +body.width || 0.86;
    HX = len / 2; HY = wid / 2;
    TRACK = Math.max(0.3, wid - 0.24);
    INTAKE_HALF = Math.max(0.12, Math.min(0.33, HY - 0.1));
    if (!ML) { DRV = null; return; }
    const d = Object.assign({}, DRIVE_DEFAULT, body.drive || {});
    const b = Object.assign({}, BATT_DEFAULT, body.battery || {});
    const motor = ML.MOTORS[d.motor] || ML.MOTORS.krakenX60;
    const lim = { statorLimit: d.statorLimit, supplyLimit: d.supplyLimit };
    const oldBatt = DRV && DRV.battery;
    DRV = {
      d, gb: new ML.Gearbox(motor, Math.max(1, Math.round(d.perSide)), Math.max(0.1, d.ratio), d.efficiency),
      ctrlL: new ML.MotorController(lim), ctrlR: new ML.MotorController(lim),
      battery: oldBatt || new ML.Battery(b), mass: Math.max(5, d.mass), mu: Math.max(0.1, d.mu),
      wheelR: Math.max(0.01, d.wheelIn * 0.0254 / 2),
    };
    Object.assign(DRV.battery, b);
    if (ENG.ready) engineRobot();
  }
  // 由規格推算的性能(給 🤖 自訂機器人 畫面顯示)
  function driveSpecs(body) {
    if (!ML) return null;
    const d = Object.assign({}, DRIVE_DEFAULT, (body && body.drive) || {});
    const m = ML.MOTORS[d.motor] || ML.MOTORS.krakenX60, r = d.wheelIn * 0.0254 / 2, n = d.perSide * 2;
    const vFree = m.freeSpeed / d.ratio * r;                                    // 理論極速(沒負載、12 V)
    const lim = d.statorLimit > 0 ? Math.min(d.statorLimit, m.stallCurrent) : m.stallCurrent;
    const fMotor = n * m.kT * lim * d.ratio * d.efficiency / r;                 // 電流限制下的最大推力
    const fGrip = d.mu * d.mass * G;
    return { vFree, fMotor, fGrip, aMax: Math.min(fMotor, fGrip) / d.mass, slips: fMotor > fGrip,
             pushN: Math.min(fMotor, fGrip) };
  }
  // 沒有 MechLab(舊版網頁)時的簡化模型
  const V_FREE = 4.4, TAU = 0.28, A_MAX = 7.5;

  const HUB_HALF = 0.595;          // HUB 本體 1.19 m 見方(官方模型)
  const OPEN_R = 0.58;             // HUB 頂部漏斗入口(六角形,用圓近似)
  const NET = { x0: 0.185, z0: 1.66, x1: 0.855, z1: 3.02, half: 0.71 };  // HUB 後方的網子(相對 HUB 中心,往中場方向)
  const TOWER_H = 1.99;
  // TRENCH:BUMP 外側的矮隧道。車可以從底下鑽過(橫桿離地 0.57 m),但橫桿兩端的底座(裙板)是實心的
  // 官方模型量的:底座 1.19 × 0.30 m、高 0.50 m,在 HUB 中心線 ±(2.46~2.76) m
  const TRENCH_H = 0.50;
  // 障礙物(軸對齊方框):HUB 本體 + 兩座 TOWER + 四個 TRENCH 底座
  const OBST = [
    ...HUBS.map(h => ({ x0: h.x - HUB_HALF, y0: h.y - HUB_HALF, x1: h.x + HUB_HALF, y1: h.y + HUB_HALF, h: HUB_TOP, hub: h })),
    { x0: 0, y0: 3.695, x1: 1.14, y1: 4.945, h: TOWER_H },                              // 藍方 TOWER
    { x0: FIELD_W - 1.14, y0: FIELD_H - 4.945, x1: FIELD_W, y1: FIELD_H - 3.695, h: TOWER_H },   // 紅方 TOWER(點對稱)
    ...HUBS.flatMap(h => [
      { x0: h.x - HUB_HALF, x1: h.x + HUB_HALF, y0: h.y + 2.455, y1: h.y + 2.755, h: TRENCH_H },
      { x0: h.x - HUB_HALF, x1: h.x + HUB_HALF, y0: h.y - 2.755, y1: h.y - 2.455, h: TRENCH_H },
    ]),
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
      const rR = HX * Math.abs(ux * ax + uy * ay) + HY * Math.abs(vx * ax + vy * ay);
      const rB = hx * Math.abs(ax) + hy * Math.abs(ay);
      const d = dx * ax + dy * ay;
      const ov = rR + rB - Math.abs(d);
      if (ov <= 0) return null;
      if (!best || ov < best.depth) best = { nx: -Math.sign(d || 1) * ax, ny: -Math.sign(d || 1) * ay, depth: ov };
    }
    return best;
  }

  // 其中一邊:出力(−1~1)→ 電壓 → 馬達電流 → 推力(受抓地力限制)→ 這一邊的加速度
  function sideStep(out, vSide, vAvg, ctrl, h, slow) {
    const { gb, battery } = DRV, mot = gb.motor;
    const wm = gb.motorSpeed(vSide / DRV.wheelR);
    const r = ctrl.apply(out * 12, mot, wm, battery.vBus);          // 程式出力 × 12 V,再套電池上限和電流限制
    let F = gb.outputTorque(mot.kT * r.I, wm) / DRV.wheelR;           // 輪子推地板的力
    const grip = DRV.mu * DRV.mass * G / 2 * slow;                    // 一邊輪子撐的重量 × 摩擦係數
    const slip = Math.abs(F) > grip;
    if (slip) F = Math.sign(F) * grip;
    F -= 0.012 * DRV.mass * G / 2 * Math.sign(vSide);                 // 滾動阻力(很小)
    // 轉彎的輪胎側滑:坦克式轉彎時前後輪會被橫向拖著走,吃掉一部分推力(越偏離平均速度越吃力)
    const dv = vSide - vAvg;
    if (Math.abs(dv) > 0.02) F -= SCRUB_K * DRV.mass * G / 2 * Math.sign(dv) * Math.min(1, Math.abs(dv) / 0.3);
    return { F, a: F / (DRV.mass / 2), I: r.I, Isup: r.Isup * gb.count, limited: r.limited, slip };
  }

  // ==========================================================
  //  3D 物理引擎(Rapier,2026-09-25 v7)
  // ==========================================================
  //  以前的碰撞是自己寫的 2D 方框 / 圓形,只能擋住、推開,沒有真的質量和反作用力。
  //  現在交給 Rapier(Rust 寫的剛體物理引擎,編成 WASM 在瀏覽器裡跑):
  //    - 車子是有質量、有轉動慣量的 3D 剛體:撞到東西會真的彈、會被反推、會卡住、會爬上 BUMP 斜坡
  //    - 地上每一顆球都是剛體:會滾、會互相堆疊、被車撞會噴、會卡在 HUB / TOWER 邊
  //    - 場地:地板、四面牆、HUB、兩座 TOWER、TRENCH 底座、BUMP 斜坡(官方模型量的尺寸)
  //  輪子的推力還是用上面的真實馬達模型算(電流、電池、打滑),每一小步當成「推力 + 扭力」施加在車身上;
  //  輪胎的側向抓地力用「抵消側滑速度的衝量(最多 μ·m·g)」模擬 → 被別台車從側面推,力量夠大才推得動。
  //  射出去在空中的球還是用原本的彈道(重力 + 空氣阻力 + 網子 + 進球判定),落地之後才變成引擎裡的剛體。
  //  沒有 rapier.js(舊版)或引擎還沒載入好時,自動用原本的 2D 物理,畫面不會壞。
  const ENG = { ready: false, world: null, R: null, robot: null, rCol: null, iCol: null, acc: 0, last: null, balls: new Map() };
  const STEP = 1 / 120;                 // 引擎固定步長(秒)
  const RH = 0.12;                      // 車身碰撞盒的半高(保險桿 + 車架,矮一點才鑽得過 TRENCH)
  const BUMP_H = 0.18, BUMP_FLAT = 0.2; // BUMP 高度、頂部平台半寬
  function engineInit() {
    const RAPIER = typeof globalThis !== 'undefined' ? globalThis.RAPIER : null;
    if (!RAPIER || !RAPIER.init) return Promise.resolve(false);
    return RAPIER.init().then(() => {
      ENG.R = RAPIER;
      const w = ENG.world = new RAPIER.World({ x: 0, y: -G, z: 0 });
      w.timestep = STEP;
      const fixed = (desc, x, y, z) => w.createCollider(desc.setTranslation(x, y, z));
      // 地板(地毯)
      fixed(RAPIER.ColliderDesc.cuboid(FIELD_W / 2 + 2, 0.5, FIELD_H / 2 + 2).setFriction(0.8), FIELD_W / 2, -0.5, FIELD_H / 2);
      // 四面牆(場邊擋板 + 聯盟站,當成 2 m 高)
      const T = 0.3;
      fixed(RAPIER.ColliderDesc.cuboid(T, 1, FIELD_H / 2 + T), -T, 1, FIELD_H / 2);
      fixed(RAPIER.ColliderDesc.cuboid(T, 1, FIELD_H / 2 + T), FIELD_W + T, 1, FIELD_H / 2);
      fixed(RAPIER.ColliderDesc.cuboid(FIELD_W / 2 + T, 1, T), FIELD_W / 2, 1, -T);
      fixed(RAPIER.ColliderDesc.cuboid(FIELD_W / 2 + T, 1, T), FIELD_W / 2, 1, FIELD_H + T);
      // HUB、TOWER、TRENCH 底座(跟 2D 物理同一份尺寸)
      for (const o of OBST) {
        fixed(RAPIER.ColliderDesc.cuboid((o.x1 - o.x0) / 2, o.h / 2, (o.y1 - o.y0) / 2).setRestitution(0.3).setFriction(0.4),
          (o.x0 + o.x1) / 2, o.h / 2, (o.y0 + o.y1) / 2);
      }
      // BUMP:梯形斜坡(截面是梯形的長條,沿著 y 方向)
      for (const b of BUMPS) {
        const cx = (b.x0 + b.x1) / 2, hw = (b.x1 - b.x0) / 2, pts = [];
        for (const z of [b.y0, b.y1]) pts.push(cx - hw, 0, z, cx + hw, 0, z, cx - BUMP_FLAT, BUMP_H, z, cx + BUMP_FLAT, BUMP_H, z);
        const d = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
        if (d) w.createCollider(d.setFriction(0.8));
      }
      engineRobot();
      ENG.ready = true;
      return true;
    }).catch(e => { console.warn('[物理引擎] Rapier 載入失敗,改用 2D 物理', e); return false; });
  }
  const yawQuat = th => ({ x: 0, y: Math.sin(th / 2), z: 0, w: Math.cos(th / 2) });
  // 建立 / 更新車身(尺寸、重量改了就重建碰撞盒)
  function engineRobot() {
    const R = ENG.R, w = ENG.world;
    if (!R || !w) return;
    if (!ENG.robot) {
      ENG.robot = w.createRigidBody(R.RigidBodyDesc.dynamic()
        .setTranslation(pose.x, RH + 0.01, pose.y).setRotation(yawQuat(pose.th))
        .enabledRotations(false, true, false)       // 只能轉方向,不會翻車(FRC 車重心很低)
        .setCcdEnabled(true).setAngularDamping(0.2));
      ENG.last = { x: pose.x, y: pose.y, th: pose.th };
    }
    if (ENG.rCol) w.removeCollider(ENG.rCol, false);
    if (ENG.iCol) w.removeCollider(ENG.iCol, false);
    const mass = DRV ? DRV.mass : 60;
    // 車身跟地板之間的摩擦設 0:輪胎的抓地力由上面的馬達 / 輪胎模型負責
    // 車身形狀:前後下緣切斜角(像雪橇),遇到 BUMP 斜坡才會「滑上去」而不是一頭撞停(真車是輪子滾上去)
    const bv = Math.min(0.1, HX * 0.3), by = -RH + 0.055, pts = []; // 斜角頂端低於球心(7.5 cm),球只會被正面推走、不會被鏟上車
    for (const sy of [-1, 1]) {
      pts.push(-HX + bv, -RH, sy * HY, HX - bv, -RH, sy * HY);                        // 底面(前後縮進去)
      pts.push(-HX, by, sy * HY, HX, by, sy * HY, -HX, RH, sy * HY, HX, RH, sy * HY); // 斜角上緣 + 頂面
    }
    const shape = R.ColliderDesc.convexHull(new Float32Array(pts)) || R.ColliderDesc.cuboid(HX, RH, HY);
    ENG.rCol = w.createCollider(shape.setMass(mass).setFriction(0)
      .setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0.15), ENG.robot);
    // 手臂放下時,前面多一截 Intake(會把球擋在車頭、推著走)
    ENG.iCol = w.createCollider(R.ColliderDesc.cuboid(0.17, 0.05, INTAKE_HALF).setTranslation(HX + 0.17, -RH + 0.06, 0)
      .setMass(0.01).setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min), ENG.robot);
    ENG.iCol.setEnabled(false);
  }
  function engineDrive(L, R, dt) {
    const body = ENG.robot, w = ENG.world;
    // 別的程式把車搬走了(回起點、重來)→ 直接瞬移過去、速度歸零
    const lt = ENG.last;
    if (Math.abs(pose.x - lt.x) > 1e-6 || Math.abs(pose.y - lt.y) > 1e-6 || Math.abs(pose.th - lt.th) > 1e-6) {
      body.setTranslation({ x: pose.x, y: RH + 0.01, z: pose.y }, true);
      body.setRotation(yawQuat(pose.th), true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      if (!S.vL && !S.vR) ENG.acc = 0;
    }
    ENG.acc = Math.min(ENG.acc + dt, 0.1);
    const tel = { I: 0, Isup: 0, limited: '', slip: false, n: 0 };
    const mass = DRV.mass;
    while (ENG.acc >= STEP) {
      ENG.acc -= STEP;
      const q = body.rotation(), th = 2 * Math.atan2(q.y, q.w);
      const fx = Math.cos(th), fz = -Math.sin(th);        // 車頭方向
      const lx = Math.sin(th), lz = Math.cos(th);         // 車身右手邊
      const v = body.linvel(), wy = body.angvel().y;
      const vF = v.x * fx + v.z * fz, vLat = v.x * lx + v.z * lz;
      const vL = vF - wy * TRACK / 2, vR = vF + wy * TRACK / 2;
      const t = body.translation();
      const grounded = t.y < RH + 0.12 + BUMP_H;          // 輪子有沒有碰地(被頂起來就沒推力)
      const slow = onBump(t.x, t.z) ? BUMP_SLOW : 1;
      const brown = DRV.battery.brownout;
      const l = sideStep(brown ? 0 : L, vL, vF, DRV.ctrlL, STEP, slow), r = sideStep(brown ? 0 : R, vR, vF, DRV.ctrlR, STEP, slow);
      DRV.battery.update(l.Isup + r.Isup, STEP);
      if (grounded) {
        const F = l.F + r.F, tau = (r.F - l.F) * TRACK / 2;
        body.applyImpulse({ x: fx * F * STEP, y: 0, z: fz * F * STEP }, true);
        body.applyTorqueImpulse({ x: 0, y: tau * STEP, z: 0 }, true);
        // 輪胎側向抓地力:把側滑速度吃掉,最多 μ·m·g(被推的力超過這個就會側滑)
        const jMax = DRV.mu * mass * G * STEP, j = Math.max(-jMax, Math.min(jMax, -mass * vLat));
        body.applyImpulse({ x: lx * j, y: 0, z: lz * j }, true);
      }
      w.step();
      tel.I += (Math.abs(l.I) + Math.abs(r.I)) * DRV.gb.count; tel.Isup += l.Isup + r.Isup; tel.n++;
      if (l.limited || r.limited) tel.limited = l.limited || r.limited;
      if (l.slip || r.slip) tel.slip = true;
    }
    // 引擎的結果寫回畫面用的 pose / 速度
    const t = body.translation(), q = body.rotation();
    pose.x = t.x; pose.y = t.z; pose.th = 2 * Math.atan2(q.y, q.w);
    ENG.last = { x: pose.x, y: pose.y, th: pose.th };
    const v = body.linvel(), wy = body.angvel().y;
    const vF = v.x * Math.cos(pose.th) - v.z * Math.sin(pose.th);
    S.v = vF; S.w = wy; S.vL = vF - wy * TRACK / 2; S.vR = vF + wy * TRACK / 2;
    S.h = t.y - RH - 0.01;                                // 車身離地高度(爬 BUMP 時 > 0)
    S.vBus = DRV.battery.vBus; S.brownout = DRV.battery.brownout;
    if (tel.n) { S.current = tel.I / tel.n; S.supply = tel.Isup / tel.n; S.limited = tel.limited; S.slip = tel.slip; }
    S.minV = Math.min(S.minV ?? 99, S.vBus);
    S.blocked = false;
    S.engine = true;
    return S;
  }
  // 地上的球:跟引擎裡的剛體同步(畫面那邊的 fieldBalls 陣列還是唯一的「真相」,這裡只負責讓它們動)
  const BALL_REST = 0.3;
  function engineBalls(dt, t, arm, rollerDir, onCapture) {
    const R = ENG.R, w = ENG.world;
    ENG.iCol.setEnabled(arm > 0.3);
    const c = Math.cos(pose.th), s = Math.sin(pose.th);
    const ux = c, uy = -s, vx = s, vy = c;
    const front = HX + (arm > 0.3 ? 0.06 + 0.28 * arm : 0);
    const seen = new Set();
    for (let i = fieldBalls.length - 1; i >= 0; i--) {
      const b = fieldBalls[i];
      if (b.fixed) continue;
      let rb = b._rb;
      if (!rb || !ENG.balls.has(rb)) {
        // 新的球(開場擺放、落地、吐出來的)→ 建一個剛體
        rb = w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(b.x, Math.max(BALL_R, b.h || 0), b.y)
          .setLinvel(b.vx || 0, b.vz || 0, b.vy || 0).setLinearDamping(0.35).setAngularDamping(1.2));
        w.createCollider(R.ColliderDesc.ball(BALL_R).setMass(BALL_M).setRestitution(BALL_REST).setFriction(0.7), rb);
        b._rb = rb; ENG.balls.set(rb, b);
      }
      seen.add(rb);
      const p = rb.translation(), lv = rb.linvel();
      b.x = p.x; b.y = p.z; b.h = p.y; b.vx = lv.x; b.vy = lv.z;
      // 吸球:跟 2D 版同一套判斷
      const dx = b.x - pose.x, dy = b.y - pose.y;
      const lx = dx * ux + dy * uy, ly = dx * vx + dy * vy;
      if (lx > HX - 0.05 && lx < front + BALL_R + 0.04 && Math.abs(ly) < INTAKE_HALF && b.h < 0.3
          && arm > 0.6 && rollerDir > 0 && held < MAX_HELD && t - lastCapture > 90) {
        fieldBalls.splice(i, 1); lastCapture = t; onCapture(b);
        seen.delete(rb); ENG.balls.delete(rb); w.removeRigidBody(rb); b._rb = null;
      }
    }
    // 被拿走的球(吸進車裡、換新的一局)→ 從引擎移除
    for (const [rb, b] of ENG.balls) if (!seen.has(rb)) { ENG.balls.delete(rb); w.removeRigidBody(rb); b._rb = null; }
  }
  function drive(L, R, dt) {
    if (ENG.ready && DRV) return engineDrive(L, R, dt);
    const slow = onBump(pose.x, pose.y) ? BUMP_SLOW : 1;
    if (DRV) {
      // 物理切成 ≤ 4 ms 的小步(馬達的電氣時間常數很短,步長太大會不穩定)
      const N = Math.max(1, Math.ceil(dt / 0.004)), h = dt / N;
      const tel = { I: 0, Isup: 0, limited: '', slip: false };
      for (let i = 0; i < N; i++) {
        const brown = DRV.battery.brownout;
        const vAvg = (S.vL + S.vR) / 2;
        const l = sideStep(brown ? 0 : L, S.vL, vAvg, DRV.ctrlL, h, slow), r = sideStep(brown ? 0 : R, S.vR, vAvg, DRV.ctrlR, h, slow);
        const nvL = S.vL + l.a * h, nvR = S.vR + r.a * h;
        // 滾動阻力不能讓車倒退
        S.vL = Math.abs(L) < 0.02 && Math.sign(nvL) !== Math.sign(S.vL) && S.vL !== 0 ? 0 : nvL;
        S.vR = Math.abs(R) < 0.02 && Math.sign(nvR) !== Math.sign(S.vR) && S.vR !== 0 ? 0 : nvR;
        DRV.battery.update(l.Isup + r.Isup, h);
        tel.I += (Math.abs(l.I) + Math.abs(r.I)) * DRV.gb.count / N;
        tel.Isup += (l.Isup + r.Isup) / N;
        if (l.limited || r.limited) tel.limited = l.limited || r.limited;
        if (l.slip || r.slip) tel.slip = true;
      }
      S.vBus = DRV.battery.vBus; S.brownout = DRV.battery.brownout;
      S.current = tel.I; S.supply = tel.Isup; S.limited = tel.limited; S.slip = tel.slip;
      S.minV = Math.min(S.minV ?? 99, S.vBus);
    } else {
      // 馬達:目標速度 = 出力 × 極速,越接近越難加速(反電動勢);再被抓地力上限卡住
      const acc = (target, v) => Math.max(-A_MAX, Math.min(A_MAX, (target - v) / TAU));
      S.vL += acc(L * V_FREE * slow, S.vL) * dt;
      S.vR += acc(R * V_FREE * slow, S.vR) * dt;
    }
    let v = (S.vL + S.vR) / 2, w = (S.vR - S.vL) / (TRACK * SCRUB);
    pose.th += w * dt;
    pose.x += v * Math.cos(pose.th) * dt;
    pose.y -= v * Math.sin(pose.th) * dt;

    // 碰撞:牆 + 障礙物,推出去之後把「往障礙物裡鑽」的速度吃掉(輪子打滑)
    S.blocked = false;
    const hitN = [];
    const ac = Math.abs(Math.cos(pose.th)), as = Math.abs(Math.sin(pose.th));
    const extX = HX * ac + HY * as, extY = HX * as + HY * ac;       // 轉了角度的長方形車,投影到 x / y 軸的半寬
    if (pose.x < extX) { pose.x = extX; hitN.push([1, 0]); }
    if (pose.x > FIELD_W - extX) { pose.x = FIELD_W - extX; hitN.push([-1, 0]); }
    if (pose.y < extY) { pose.y = extY; hitN.push([0, 1]); }
    if (pose.y > FIELD_H - extY) { pose.y = FIELD_H - extY; hitN.push([0, -1]); }
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
    if (ENG.ready) return engineBalls(dt, t, arm, rollerDir, onCapture);
    const c = Math.cos(pose.th), s = Math.sin(pose.th);
    const ux = c, uy = -s, vx = s, vy = c;                 // 車頭方向 u、車左右 v(畫面座標)
    const front = HX + (arm > 0.3 ? 0.06 + 0.28 * arm : 0);   // 手臂放下時前面多伸出一截
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
      const inFront = lx > HX - 0.05 && lx < front + r && Math.abs(ly) < INTAKE_HALF;
      // 吸球速度上限:約每秒 11 顆(示意;原本 40ms 一顆 → 2.5 秒吸 38 顆,太誇張)
      if (inFront && arm > 0.6 && rollerDir > 0 && held < MAX_HELD && t - lastCapture > 90) {
        fieldBalls.splice(i, 1); lastCapture = t; onCapture(b);
        continue;
      }
      const fx = lx > 0 ? (Math.abs(ly) < INTAKE_HALF + 0.03 ? front : HX) : HX;
      if (lx < fx + r && lx > -HX - r && Math.abs(ly) < HY + r) {
        const penX = lx > 0 ? fx + r - lx : lx + HX + r;
        const penY = HY + r - Math.abs(ly);
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

  configure(null);
  const engineReady = engineInit();
  return { engineReady, get engine() { return ENG.ready ? ENG : null; }, drive, balls, flights, launch, predict, rangeAt, state: S, onBump, OBST, BUMPS, configure, driveSpecs,
           get dims() { return { hx: HX, hy: HY, track: TRACK, intake: INTAKE_HALF }; },
           get battery() { return DRV && DRV.battery; } };
})();
