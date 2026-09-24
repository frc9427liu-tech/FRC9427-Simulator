// ============================================================
//  🔧 機構實驗室 —— 核心(物理 + 馬達 + 電池 + 控制)
//
//  這支檔案「只算數字、不畫畫面」,所以瀏覽器和 node 都能跑(node 用來做自動測試)。
//  畫面在 mechlab-ui.js,網頁在 mechlab.html。
//
//  模組(由下往上疊):
//    1. MotorSpec / MOTORS      馬達資料庫(官方規格 → 電阻 R、轉矩常數 kT、速度常數 kV)
//    2. Gearbox                 幾顆馬達 + 減速比 + 傳動效率
//    3. MotorController         控制器的限制:電壓上限、爬升率、定子/供電電流限制(超過就降電壓)
//    4. Battery                 電池內阻 → 電流越大、電壓掉越多 → Brownout
//    5. Arm / Elevator / Flywheel   三種機構的受力(重力、摩擦、空氣阻力)
//    6. PIDController / *Feedforward / TrapezoidProfile   跟 WPILib 同一套控制器
//    7. Simulation              把上面全部接起來:每 20 ms 跑一次控制(跟 roboRIO 一樣),
//                               中間用小步長的歐拉法積分物理
//    8. StepAnalyzer            步階響應分析:上升時間、超越量、穩定時間
//
//  單位一律用 SI(公尺、公斤、秒、弧度、牛頓、牛頓米、伏特、安培、瓦特),
//  畫面上才換成 度 / RPM 這些人看得懂的單位。
// ============================================================
const MechLab = (() => {
  const G = 9.81;                          // 重力加速度(m/s²)
  const TAU = 2 * Math.PI;
  const RPM = TAU / 60;                    // 1 RPM = 2π/60 rad/s
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sgn = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

  // ==========================================================
  //  1. 馬達資料庫
  // ==========================================================
  //  有刷 / 無刷直流馬達都可以用同一個模型描述(WPILib DCMotor 也是這樣):
  //
  //      V = I·R + ω / kV          (外加電壓 = 線圈電阻壓降 + 反電動勢)
  //      τ = kT · I                (轉矩跟電流成正比)
  //
  //  三個常數都可以從官方規格反推:
  //      R  = V_nominal / I_stall                     (堵轉時 ω = 0,電壓全部掉在電阻上)
  //      kT = τ_stall / I_stall
  //      kV = ω_free / (V_nominal − R · I_free)      (空轉時只剩一點點電流克服內部摩擦)
  //
  //  thermal 是「估算」的熱模型(廠商沒公布,用外殼大小和實測經驗抓的):
  //      C  = 熱容量(J/°C):吸多少熱升 1 度
  //      Rth = 熱阻(°C/W):散熱有多難,越大越難散
  class MotorSpec {
    constructor(id, name, { freeRPM, stallTorque, stallCurrent, freeCurrent, mass, thermalC, thermalR, note = '' }) {
      Object.assign(this, { id, name, freeRPM, stallTorque, stallCurrent, freeCurrent, mass, thermalC, thermalR, note });
      this.nominalV = 12;
    }
    get freeSpeed() { return this.freeRPM * RPM; }                                     // rad/s
    get R() { return this.nominalV / this.stallCurrent; }                              // Ω
    get kT() { return this.stallTorque / this.stallCurrent; }                          // N·m/A
    get kV() { return this.freeSpeed / (this.nominalV - this.R * this.freeCurrent); }  // (rad/s)/V
    get peakPower() { return this.stallTorque * this.freeSpeed / 4; }                  // 最大機械功率在一半轉速、一半轉矩
  }

  // 規格:12 V 下的官方數字(跟 WPILib 2026 的 DCMotor 一致)
  const MOTORS = {
    krakenX60: new MotorSpec('krakenX60', 'Kraken X60', {
      freeRPM: 6000, stallTorque: 7.09, stallCurrent: 366, freeCurrent: 2, mass: 0.54, thermalC: 240, thermalR: 0.45 }),
    krakenX60FOC: new MotorSpec('krakenX60FOC', 'Kraken X60 (FOC)', {
      freeRPM: 5800, stallTorque: 9.37, stallCurrent: 483, freeCurrent: 2, mass: 0.54, thermalC: 240, thermalR: 0.45,
      note: 'Phoenix Pro 授權的磁場導向控制,轉矩更大' }),
    neoVortex: new MotorSpec('neoVortex', 'NEO Vortex', {
      freeRPM: 6784, stallTorque: 3.6, stallCurrent: 211, freeCurrent: 3.6, mass: 0.57, thermalC: 200, thermalR: 0.6 }),
    neo: new MotorSpec('neo', 'NEO V1.1', {
      freeRPM: 5676, stallTorque: 2.6, stallCurrent: 105, freeCurrent: 1.8, mass: 0.43, thermalC: 150, thermalR: 0.85,
      note: '外殼小、散熱差,長時間大電流很容易過熱' }),
    falcon500: new MotorSpec('falcon500', 'Falcon 500', {
      freeRPM: 6380, stallTorque: 4.69, stallCurrent: 257, freeCurrent: 1.5, mass: 0.5, thermalC: 210, thermalR: 0.55 }),
  };

  // ==========================================================
  //  2. 齒輪箱
  // ==========================================================
  //  ratio = 減速比(例如 25:1 就填 25):輸出轉速 = 馬達轉速 ÷ ratio、輸出轉矩 = 馬達轉矩 × ratio × 效率
  //  效率 η 只在「馬達推機構」時打折;反過來「機構推馬達」(例如手臂往下掉被馬達煞住)時,
  //  摩擦一樣是吃掉能量,所以馬達那端感受到的轉矩更小 → 輸出端要除以 η。
  class Gearbox {
    constructor(motor, count = 1, ratio = 1, efficiency = 0.85) {
      Object.assign(this, { motor, count, ratio, efficiency });
    }
    motorSpeed(outSpeed) { return outSpeed * this.ratio; }
    // 單顆馬達轉矩 → 整個齒輪箱的輸出轉矩
    outputTorque(motorTorque, motorSpeed) {
      const motoring = motorTorque * motorSpeed >= 0;           // 轉矩和轉速同方向 = 馬達在出力
      const k = motoring ? this.efficiency : 1 / this.efficiency;
      return motorTorque * this.count * this.ratio * k;
    }
    // 要輸出這麼多轉矩,單顆馬達要出多少(給前饋自動計算用,假設馬達在出力)
    motorTorqueFor(outTorque) { return outTorque / (this.count * this.ratio * this.efficiency); }
  }

  // ==========================================================
  //  3. 馬達控制器(Talon FX / SPARK Flex / SPARK MAX 都有的保護功能)
  // ==========================================================
  //  程式要求一個電壓 → 控制器依序套用:
  //    a. 爬升率(Ramp):每秒最多變多少伏特,避免瞬間暴衝
  //    b. 電池電壓上限:控制器是用 PWM 切電池電壓,最多只能給到「電池現在的電壓」
  //    c. 定子電流限制(Stator Limit):馬達線圈電流 I = (V − ω/kV) / R,超過就把電壓降到剛好等於上限
  //         → V_limited = ω/kV + sign(I) · I_limit · R      (反推 V)
  //    d. 供電電流限制(Supply Limit):從電池抽的電流 = 工作週期 × 線圈電流 = (V / V_bus) · I
  //         這是 V 的二次式,用二分法找最大的 |V|
  //  兩種限制的差別:定子限制保護馬達和輪胎打滑(轉矩直接被限制);
  //  供電限制保護電池和斷路器(低速時線圈電流可以比供電電流大很多)。
  class MotorController {
    constructor({ statorLimit = 80, supplyLimit = 60, rampRate = 0 } = {}) {
      Object.assign(this, { statorLimit, supplyLimit, rampRate });
      this.lastV = 0;
    }
    reset() { this.lastV = 0; }
    // 每個控制週期(20 ms)呼叫一次:只處理爬升率
    ramp(requestV, dt) {
      if (this.rampRate > 0) {
        const maxStep = this.rampRate * dt;
        requestV = clamp(requestV, this.lastV - maxStep, this.lastV + maxStep);
      }
      this.lastV = requestV;
      return requestV;
    }
    // 每個物理小步呼叫:依照目前轉速和電池電壓套用限制,回傳 { V, I, Isup, limited }
    apply(V, motor, motorSpeed, vBus) {
      let limited = '';
      const back = motorSpeed / motor.kV;                          // 反電動勢
      if (Math.abs(V) > vBus) { V = sgn(V) * vBus; }
      let I = (V - back) / motor.R;
      if (this.statorLimit > 0 && Math.abs(I) > this.statorLimit) {
        V = back + sgn(I) * this.statorLimit * motor.R;            // 反推剛好等於上限的電壓
        V = clamp(V, -vBus, vBus);
        I = (V - back) / motor.R;
        limited = 'stator';
      }
      const supply = v => (v / vBus) * ((v - back) / motor.R);     // 從電池抽的電流(負的 = 回充)
      if (this.supplyLimit > 0 && supply(V) > this.supplyLimit) {
        // 在 [0, |V|] 之間二分,找「供電電流剛好 = 上限」的電壓(只限制放電方向)
        let lo = 0, hi = Math.abs(V);
        const s = sgn(V);
        for (let i = 0; i < 24; i++) {
          const mid = (lo + hi) / 2;
          if (supply(s * mid) > this.supplyLimit) hi = mid; else lo = mid;
        }
        V = s * lo;
        I = (V - back) / motor.R;
        limited = limited ? 'both' : 'supply';
      }
      return { V, I, Isup: supply(V), limited };
    }
  }

  // ==========================================================
  //  4. 電池
  // ==========================================================
  //  FRC 電池(12 V 18 Ah 鉛酸)可以看成「理想電壓源 + 內阻」:
  //      V_bus = V_open − I_total · R_internal
  //  R_internal 包含電池本身(約 0.011 Ω)+ 主斷路器 + 電線 + PDH,整台車大約 0.015 ~ 0.03 Ω。
  //  roboRIO 2 在 6.75 V 以下會 Brownout:關掉所有馬達輸出,直到電壓回升。
  class Battery {
    constructor({ openV = 12.6, resistance = 0.02, baseLoad = 3 } = {}) {
      Object.assign(this, { openV, resistance, baseLoad });
      this.reset();
    }
    reset() { this.vBus = this.openV; this.brownout = false; this.usedC = 0; }
    static BROWNOUT = 6.75;
    static RECOVER = 7.5;           // 有遲滯,避免在門檻附近一直開開關關
    update(mechCurrent, dt) {
      const I = mechCurrent + this.baseLoad;                       // roboRIO、雷達、LED… 的固定耗電
      // 電池端有電容和導線電感,電壓不會瞬間跳動 → 用 1 ms 的一階濾波,也避免「電流 ↔ 電壓」互相追著跑而數值震盪
      const target = Math.max(0.5, this.openV - I * this.resistance);
      this.vBus += (target - this.vBus) * Math.min(1, dt / 0.001);
      if (this.vBus < Battery.BROWNOUT) this.brownout = true;
      else if (this.vBus > Battery.RECOVER) this.brownout = false;
      this.usedC += Math.max(0, I) * dt;                           // 庫倫(A·s),÷3.6 = mAh
      return this.vBus;
    }
  }

  // ==========================================================
  //  5. 機構
  // ==========================================================
  //  三種機構都用「輸出軸的角度 q」當狀態(手臂 = 關節角、升降 = 捲線滾筒角、飛輪 = 輪子角),
  //  所以可以共用同一套積分器:
  //      J_eff · q̈ = τ_motor + τ_load(q, q̇) − τ_friction
  //  每種機構只要回答三件事:等效轉動慣量 J_eff、負載轉矩 τ_load、行程限制。
  class Mechanism {
    constructor(params) { this.p = Object.assign({}, this.constructor.defaults, params); this.reset(); }
    reset(pos = this.startPos()) { this.q = pos; this.w = 0; this.a = 0; }
    startPos() { return 0; }
    get J() { return 1; }                          // 等效轉動慣量(kg·m²)
    loadTorque() { return 0; }                     // 重力、黏滯阻力、空氣阻力(N·m,正 = 往正方向推)
    get coulomb() { return 0; }                    // 庫倫摩擦(靜摩擦 / 動摩擦,N·m)
    limits() { return [-Infinity, Infinity]; }     // q 的行程
    // 物理小步:半隱式歐拉法(先更新速度、再用新速度更新位置,比純歐拉穩定、而且能量不會自己變多)
    integrate(tauMotor, dt) {
      const tauC = this.coulomb;
      const net = tauMotor + this.loadTorque();
      let acc;
      if (Math.abs(this.w) < 1e-4 && Math.abs(net) <= tauC) {
        acc = -this.w / dt;                        // 靜摩擦撐得住 → 停住不動
      } else {
        const dir = Math.abs(this.w) >= 1e-4 ? sgn(this.w) : sgn(net);
        acc = (net - tauC * dir) / this.J;
        // 動摩擦不能讓速度反向(只會讓它停下)
        if (Math.abs(this.w) >= 1e-4 && sgn(this.w + acc * dt) !== sgn(this.w) && Math.abs(net) <= tauC) acc = -this.w / dt;
      }
      this.w += acc * dt;
      this.q += this.w * dt;
      // 硬擋塊:撞到就停(完全非彈性碰撞)
      const [lo, hi] = this.limits();
      this.hitStop = false;
      if (this.q < lo) { this.q = lo; if (this.w < 0) this.w = 0; this.hitStop = true; }
      if (this.q > hi) { this.q = hi; if (this.w > 0) this.w = 0; this.hitStop = true; }
      this.a = acc;
    }
    // 控制器看到的「位置 / 速度」(手臂 = 弧度、升降 = 公尺、飛輪 = 轉/秒)
    get position() { return this.q; }
    get velocity() { return this.w; }
    // 畫面顯示用的單位換算
    toDisplay(v) { return v; }
    fromDisplay(v) { return v; }
    // 依物理模型算出「理想」前饋係數(控制單位)
    idealFF(gb) {
      const m = gb.motor, n = gb.count, k = m.R / (n * gb.ratio * gb.efficiency * m.kT);   // 1 N·m 輸出轉矩要幾伏特
      return this._ff(k, gb.ratio / m.kV);
    }
  }

  //  模組 A:單關節旋轉手臂
  //  ──────────────────────
  //  把手臂看成均勻細桿(質量 m、長度 L)+ 末端負載(例如夾著的球 / Coral,質量 m_end):
  //      重心力矩:τ_g = −(m · L/2 + m_end · L) · g · cos θ     (θ = 0 水平、往上為正;水平時最吃力、垂直時 = 0)
  //      轉動慣量:J = m·L²/3 + m_end·L²                         (細桿繞端點 + 質點)
  //  另外有軸承的黏滯阻力 b·ω 和庫倫摩擦。
  class Arm extends Mechanism {
    static defaults = { mass: 4, length: 0.7, endMass: 0.5, minDeg: -30, maxDeg: 150, startDeg: -30, viscous: 0.05, friction: 0.3 };
    static title = '單關節旋轉手臂';
    static unit = '°';
    static ctrlUnit = 'rad';
    startPos() { return this.p.startDeg * Math.PI / 180; }
    get J() { const { mass, length, endMass } = this.p; return mass * length * length / 3 + endMass * length * length; }
    get gravityMoment() { const { mass, length, endMass } = this.p; return (mass * length / 2 + endMass * length) * G; }   // N·m(水平時)
    loadTorque() { return -this.gravityMoment * Math.cos(this.q) - this.p.viscous * this.w; }
    get coulomb() { return this.p.friction; }
    limits() { return [this.p.minDeg * Math.PI / 180, this.p.maxDeg * Math.PI / 180]; }
    toDisplay(v) { return v * 180 / Math.PI; }
    fromDisplay(v) { return v * Math.PI / 180; }
    // ArmFeedforward:V = kS·sgn(ω) + kG·cos θ + kV·ω + kA·α
    _ff(k, kVmot) {
      return { kS: this.p.friction * k, kG: this.gravityMoment * k, kV: kVmot, kA: this.J * k };
    }
    get holdTorque() { return this.gravityMoment; }
  }

  //  模組 B:線性升降台
  //  ─────────────────
  //  馬達經過減速箱帶動半徑 r 的捲線滾筒(或鏈輪),把車架往上拉:
  //      位置 x = r · q          速度 v = r · ω
  //      重力:F_g = m · g(一直往下,跟高度無關 → 前饋是固定的 kG)
  //      滑軌摩擦:庫倫摩擦 F_c(軸承、滑塊卡住的力)+ 黏滯 c·v
  //  換到滾筒軸上:τ = F · r、J_eff = m · r²
  class Elevator extends Mechanism {
    static defaults = { mass: 8, drumRadius: 0.0254, maxHeight: 1.4, friction: 15, viscous: 5 };
    static title = '線性升降台';
    static unit = 'm';
    static ctrlUnit = 'm';
    get r() { return this.p.drumRadius; }
    get J() { return this.p.mass * this.r * this.r; }
    loadTorque() { return (-this.p.mass * G - this.p.viscous * this.w * this.r) * this.r; }
    get coulomb() { return this.p.friction * this.r; }
    limits() { return [0, this.p.maxHeight / this.r]; }
    get position() { return this.q * this.r; }
    get velocity() { return this.w * this.r; }
    // ElevatorFeedforward:V = kS·sgn(v) + kG + kV·v + kA·a(控制單位 = 公尺)
    _ff(k, kVmot) {
      const r = this.r;
      return { kS: this.p.friction * r * k, kG: this.p.mass * G * r * k, kV: kVmot / r, kA: this.p.mass * r * k };
    }
    get holdTorque() { return this.p.mass * G * this.r; }
  }

  //  模組 C:雙輪飛輪發射器
  //  ─────────────────────
  //  上下兩顆飛輪(或左右)用同一組馬達帶,看成一個轉動慣量:
  //      每顆輪子 J = ½ · m · r²(實心圓盤),兩顆相加,再加上軸、齒輪、滾筒這些「其他慣量」
  //  損失:
  //      空氣阻力(風阻)轉矩 τ_air = c_air · ω²  (越快越大,跟速度平方成正比)
  //      軸承摩擦 τ_c(固定值)
  //  射球:球被加速到出球速度,帶走動能 ½·m_ball·v²(加上球自轉的能量,實心球再多 40%),
  //  這些能量都是從飛輪的動能 ½·J·ω² 扣掉的 → 射完瞬間掉轉速,控制器要把它補回來(恢復時間)。
  class Flywheel extends Mechanism {
    static defaults = { wheelMass: 0.45, wheelRadius: 0.0508, wheels: 2, extraJ: 0.0004, airDrag: 2e-7, friction: 0.03,
                        ballMass: 0.215, exitEff: 0.5 };
    static title = '雙輪飛輪發射器';
    static unit = 'RPM';
    static ctrlUnit = 'RPS';
    get J() { const { wheelMass, wheelRadius, wheels, extraJ } = this.p; return wheels * 0.5 * wheelMass * wheelRadius * wheelRadius + extraJ; }
    loadTorque() { return -this.p.airDrag * this.w * Math.abs(this.w); }
    get coulomb() { return this.p.friction; }
    get position() { return this.q / TAU; }        // 轉
    get velocity() { return this.w / TAU; }        // 轉/秒(Phoenix 6 的單位)
    toDisplay(v) { return v * 60; }                // RPS → RPM
    fromDisplay(v) { return v / 60; }
    // SimpleMotorFeedforward:V = kS·sgn(ω) + kV·ω + kA·α(控制單位 = 轉/秒)
    _ff(k, kVmot) {
      return { kS: this.p.friction * k, kG: 0, kV: kVmot * TAU, kA: this.J * TAU * k };
    }
    get holdTorque() { return 0; }
    // 射一顆球:回傳出球速度(m/s),飛輪掉速
    shoot() {
      const { ballMass, wheelRadius, exitEff } = this.p;
      const v = Math.abs(this.w) * wheelRadius * exitEff;           // 出球速度 ≈ 輪緣速度 × 效率
      const Eball = 0.5 * ballMass * v * v * 1.4;                  // 平移 + 自轉(實心球 ×1.4)
      const Efly = 0.5 * this.J * this.w * this.w;
      const left = Math.max(0, Efly - Eball);
      this.w = sgn(this.w) * Math.sqrt(2 * left / this.J);
      return v;
    }
  }

  const MECHS = { arm: Arm, elevator: Elevator, flywheel: Flywheel };

  // ==========================================================
  //  6. 控制器(照 WPILib 的寫法)
  // ==========================================================
  //  PID:u = kP·e + kI·∫e dt + kD·de/dt
  //    - iZone:誤差太大時不累積積分(避免起步時積分爆掉 → 超越量很大,俗稱 integral windup)
  //    - 積分上限:積分項最多貢獻 ±iMax 伏特
  class PIDController {
    constructor(kP = 0, kI = 0, kD = 0, period = 0.02) {
      Object.assign(this, { kP, kI, kD, period, iZone: Infinity, iMax: 12 });
      this.reset();
    }
    reset() { this.integral = 0; this.prevErr = null; }
    calculate(measurement, setpoint) {
      const e = setpoint - measurement;
      if (Math.abs(e) > this.iZone) this.integral = 0;
      else if (this.kI) this.integral = clamp(this.integral + e * this.period, -this.iMax / this.kI, this.iMax / this.kI);
      const d = this.prevErr === null ? 0 : (e - this.prevErr) / this.period;
      this.prevErr = e;
      this.terms = { p: this.kP * e, i: this.kI * this.integral, d: this.kD * d };
      return this.terms.p + this.terms.i + this.terms.d;
    }
  }

  //  前饋(Feedforward):不用等誤差出現,直接照物理算出「要這個速度 / 加速度需要幾伏特」
  //    kS:克服靜摩擦(一定要有這麼多電壓才會開始動)
  //    kG:抵抗重力(手臂要乘 cos θ;升降台是固定值)
  //    kV:維持速度 —— 對抗反電動勢(V = ω/kV_motor)
  //    kA:產生加速度 —— F = m·a 需要的電流 × 電阻
  //  有了好的前饋,PID 只要修正「模型沒算到的小誤差」,kP 就可以小很多、不容易震盪。
  class Feedforward {
    constructor(kind, { kS = 0, kG = 0, kV = 0, kA = 0 } = {}) { Object.assign(this, { kind, kS, kG, kV, kA }); }
    calculate(pos, vel, acc) {
      const g = this.kind === 'arm' ? this.kG * Math.cos(pos) : this.kind === 'elevator' ? this.kG : 0;
      const s = Math.abs(vel) > 1e-6 ? this.kS * sgn(vel) : 0;
      this.terms = { s, g, v: this.kV * vel, a: this.kA * acc };
      return s + g + this.terms.v + this.terms.a;
    }
  }

  //  梯形運動曲線(TrapezoidProfile):不直接跳到目標,而是「加速 → 等速 → 減速」,
  //  每 20 ms 給控制器一個「現在應該在哪、速度多少」的中間目標。
  //  這樣前饋才有 v、a 可以用,而且不會一下子要求 12 V 讓電流爆表。
  class TrapezoidProfile {
    constructor(maxV, maxA) { Object.assign(this, { maxV, maxA }); }
    // 從 cur {pos, vel} 往 goal {pos, vel} 走 dt 秒,回傳新的 {pos, vel, acc}
    calculate(dt, cur, goal) {
      const dir = goal.pos >= cur.pos ? 1 : -1;
      // 轉到「往正方向走」的座標系來算,算完再轉回來
      const c = { pos: cur.pos * dir, vel: cur.vel * dir }, g = { pos: goal.pos * dir, vel: goal.vel * dir };
      if (c.vel > this.maxV) c.vel = this.maxV;
      const A = this.maxA, V = this.maxV;
      // 如果初速不是 0,把曲線往前延伸成「從靜止開始」的完整梯形
      const cutBegin = c.vel / A, cutDistBegin = cutBegin * cutBegin * A / 2;
      const cutEnd = g.vel / A, cutDistEnd = cutEnd * cutEnd * A / 2;
      const full = cutDistBegin + (g.pos - c.pos) + cutDistEnd;
      let accT = V / A;
      let fullV = full - accT * accT * A;
      if (fullV < 0) { accT = Math.sqrt(full / A); fullV = 0; }   // 距離太短:三角形(到不了最高速)
      const endAcc = accT - cutBegin, endFull = endAcc + fullV / V, endDec = endFull + accT - cutEnd;
      let out;
      if (dt < endAcc) out = { vel: c.vel + dt * A, pos: c.pos + (c.vel + dt * A / 2) * dt, acc: A };
      else if (dt < endFull) {
        out = { vel: V, pos: c.pos + (c.vel + endAcc * A / 2) * endAcc + V * (dt - endAcc), acc: 0 };
      } else if (dt <= endDec) {
        const tl = endDec - dt;
        out = { vel: g.vel + tl * A, pos: g.pos - (g.vel + tl * A / 2) * tl, acc: -A };
      } else out = { vel: g.vel, pos: g.pos, acc: 0 };
      return { pos: out.pos * dir, vel: out.vel * dir, acc: out.acc * dir };
    }
  }

  // ==========================================================
  //  8. 步階響應分析(上升時間、超越量、穩定時間、穩態誤差)
  // ==========================================================
  class StepAnalyzer {
    constructor() { this.clear(); }
    clear() { this.active = false; this.result = null; }
    start(t, from, to, tolerance) {
      Object.assign(this, { active: true, t0: t, from, to, tol: tolerance, t10: null, t90: null, peak: from, settledAt: null });
      this.result = { rise: null, overshoot: 0, settle: null, sse: null };
    }
    update(t, y) {
      if (!this.active) return;
      const span = this.to - this.from;
      if (Math.abs(span) < 1e-9) return;
      const frac = (y - this.from) / span;                         // 0 = 起點、1 = 目標
      if (this.t10 === null && frac >= 0.1) this.t10 = t;
      if (this.t90 === null && frac >= 0.9) this.t90 = t;
      if (frac > (this.peak - this.from) / span) this.peak = y;
      const inBand = Math.abs(y - this.to) <= this.tol;
      if (inBand && this.settledAt === null) this.settledAt = t;
      if (!inBand) this.settledAt = null;
      const r = this.result;
      r.rise = this.t10 !== null && this.t90 !== null ? this.t90 - this.t10 : null;
      r.overshoot = Math.max(0, ((this.peak - this.from) / span - 1) * 100);
      r.settle = this.settledAt !== null && t - this.settledAt > 0.5 ? this.settledAt - this.t0 : null;   // 要在範圍內待滿 0.5 秒才算穩定
      r.sse = y - this.to;
    }
  }

  // ==========================================================
  //  7. 模擬主體
  // ==========================================================
  //  時間軸:
  //    控制迴圈:每 dt = 0.02 s(50 Hz,跟 roboRIO 的 TimedRobot 一樣)算一次 PID + 前饋 → 要求電壓
  //    物理:把這 20 ms 再切成 substeps 個小步,每一小步用歐拉法積分
  //
  //  為什麼要切小步?FRC 馬達的「電氣時間常數」非常短:
  //    例:2 顆 Kraken、10:1、8 kg 升降台,反電動勢的阻尼時間常數 ≈ J/(n·kT/(R·kV)) ≈ 1.4 ms
  //    歐拉法的步長要小於這個值的 2 倍才穩定,直接用 20 ms 一步會數值爆炸(速度越算越大)。
  //  WPILib 的 ElevatorSim 是用矩陣指數做「精確離散化」避開這個問題;這裡用子步進,概念比較好懂。
  //  畫面上可以把子步數調成 1,親眼看看數值爆炸長什麼樣子。
  class Simulation {
    constructor(cfg = {}) {
      this.dt = 0.02;
      this.configure(cfg);
    }
    static defaultConfig(kind = 'arm') {
      const base = {
        kind,
        motor: 'krakenX60', count: 1, ratio: 50, efficiency: 0.85,
        statorLimit: 80, supplyLimit: 60, rampRate: 0,
        battery: { openV: 12.6, resistance: 0.02 },
        substeps: 40,
        mode: 'closed',            // closed = PID + 前饋、open = 固定電壓(馬達極限測試)
        openV: 12,
        mech: {},
        pid: { kP: 0, kI: 0, kD: 0, iZone: Infinity },
        ff: { kS: 0, kG: 0, kV: 0, kA: 0 },
        profile: { enabled: true, maxV: 0, maxA: 0 },
      };
      if (kind === 'arm') Object.assign(base, { motor: 'krakenX60', count: 1, ratio: 60, statorLimit: 60, supplyLimit: 40,
        pid: { kP: 18, kI: 0, kD: 0.6, iZone: Infinity }, profile: { enabled: true, maxV: 6, maxA: 18 } });
      if (kind === 'elevator') Object.assign(base, { motor: 'krakenX60', count: 2, ratio: 12, statorLimit: 80, supplyLimit: 50,
        pid: { kP: 60, kI: 0, kD: 1, iZone: Infinity }, profile: { enabled: true, maxV: 2.5, maxA: 10 } });
      if (kind === 'flywheel') Object.assign(base, { motor: 'krakenX60', count: 2, ratio: 1, statorLimit: 100, supplyLimit: 60,
        pid: { kP: 0.3, kI: 0, kD: 0, iZone: Infinity }, profile: { enabled: false, maxV: 0, maxA: 0 } });
      return base;
    }
    configure(cfg) {
      const kind = cfg.kind || 'arm';
      const c = this.cfg = Object.assign(Simulation.defaultConfig(kind), cfg);
      const Mech = MECHS[kind];
      const keepQ = this.mech && this.mech.constructor === Mech ? { q: this.mech.q, w: this.mech.w } : null;
      this.mech = new Mech(c.mech);
      if (keepQ) Object.assign(this.mech, keepQ);
      this.gearbox = new Gearbox(MOTORS[c.motor], c.count, c.ratio, c.efficiency);
      const lastV = this.ctrl ? this.ctrl.lastV : 0;                // 改參數時不要讓爬升率從 0 重來
      this.ctrl = new MotorController({ statorLimit: c.statorLimit, supplyLimit: c.supplyLimit, rampRate: c.rampRate });
      this.ctrl.lastV = lastV;
      if (!this.battery) this.battery = new Battery(c.battery);
      Object.assign(this.battery, c.battery);
      const pid = this.pid || new PIDController();
      Object.assign(pid, { kP: c.pid.kP, kI: c.pid.kI, kD: c.pid.kD, iZone: c.pid.iZone ?? Infinity });
      this.pid = pid;
      this.ff = new Feedforward(kind, c.ff);
      this.profile = c.profile.enabled && c.profile.maxV > 0 && c.profile.maxA > 0 ? new TrapezoidProfile(c.profile.maxV, c.profile.maxA) : null;
      if (!this.analyzer) this.analyzer = new StepAnalyzer();
      if (this.t === undefined) this.reset();
    }
    // 歐拉法穩定的最大步長:反電動勢像一個阻尼器 b = n·G²·η·kT/(R·kV),
    // 機構的「電氣時間常數」= J / b;歐拉法步長超過 2 倍時間常數就會數值爆炸
    stability() {
      const gb = this.gearbox, m = gb.motor;
      const b = gb.count * gb.ratio * gb.ratio * gb.efficiency * m.kT / (m.R * m.kV);
      const tau = this.mech.J / b, h = this.dt / Math.max(1, Math.round(this.cfg.substeps));
      return { tau, h, maxH: 2 * tau, stable: h < 2 * tau };
    }
    // 讓前饋係數 = 物理模型算出來的理想值(可以當調 PID 的起點)
    autoFF() { const ff = this.mech.idealFF(this.gearbox); this.cfg.ff = ff; this.ff = new Feedforward(this.cfg.kind, ff); return ff; }
    reset() {
      this.t = 0;
      this.mech.reset();
      this.ctrl.reset();
      this.pid.reset();
      this.battery.reset();
      this.analyzer.clear();
      this.goal = this.mech.position;
      this.sp = { pos: this.mech.position, vel: 0, acc: 0 };
      this.temp = 25;               // 馬達溫度(°C)
      this.peakI = 0; this.minV = this.battery.openV; this.energy = 0;
      this.out = null;
    }
    // 目標(控制單位)
    setGoal(g) {
      const [lo, hi] = this.mech.limits();
      if (this.cfg.kind === 'elevator') g = clamp(g, lo * this.mech.r, hi * this.mech.r);
      else if (this.cfg.kind === 'arm') g = clamp(g, lo, hi);
      this.goal = g;
      if (!this.profile) this.sp = { pos: g, vel: 0, acc: 0 };
      const tol = this.cfg.kind === 'arm' ? 2 * Math.PI / 180 : this.cfg.kind === 'elevator' ? 0.02 : Math.max(50 / 60, Math.abs(g) * 0.02);
      const cur = this.cfg.kind === 'flywheel' ? this.mech.velocity : this.mech.position;
      this.analyzer.start(this.t, cur, g, tol);
    }
    // 跑一個控制週期(20 ms)
    step() {
      const c = this.cfg, m = this.mech, dt = this.dt, kind = c.kind;
      const flywheel = kind === 'flywheel';
      // ---- 控制:PID + 前饋 ----
      let request, ffV = 0, pidV = 0;
      if (c.mode === 'open') {
        request = c.openV;
      } else if (flywheel) {
        this.sp = { pos: this.goal, vel: this.goal, acc: 0 };
        ffV = this.ff.calculate(0, this.goal, 0);
        pidV = this.pid.calculate(m.velocity, this.goal);
        request = ffV + pidV;
      } else {
        if (this.profile) this.sp = this.profile.calculate(dt, this.sp, { pos: this.goal, vel: 0 });
        ffV = this.ff.calculate(this.sp.pos, this.sp.vel, this.sp.acc);
        pidV = this.pid.calculate(m.position, this.sp.pos);
        request = ffV + pidV;
      }
      request = clamp(request, -12, 12);            // 程式端的電壓上限(voltage compensation 到 12 V)
      request = this.ctrl.ramp(request, dt);
      if (this.battery.brownout) request = 0;       // Brownout:roboRIO 關掉馬達輸出

      // ---- 物理:子步進 ----
      const N = Math.max(1, Math.round(c.substeps)), h = dt / N;
      const gb = this.gearbox, mot = gb.motor, n = gb.count;
      const acc = { V: 0, I: 0, Isup: 0, pIn: 0, pOut: 0, pCu: 0, pGear: 0, limited: '', vBus: 0 };
      for (let i = 0; i < N; i++) {
        const wm = gb.motorSpeed(m.w);
        const r = this.ctrl.apply(request, mot, wm, this.battery.vBus);
        const tauM = mot.kT * r.I;                                        // 單顆馬達轉矩
        const tauOut = gb.outputTorque(tauM, wm);
        m.integrate(tauOut, h);
        this.battery.update(n * r.Isup, h);
        // 功率帳:電池給的 = 銅損(I²R)+ 馬達機械功率;機械功率再扣掉齒輪箱損失才是機構拿到的
        const pMotorMech = n * tauM * wm;
        const pOut = tauOut * m.w;
        const pCu = n * r.I * r.I * mot.R;
        acc.V += r.V; acc.I += r.I; acc.Isup += n * r.Isup; acc.vBus += this.battery.vBus;
        acc.pIn += n * r.V * r.I; acc.pOut += pOut; acc.pCu += pCu; acc.pGear += Math.abs(pMotorMech - pOut);
        if (r.limited) acc.limited = r.limited;
        // 馬達溫度:C·dT/dt = 每顆的銅損 − (T − 室溫)/Rth
        this.temp += (r.I * r.I * mot.R - (this.temp - 25) / mot.thermalR) / mot.thermalC * h;
        if (!Number.isFinite(m.q) || !Number.isFinite(m.w) || Math.abs(m.w) > 1e7) { this.diverged = true; m.reset(); break; }
      }
      for (const k of ['V', 'I', 'Isup', 'pIn', 'pOut', 'pCu', 'pGear', 'vBus']) acc[k] /= N;
      this.t += dt;
      this.energy += acc.pIn * dt;
      this.peakI = Math.max(this.peakI, Math.abs(acc.I));
      this.minV = Math.min(this.minV, acc.vBus);
      const measured = flywheel ? m.velocity : m.position;
      this.analyzer.update(this.t, measured);
      this.out = {
        t: this.t,
        actual: m.toDisplay(measured),
        goal: m.toDisplay(this.goal),
        setpoint: m.toDisplay(flywheel ? this.goal : this.sp.pos),
        request, ffV, pidV,
        vApplied: acc.V, vBus: acc.vBus,
        iStator: acc.I, iStatorTotal: acc.I * n, iSupply: acc.Isup,
        pIn: acc.pIn, pOut: acc.pOut, pHeat: acc.pCu + acc.pGear,
        temp: this.temp,
        limited: acc.limited, brownout: this.battery.brownout, hitStop: m.hitStop,
        motorRPM: gb.motorSpeed(m.w) / RPM,
      };
      return this.out;
    }
  }

  return { G, RPM, MotorSpec, MOTORS, Gearbox, MotorController, Battery, Mechanism, Arm, Elevator, Flywheel, MECHS,
           PIDController, Feedforward, TrapezoidProfile, StepAnalyzer, Simulation };
})();
if (typeof module !== 'undefined') module.exports = MechLab;
