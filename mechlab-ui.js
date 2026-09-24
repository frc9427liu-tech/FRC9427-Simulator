// ============================================================
//  🔧 機構實驗室 —— 畫面
//    - 左邊:機構動畫(MechRenderer)、目標步階、數據卡片、參數面板
//    - 右邊:四張即時遙測圖(TelemetryChart),滑鼠 / 手指移上去會顯示該時間點的數值
//  物理和控制都在 mechlab-core.js,這裡只負責「接參數、跑迴圈、畫出來」。
// ============================================================
(() => {
  const { Simulation, MOTORS } = MechLab;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));

  // ---------- 顏色(從 CSS 變數讀,深色 / 淺色模式自動切換) ----------
  const C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ['text', 'text2', 'muted', 'line', 'grid', 'panel', 'panel2', 's1', 's2', 's3', 'ref', 'good', 'warn', 'bad', 'metal', 'metal2', 'accent'])
      C[k] = cs.getPropertyValue('--' + k).trim();
  }
  readColors();
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors); } catch {}

  // ---------- 這台電腦記住上次的設定(失敗就算了,不影響使用) ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };

  // ---------- 每種機構的目標預設值(顯示單位) ----------
  const KIND = {
    arm:      { presets: [-30, 0, 45, 90, 135], auto: [0, 90], first: 90, step: 1, cu: 'rad', vu: 'rad/s', au: 'rad/s²' },
    elevator: { presets: [0, 0.3, 0.7, 1.0, 1.4], auto: [0.2, 1.2], first: 1.0, step: 0.01, cu: 'm', vu: 'm/s', au: 'm/s²' },
    flywheel: { presets: [0, 2000, 3500, 5000], auto: [3000, 5000], first: 4000, step: 50, cu: 'RPS', vu: 'RPS', au: 'RPS/s' },
  };

  // ---------- 狀態 ----------
  let kind = store.get('mechlab-kind');
  if (!KIND[kind]) kind = 'arm';
  let sim, buf = [];
  const MAXBUF = 1600;                    // 32 秒 × 50 Hz
  let running = true, speed = 1, winSec = 10;
  let autoStep = false, autoNext = 0, autoIdx = 0;
  let balls = [], lastExit = null, burstLeft = 0, burstNext = 0;
  let divergedT = -1;
  let visAng = 0;                          // 飛輪動畫的轉角(只給眼睛看,不是真的角度)

  // ==========================================================
  //  參數面板
  // ==========================================================
  //  每個欄位:path = 在 sim.cfg 裡的位置('mech.xxx' 會讀 sim.mech.p 的預設值)
  const F = (path, label, unit, o = {}) => Object.assign({ path, label, unit }, o);
  function schema() {
    const k = KIND[kind], cu = k.cu;
    const isFly = kind === 'flywheel';
    const mech = {
      arm: [
        F('mech.mass', '手臂質量', 'kg', { step: 0.1, min: 0 }),
        F('mech.length', '手臂長度(樞紐到末端)', 'm', { step: 0.01, min: 0.05 }),
        F('mech.endMass', '末端負載(夾著的東西)', 'kg', { step: 0.1, min: 0 }),
        F('mech.minDeg', '下限擋塊', '°', { step: 1 }),
        F('mech.maxDeg', '上限擋塊', '°', { step: 1 }),
        F('mech.startDeg', '起始角度(重置時)', '°', { step: 1 }),
        F('mech.friction', '關節庫倫摩擦', 'N·m', { step: 0.05, min: 0 }),
        F('mech.viscous', '黏滯阻尼', 'N·m·s/rad', { step: 0.01, min: 0 }),
      ],
      elevator: [
        F('mech.mass', '車架 + 負載質量', 'kg', { step: 0.1, min: 0.1 }),
        F('mech.drumRadius', '捲線滾筒 / 鏈輪半徑', 'm', { step: 0.001, min: 0.005 }),
        F('mech.maxHeight', '最大行程', 'm', { step: 0.05, min: 0.1 }),
        F('mech.friction', '滑軌庫倫摩擦', 'N', { step: 1, min: 0 }),
        F('mech.viscous', '滑軌黏滯阻尼', 'N·s/m', { step: 0.5, min: 0 }),
      ],
      flywheel: [
        F('mech.wheels', '飛輪數量', '顆', { step: 1, min: 1 }),
        F('mech.wheelMass', '每顆飛輪質量', 'kg', { step: 0.01, min: 0.01 }),
        F('mech.wheelRadius', '飛輪半徑', 'm', { step: 0.001, min: 0.01 }),
        F('mech.extraJ', '其他轉動慣量(軸、齒輪)', 'kg·m²', { step: 0.0001, min: 0 }),
        F('mech.airDrag', '風阻係數 c(τ = c·ω²)', 'N·m·s²', { step: 1e-8, min: 0 }),
        F('mech.friction', '軸承摩擦', 'N·m', { step: 0.005, min: 0 }),
        F('mech.ballMass', '球的質量', 'kg', { step: 0.005, min: 0 }),
        F('mech.exitEff', '出球效率(球速 ÷ 輪緣速度)', '', { step: 0.05, min: 0.05, max: 1 }),
      ],
    }[kind];
    return [
      { id: 'motor', title: '⚙️ 馬達與傳動', fields: [
        F('motor', '馬達型號', '', { type: 'motor' }),
        F('count', '馬達數量', '顆', { step: 1, min: 1, max: 8 }),
        F('ratio', '減速比', ': 1', { step: 0.5, min: 0.1 }),
        F('efficiency', '齒輪箱效率', '%', { step: 1, min: 10, max: 100, scale: 100 }),
        F('statorLimit', '定子電流限制(每顆)', 'A', { step: 5, min: 0, help: '0 = 不限制' }),
        F('supplyLimit', '供電電流限制(每顆)', 'A', { step: 5, min: 0, help: '0 = 不限制' }),
        F('rampRate', '電壓爬升率', 'V/s', { step: 6, min: 0, help: '0 = 不限制' }),
      ], extra: 'motorSpec' },
      { id: 'mech', title: `🦾 機構(${MechLab.MECHS[kind].title})`, fields: mech, extra: 'mechSpec' },
      { id: 'ctrl', title: '🎛️ PID + 前饋', fields: [
        F('mode', '控制模式', '', { type: 'mode' }),
        F('openV', '開迴圈電壓(極限測試)', 'V', { step: 0.5, min: -12, max: 12 }),
        F('pid.kP', 'kP', `V/${cu}`, { step: 0.01 }),
        F('pid.kI', 'kI', `V/(${cu}·s)`, { step: 0.01 }),
        F('pid.kD', 'kD', `V·s/${cu}`, { step: 0.01 }),
        F('pid.iZone', 'iZone(誤差超過就不積分)', cu, { step: 0.01, min: 0, blankInf: true, help: '空白 = 不限' }),
        F('ff.kS', 'kS 靜摩擦', 'V', { step: 0.001 }),
        ...(isFly ? [] : [F('ff.kG', kind === 'arm' ? 'kG 重力(× cos θ)' : 'kG 重力', 'V', { step: 0.001 })]),
        F('ff.kV', 'kV 速度', `V/(${k.vu})`, { step: 0.001 }),
        F('ff.kA', 'kA 加速度', `V/(${k.au})`, { step: 0.0001 }),
        ...(isFly ? [] : [
          F('profile.enabled', '梯形運動曲線', '', { type: 'check' }),
          F('profile.maxV', '曲線最高速度', k.vu, { step: 0.1, min: 0 }),
          F('profile.maxA', '曲線最大加速度', k.au, { step: 0.5, min: 0 }),
        ]),
      ], extra: 'ctrlActs' },
      { id: 'batt', title: '🔋 電池', fields: [
        F('battery.openV', '開路電壓(充飽 12.8、快沒電 12.0)', 'V', { step: 0.1, min: 10, max: 13.5 }),
        F('battery.resistance', '內阻 + 線路電阻', 'Ω', { step: 0.001, min: 0.001, help: '新電池約 0.015,舊電池 0.03 以上' }),
      ] },
      { id: 'sim', title: '🧮 數值積分', fields: [
        F('substeps', '每 20 ms 切幾個物理小步', '步', { step: 1, min: 1, max: 200 }),
      ], extra: 'stability' },
    ];
  }

  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  function setPath(obj, path, v) {
    const ks = path.split('.'), last = ks.pop();
    let o = obj;
    for (const k of ks) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[last] = v;
  }
  const readField = f => (f.path.startsWith('mech.') ? sim.mech.p[f.path.slice(5)] : getPath(sim.cfg, f.path));

  let openSecs = new Set(store.get('mechlab-open') || ['motor', 'ctrl']);
  function buildParams() {
    const host = $('params');
    host.innerHTML = schema().map(sec => `
      <details class="sec" data-sec="${sec.id}"${openSecs.has(sec.id) ? ' open' : ''}>
        <summary>${esc(sec.title)}</summary>
        <div class="fields">${sec.fields.map(fieldHtml).join('')}</div>
        ${sec.extra ? `<div data-extra="${sec.extra}"></div>` : ''}
      </details>`).join('');
    host.querySelectorAll('details').forEach(d => d.addEventListener('toggle', () => {
      if (d.open) openSecs.add(d.dataset.sec); else openSecs.delete(d.dataset.sec);
      store.set('mechlab-open', [...openSecs]);
    }));
    host.querySelectorAll('[data-path]').forEach(el => el.addEventListener('change', () => onField(el)));
    fillExtras();
  }
  function fieldHtml(f) {
    const v = readField(f);
    const help = f.help ? ` <em>(${esc(f.help)})</em>` : '';
    if (f.type === 'motor') {
      return `<label class="field"><span>${esc(f.label)}</span><select data-path="motor">${Object.values(MOTORS).map(m =>
        `<option value="${m.id}"${m.id === v ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'mode') {
      return `<label class="field"><span>${esc(f.label)}</span><select data-path="mode">
        <option value="closed"${v === 'closed' ? ' selected' : ''}>閉迴圈:PID + 前饋</option>
        <option value="open"${v === 'open' ? ' selected' : ''}>開迴圈:固定電壓(馬達極限測試)</option></select></label>`;
    }
    if (f.type === 'check') {
      return `<label class="field"><span>${esc(f.label)}</span><span class="row"><input type="checkbox" data-path="${f.path}"${v ? ' checked' : ''}> 啟用</span></label>`;
    }
    let shown = v;
    if (f.blankInf && (v == null || !Number.isFinite(v))) shown = '';
    else if (f.scale) shown = +(v * f.scale).toFixed(6);
    else if (typeof v === 'number') shown = +v.toPrecision(6);
    const attrs = ['step', 'min', 'max'].filter(a => f[a] !== undefined).map(a => `${a}="${f[a]}"`).join(' ');
    return `<label class="field"><span>${esc(f.label)}${help}</span><span class="row">
      <input type="number" data-path="${f.path}" ${attrs} value="${shown ?? ''}"${f.blankInf ? ' placeholder="不限"' : ''}>
      ${f.unit ? `<span class="u">${esc(f.unit)}</span>` : ''}</span></label>`;
  }
  function onField(el) {
    const path = el.dataset.path;
    const f = schema().flatMap(s => s.fields).find(x => x.path === path);
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.tagName === 'SELECT') v = el.value;
    else {
      if (el.value === '' && f && f.blankInf) v = Infinity;
      else {
        v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        if (f && f.min !== undefined && v < f.min) v = f.min;
        if (f && f.max !== undefined && v > f.max) v = f.max;
        if (f && f.scale) v /= f.scale;
        if (path === 'count' || path === 'mech.wheels' || path === 'substeps') v = Math.max(1, Math.round(v));
      }
    }
    setPath(sim.cfg, path, v);
    sim.configure(sim.cfg);
    // 行程改了:目標要落在新的行程裡
    if (path.startsWith('mech.') && kind !== 'flywheel') sim.setGoal(sim.goal);
    saveCfg();
    fillExtras();
  }
  function saveCfg() { store.set('mechlab-cfg-' + kind, sim.cfg); }

  // 參數面板下面的「說明 / 計算結果」
  function fillExtras() {
    const gb = sim.gearbox, m = gb.motor, mech = sim.mech;
    const put = (id, html) => { const el = document.querySelector(`[data-extra="${id}"]`); if (el) el.innerHTML = html; };
    // 馬達:規格 + 反推常數 + 這組傳動的極限
    const outFree = m.freeRPM / gb.ratio;
    const stallOut = m.stallTorque * gb.count * gb.ratio * gb.efficiency;
    let limitLine = '';
    if (kind === 'elevator') limitLine = `輸出極速 ${fmt(outFree * MechLab.RPM * mech.r, 2)} m/s · 最大拉力 ${fmt(stallOut / mech.r, 0)} N`;
    else limitLine = `輸出極速 ${fmt(outFree, 0)} RPM · 堵轉輸出轉矩 ${fmt(stallOut, 1)} N·m`;
    let hold = '';
    if (mech.holdTorque > 0) {
      const I = gb.motorTorqueFor(mech.holdTorque) / m.kT;
      const lim = sim.cfg.statorLimit;
      const bad = lim > 0 && I > lim;
      hold = `<br>${kind === 'arm' ? '撐住水平手臂' : '撐住升降台'}需要每顆 <b>${fmt(I, 1)} A</b>` +
        (bad ? ` <span style="color:var(--bad)">⛔ 超過定子電流限制 ${lim} A:舉不起來!加減速比或加馬達</span>` : lim > 0 ? `(限制 ${lim} A 的 ${fmt(I / lim * 100, 0)}%)` : '');
    }
    put('motorSpec', `<div class="spec"><b>${esc(m.name)}</b> @ 12 V:自由轉速 ${m.freeRPM} RPM · 堵轉轉矩 ${m.stallTorque} N·m · 堵轉電流 ${m.stallCurrent} A · 空轉電流 ${m.freeCurrent} A
      <br>反推:R = ${fmt(m.R, 4)} Ω · kT = ${fmt(m.kT, 4)} N·m/A · kV = ${fmt(m.kV, 1)} rad/s/V · 最大功率 ${fmt(m.peakPower, 0)} W
      <br>${limitLine}${hold}${m.note ? `<br>💡 ${esc(m.note)}` : ''}</div>`);
    // 機構:慣量、重力矩
    let ms = `等效轉動慣量 J = ${mech.J.toExponential(2)} kg·m²(在輸出軸上)`;
    if (kind === 'arm') ms += ` · 水平時重力矩 ${fmt(mech.gravityMoment, 1)} N·m`;
    if (kind === 'elevator') ms += ` · 重力 ${fmt(mech.p.mass * MechLab.G, 0)} N → 滾筒上 ${fmt(mech.holdTorque, 2)} N·m`;
    if (kind === 'flywheel') ms += ` · 在 4000 RPM 存了 ${fmt(0.5 * mech.J * (4000 * MechLab.RPM) ** 2, 0)} J 動能`;
    put('mechSpec', `<div class="spec">${ms}</div>`);
    // 控制:自動前饋按鈕
    const ideal = mech.idealFF(gb);
    put('ctrlActs', `<div class="acts">
        <button type="button" id="autoFF" title="用馬達規格 + 機構質量直接算出理想的 kS/kG/kV/kA">🧮 依物理模型自動算前饋</button>
        <button type="button" id="zeroFF">前饋歸零(只用 PID)</button>
        <button type="button" id="resetCfg" title="這個機構的所有參數回到預設值">↺ 參數回預設</button>
      </div>
      <p class="help">理想值:kS ${fmt(ideal.kS, 3)} · ${kind === 'flywheel' ? '' : `kG ${fmt(ideal.kG, 3)} · `}kV ${fmt(ideal.kV, 3)} · kA ${fmt(ideal.kA, 4)}。
      前饋負責「照物理算好的電壓」,PID 只修正剩下的誤差。先把 kP 以外的都設好,再慢慢加 kP 到不震盪為止。</p>`);
    $('autoFF').onclick = () => { sim.autoFF(); saveCfg(); buildParams(); };
    $('zeroFF').onclick = () => { sim.cfg.ff = { kS: 0, kG: 0, kV: 0, kA: 0 }; sim.configure(sim.cfg); saveCfg(); buildParams(); };
    $('resetCfg').onclick = () => { store.del('mechlab-cfg-' + kind); loadKind(kind, true); };
    // 數值積分穩定度
    const st = sim.stability();
    put('stability', `<div class="spec">子步長 h = ${fmt(st.h * 1000, 2)} ms · 電氣時間常數 τ = J/b = ${fmt(st.tau * 1000, 2)} ms
      → ${st.stable ? '<span style="color:var(--good)">✅ 穩定(h &lt; 2τ)</span>' : `<span style="color:var(--bad)">⚠️ h 超過 2τ = ${fmt(st.maxH * 1000, 2)} ms,歐拉法會數值爆炸</span>`}
      <br>反電動勢會像阻尼器一樣抵抗轉動,這個時間常數通常只有幾毫秒,所以 20 ms 一步的純歐拉法會算爆。
      把子步數改成 1 可以親眼看看(WPILib 的模擬是用矩陣指數精確離散化來避開這個問題)。</div>`);
  }

  // ==========================================================
  //  目標(Target Step)列
  // ==========================================================
  function buildTargets() {
    const k = KIND[kind], unit = MechLab.MECHS[kind].unit;
    $('targets').innerHTML = `<span class="lbl">🎯 目標</span>
      ${k.presets.map(p => `<button type="button" data-goal="${p}">${p}${unit === '°' ? '°' : ' ' + unit}</button>`).join('')}
      <label><input type="number" id="goalIn" step="${k.step}" style="width:90px"> ${esc(unit)}</label>
      <button type="button" id="goalGo">設定</button>
      <label title="每 3 秒在兩個目標之間來回跳,方便觀察步階響應"><input type="checkbox" id="autoChk"${autoStep ? ' checked' : ''}> 自動步階</label>
      ${kind === 'flywheel' ? `<button type="button" id="shootBtn">🟡 射一顆</button><button type="button" id="burstBtn">連射 ×5</button>` : ''}`;
    $('targets').querySelectorAll('[data-goal]').forEach(b => b.onclick = () => setGoalDisplay(+b.dataset.goal));
    $('goalGo').onclick = () => { const v = parseFloat($('goalIn').value); if (Number.isFinite(v)) setGoalDisplay(v); };
    $('goalIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('goalGo').click(); });
    $('autoChk').onchange = e => { autoStep = e.target.checked; autoNext = sim.t; };
    if (kind === 'flywheel') {
      $('shootBtn').onclick = () => feedBall();
      $('burstBtn').onclick = () => { burstLeft = 5; burstNext = sim.t; };
    }
  }
  function setGoalDisplay(v) {
    sim.setGoal(sim.mech.fromDisplay(v));
    $('goalIn').value = +sim.mech.toDisplay(sim.goal).toFixed(3);
    if (sim.cfg.mode === 'open') { sim.cfg.mode = 'closed'; saveCfg(); buildParams(); }
  }

  // 飛輪:從左邊送一顆球進兩輪之間
  function feedBall() { balls.push({ x: -0.35, v: 2.5, shot: false, y: 0 }); }

  // ==========================================================
  //  遙測圖
  // ==========================================================
  //  一張圖 = 一個量(單一 Y 軸,不做雙軸);最多 3 條線 + 灰色虛線參考線(目標、上限)
  class TelemetryChart {
    constructor(host, opt) {
      this.opt = opt;
      host.innerHTML = `<div class="hd"><span class="ttl">${esc(opt.title)}<small>${esc(opt.unit)}</small></span>
        <span class="legend">${opt.series.map(s => `<span><i style="border-color:var(--${s.color})"></i>${esc(s.label)}</span>`).join('')}
        ${(opt.refLegend || []).map(l => `<span><i class="dash" style="border-color:var(--ref)"></i>${esc(l)}</span>`).join('')}</span></div>
        <canvas></canvas>`;
      this.cv = host.querySelector('canvas');
      this.ctx = this.cv.getContext('2d');
      this.pad = { l: 46, r: 10, t: 8, b: 18 };
      const move = e => {
        const r = this.cv.getBoundingClientRect();
        hover = { chart: this, fx: (e.clientX - r.left - this.pad.l) / (r.width - this.pad.l - this.pad.r), cx: e.clientX, cy: e.clientY };
      };
      this.cv.addEventListener('pointermove', move);
      this.cv.addEventListener('pointerdown', move);
      this.cv.addEventListener('pointerleave', () => { if (hover && hover.chart === this) hover = null; });
    }
    fit() {
      const dpr = window.devicePixelRatio || 1, w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
        this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr);
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return [w, h];
    }
    draw(data, tEnd, win, hoverT) {
      const [W, H] = this.fit(), ctx = this.ctx, p = this.pad, o = this.opt;
      ctx.clearRect(0, 0, W, H);
      const t0 = tEnd - win;
      // 找出畫面裡的資料(二分搜尋起點)
      let lo = 0, hi = data.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (data[mid].t < t0) lo = mid + 1; else hi = mid; }
      const vis = data.slice(Math.max(0, lo - 1));
      const refs = o.refs ? o.refs() : [];
      // Y 範圍
      let ymin, ymax;
      if (o.fixed) [ymin, ymax] = o.fixed;
      else {
        ymin = Infinity; ymax = -Infinity;
        for (const d of vis) for (const s of o.series) { const v = d[s.key]; if (Number.isFinite(v)) { if (v < ymin) ymin = v; if (v > ymax) ymax = v; } }
        for (const r of refs) if (r.value >= ymin - Math.abs(ymax - ymin) * 0.6 && r.value <= ymax + Math.abs(ymax - ymin) * 0.6) { ymin = Math.min(ymin, r.value); ymax = Math.max(ymax, r.value); }
        if (!Number.isFinite(ymin)) { ymin = 0; ymax = 1; }
        if (o.zero) { ymin = Math.min(0, ymin); ymax = Math.max(0, ymax); }
        const span = ymax - ymin || Math.max(1, Math.abs(ymax) * 0.2);
        ymin -= span * 0.08; ymax += span * 0.08;
        if (ymax === ymin) { ymin -= 1; ymax += 1; }
      }
      const X = t => p.l + (t - t0) / win * (W - p.l - p.r);
      const Y = v => p.t + (1 - (v - ymin) / (ymax - ymin)) * (H - p.t - p.b);
      // 格線 + Y 刻度
      const step = niceStep((ymax - ymin) / 4);
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 1;
      for (let v = Math.ceil(ymin / step) * step; v <= ymax + 1e-9; v += step) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.strokeStyle = Math.abs(v) < step * 1e-6 ? C.line : C.grid;
        ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
        ctx.fillStyle = C.muted;
        ctx.fillText(tickLabel(v, step), p.l - 6, y);
      }
      // X 刻度(模擬時間,秒)
      const xs = win <= 10 ? 1 : 5;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let t = Math.ceil(Math.max(0, t0) / xs) * xs; t <= tEnd; t += xs) {
        const x = X(t);
        if (x < p.l + 8) continue;
        ctx.fillStyle = C.muted; ctx.fillText(t + 's', x, H - p.b + 4);
      }
      // 參考線(灰色虛線)
      ctx.save();
      ctx.beginPath(); ctx.rect(p.l, p.t, W - p.l - p.r, H - p.t - p.b); ctx.clip();
      ctx.setLineDash([5, 4]); ctx.strokeStyle = C.ref; ctx.lineWidth = 1.5;
      for (const r of refs) {
        if (r.value < ymin || r.value > ymax) continue;
        const y = Y(r.value);
        ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(W - p.r, y); ctx.stroke();
        if (r.label) {
          const below = y - p.t < 14;                  // 太靠上面:字寫在線下面,才不會被切掉
          ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = below ? 'top' : 'bottom';
          ctx.fillText(r.label, W - p.r - 4, below ? y + 3 : y - 2);
        }
      }
      // 資料線
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const s of o.series) {
        ctx.setLineDash(s.dash ? [6, 4] : []);
        ctx.strokeStyle = s.color === 'ref' ? C.ref : C[s.color];
        ctx.lineWidth = s.width || 2;
        ctx.beginPath();
        let started = false;
        for (const d of vis) {
          const v = d[s.key];
          if (!Number.isFinite(v)) { started = false; continue; }
          const x = X(d.t), y = Y(Math.max(ymin - (ymax - ymin), Math.min(ymax + (ymax - ymin), v)));
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      // 游標十字線 + 點
      if (hoverT !== null && hoverT >= t0 && hoverT <= tEnd && vis.length) {
        const d = nearest(vis, hoverT), x = X(d.t);
        ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, p.t); ctx.lineTo(x, H - p.b); ctx.stroke();
        for (const s of o.series) {
          const v = d[s.key]; if (!Number.isFinite(v) || v < ymin || v > ymax) continue;
          ctx.fillStyle = s.color === 'ref' ? C.ref : C[s.color]; ctx.strokeStyle = C.panel; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, Y(v), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        this.hoverSample = d;
      } else this.hoverSample = null;
      ctx.restore();
    }
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / e;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
  }
  function tickLabel(v, step) {
    const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
    const a = Math.abs(v);
    if (a >= 10000) return (v / 1000).toFixed(0) + 'k';
    return (Math.abs(v) < step * 1e-6 ? 0 : v).toFixed(d);
  }
  function nearest(arr, t) {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
    return lo > 0 && Math.abs(arr[lo - 1].t - t) < Math.abs(arr[lo].t - t) ? arr[lo - 1] : arr[lo];
  }

  let charts = [], hover = null;
  function buildCharts() {
    const u = MechLab.MECHS[kind].unit, fly = kind === 'flywheel';
    const n = () => sim.gearbox.count;
    charts = [
      new TelemetryChart($('c1'), {
        title: fly ? '① 轉速:實際 vs 目標' : '① 位置:實際 vs 目標', unit: u,
        series: [
          { key: 'actual', label: fly ? '實際轉速' : '實際位置', color: 's1', width: 2.5 },
          ...(fly ? [] : [{ key: 'setpoint', label: '運動曲線設定點', color: 's2' }]),
          { key: 'goal', label: '目標 Target', color: 'ref', dash: true, width: 1.5 },
        ],
        digits: fly ? 0 : kind === 'arm' ? 1 : 3,
      }),
      new TelemetryChart($('c2'), {
        title: '② 電壓', unit: 'V', fixed: [-13.5, 13.5],
        series: [
          { key: 'vApplied', label: '馬達輸出電壓', color: 's1' },
          { key: 'vBus', label: '電池電壓', color: 's2' },
          { key: 'request', label: '程式要求電壓', color: 's3', width: 1.5 },
        ],
        refs: () => [{ value: 6.75, label: 'Brownout 6.75 V' }], refLegend: ['Brownout'], digits: 2,
      }),
      new TelemetryChart($('c3'), {
        title: '③ 電流', unit: 'A', zero: true,
        series: [
          { key: 'iStatorTotal', label: `馬達電流(${n()} 顆合計)`, color: 's1' },
          { key: 'iSupply', label: '電池供電電流', color: 's2' },
        ],
        refs: () => [
          ...(sim.cfg.statorLimit > 0 ? [{ value: sim.cfg.statorLimit * n(), label: '定子上限' }, { value: -sim.cfg.statorLimit * n(), label: '' }] : []),
          ...(sim.cfg.supplyLimit > 0 ? [{ value: sim.cfg.supplyLimit * n(), label: '供電上限' }] : []),
        ],
        refLegend: ['電流限制'], digits: 1,
      }),
      new TelemetryChart($('c4'), {
        title: '④ 功率與發熱', unit: 'W', zero: true,
        series: [
          { key: 'pIn', label: '電池輸入功率', color: 's1' },
          { key: 'pOut', label: '機構輸出功率', color: 's2' },
          { key: 'pHeat', label: '發熱(銅損 + 齒輪)', color: 's3' },
        ],
        digits: 0,
      }),
    ];
  }
  function drawCharts() {
    const tEnd = Math.max(winSec, sim.t);
    let hoverT = null;
    if (hover) hoverT = tEnd - winSec + Math.max(0, Math.min(1, hover.fx)) * winSec;
    for (const c of charts) c.draw(buf, tEnd, winSec, hoverT);
    const tip = $('tip');
    const hc = hover && hover.chart;
    if (hc && hc.hoverSample) {
      const d = hc.hoverSample, o = hc.opt;
      tip.innerHTML = `<b>t = ${d.t.toFixed(2)} s</b>` + o.series.map(s =>
        `<div class="r"><i style="border-color:${s.color === 'ref' ? C.ref : C[s.color]}${s.dash ? ';border-top-style:dashed' : ''}"></i><span>${esc(s.label)}</span><span>${fmt(d[s.key], o.digits)} ${esc(o.unit)}</span></div>`).join('');
      tip.style.display = 'block';
      const r = tip.getBoundingClientRect();
      let x = hover.cx + 14, y = hover.cy + 14;
      if (x + r.width > innerWidth - 8) x = hover.cx - r.width - 14;
      if (y + r.height > innerHeight - 8) y = hover.cy - r.height - 14;
      tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, y) + 'px';
    } else tip.style.display = 'none';
  }

  // ==========================================================
  //  數據卡片 + 狀態標籤
  // ==========================================================
  function updateTiles() {
    const o = sim.out, a = sim.analyzer.result, u = MechLab.MECHS[kind].unit, fly = kind === 'flywheel';
    const d = fly ? 0 : kind === 'arm' ? 1 : 3;
    const tile = (k, v, unit, cls = '') => `<div class="tile ${cls}"><div class="k">${esc(k)}</div><div class="v">${v}<small>${esc(unit)}</small></div></div>`;
    if (!o) { $('tiles').innerHTML = ''; return; }
    const err = o.goal - o.actual;
    const temp = o.temp;
    const mAh = sim.battery.usedC / 3.6;
    $('tiles').innerHTML = [
      tile(fly ? '實際轉速' : '實際位置', fmt(o.actual, d), u),
      tile('目標', fmt(o.goal, d), u),
      tile('誤差', fmt(err, d), u, Math.abs(err) > Math.abs(o.goal) * 0.1 + (fly ? 100 : kind === 'arm' ? 3 : 0.03) ? 'warn' : ''),
      tile('上升時間', fmt(a && a.rise, 2), 's'),
      tile('超越量', fmt(a && a.overshoot, 1), '%', a && a.overshoot > 10 ? 'warn' : ''),
      tile('穩定時間', fmt(a && a.settle, 2), 's'),
      tile('馬達電壓', fmt(o.vApplied, 2), 'V'),
      tile('每顆電流', fmt(o.iStator, 1), 'A', o.limited ? 'warn' : ''),
      tile('電池電壓', fmt(o.vBus, 2), 'V', o.vBus < 8 ? 'bad' : o.vBus < 10 ? 'warn' : ''),
      tile('最低電池電壓', fmt(sim.minV, 2), 'V', sim.minV < 6.75 ? 'bad' : sim.minV < 8 ? 'warn' : ''),
      tile('馬達溫度(估)', fmt(temp, 1), '°C', temp > 100 ? 'bad' : temp > 70 ? 'warn' : ''),
      tile('耗電', fmt(mAh, 1), 'mAh'),
      tile('馬達轉速', fmt(o.motorRPM, 0), 'RPM'),
      tile('前饋 / PID', `${fmt(o.ffV, 1)} / ${fmt(o.pidV, 1)}`, 'V'),
    ].join('');
    // 狀態標籤(圖示 + 文字,不只靠顏色)
    const b = [];
    if (o.brownout) b.push(['bad', '🔋 Brownout:電池掉到 6.75 V 以下,roboRIO 關掉輸出']);
    if (o.limited === 'stator' || o.limited === 'both') b.push(['warn', '⚡ 定子電流限制中(電壓被降低)']);
    if (o.limited === 'supply' || o.limited === 'both') b.push(['warn', '⚡ 供電電流限制中']);
    if (temp > 100) b.push(['bad', '🌡️ 馬達過熱(> 100 °C)']); else if (temp > 70) b.push(['warn', '🌡️ 馬達溫度偏高']);
    if (o.hitStop && kind !== 'flywheel' && Math.abs(o.vApplied) > 1) b.push(['warn', '🧱 頂在擋塊上']);
    if (divergedT >= 0 && sim.t - divergedT < 3) b.push(['bad', '💥 數值爆炸:子步數太少,已重置']);
    else if (!sim.stability().stable) b.push(['bad', '⚠️ 積分步長太大,結果不可信']);
    if (sim.cfg.mode === 'open') b.push(['warn', `🧪 開迴圈 ${fmt(sim.cfg.openV, 1)} V(極限測試)`]);
    $('badges').innerHTML = b.map(([c, t]) => `<span class="badge ${c}">${esc(t)}</span>`).join('');
  }

  // ==========================================================
  //  機構動畫
  // ==========================================================
  const anim = $('anim'), actx = anim.getContext('2d');
  function tempColor(t) { return t > 100 ? C.bad : t > 70 ? C.warn : C.metal2; }
  function drawAnim(dt) {
    const dpr = window.devicePixelRatio || 1, W = anim.clientWidth, H = anim.clientHeight;
    if (anim.width !== Math.round(W * dpr) || anim.height !== Math.round(H * dpr)) { anim.width = Math.round(W * dpr); anim.height = Math.round(H * dpr); }
    const g = actx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (kind === 'arm') drawArm(g, W, H);
    else if (kind === 'elevator') drawElevator(g, W, H);
    else drawFlywheel(g, W, H, dt);
  }
  function label(g, text, x, y, color = C.text, size = 13, align = 'left', weight = 600) {
    g.font = `${weight} ${size}px system-ui, sans-serif`; g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
    g.fillText(text, x, y);
  }
  function motorIcon(g, x, y, r) {
    g.fillStyle = tempColor(sim.temp);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = C.panel; g.lineWidth = 2; g.stroke();
    label(g, `${Math.round(sim.temp)}°C`, x, y + r + 12, C.text2, 11, 'center', 500);
  }

  function drawArm(g, W, H) {
    const m = sim.mech, p = m.p;
    const px = W * 0.5, py = H * 0.62, R = Math.min(W * 0.4, H * 0.52);
    const pt = (th, r = R) => [px + Math.cos(th) * r, py - Math.sin(th) * r];
    // 地板 + 塔
    g.strokeStyle = C.line; g.lineWidth = 2;
    g.beginPath(); g.moveTo(16, H - 18); g.lineTo(W - 16, H - 18); g.stroke();
    g.fillStyle = C.panel2; g.strokeStyle = C.line;
    g.beginPath(); g.moveTo(px - 16, H - 18); g.lineTo(px - 7, py); g.lineTo(px + 7, py); g.lineTo(px + 16, H - 18); g.closePath(); g.fill(); g.stroke();
    // 可動範圍 + 擋塊
    const [lo, hi] = m.limits();
    g.strokeStyle = C.grid; g.lineWidth = 6;
    g.beginPath(); g.arc(px, py, R + 14, -hi, -lo); g.stroke();
    for (const th of [lo, hi]) {
      const hit = m.hitStop && Math.abs(m.q - th) < 1e-6;
      g.strokeStyle = hit ? C.bad : C.muted; g.lineWidth = 4;
      const [a1, b1] = pt(th, R + 6), [a2, b2] = pt(th, R + 24);
      g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.stroke();
    }
    // 水平參考
    g.setLineDash([2, 5]); g.strokeStyle = C.grid; g.lineWidth = 1;
    g.beginPath(); g.moveTo(px, py); g.lineTo(px + R + 30, py); g.stroke(); g.setLineDash([]);
    label(g, '0°', px + R + 34, py, C.muted, 11, 'left', 500);
    // 目標(灰色虛線)
    const goal = sim.goal;
    g.setLineDash([6, 5]); g.strokeStyle = C.ref; g.lineWidth = 2;
    const [gx, gy] = pt(goal);
    g.beginPath(); g.moveTo(px, py); g.lineTo(gx, gy); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(gx, gy, 9, 0, Math.PI * 2); g.stroke();
    // 運動曲線設定點(細橘線)
    if (sim.profile && sim.cfg.mode === 'closed') {
      const [sx, sy] = pt(sim.sp.pos);
      g.strokeStyle = C.s2; g.lineWidth = 2;
      g.beginPath(); g.moveTo(px, py); g.lineTo(sx, sy); g.stroke();
    }
    // 手臂本體
    const [ex, ey] = pt(m.q);
    g.strokeStyle = C.s1; g.lineWidth = 16;
    g.beginPath(); g.moveTo(px, py); g.lineTo(ex, ey); g.stroke();
    g.strokeStyle = C.panel; g.lineWidth = 2; g.globalAlpha = 0.5;
    for (let f = 0.2; f < 0.95; f += 0.2) { const [hx, hy] = pt(m.q, R * f); g.beginPath(); g.arc(hx, hy, 3, 0, Math.PI * 2); g.stroke(); }
    g.globalAlpha = 1;
    // 末端負載
    if (p.endMass > 0) {
      g.fillStyle = C.s2; g.strokeStyle = C.panel; g.lineWidth = 2;
      g.beginPath(); g.arc(ex, ey, 8 + Math.min(10, p.endMass * 4), 0, Math.PI * 2); g.fill(); g.stroke();
    }
    // 重心 + 重力箭頭
    const cg = (p.mass * p.length / 2 + p.endMass * p.length) / (p.mass + p.endMass || 1) / p.length;
    const [cx, cy] = pt(m.q, R * cg);
    g.strokeStyle = C.muted; g.fillStyle = C.muted; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy + 34); g.stroke();
    g.beginPath(); g.moveTo(cx - 5, cy + 28); g.lineTo(cx, cy + 36); g.lineTo(cx + 5, cy + 28); g.fill();
    label(g, 'mg', cx + 8, cy + 30, C.muted, 11, 'left', 500);
    // 樞紐 = 馬達
    motorIcon(g, px, py, 13);
    // 角度
    label(g, `${fmt(m.toDisplay(m.q), 1)}°`, ex + (Math.cos(m.q) >= 0 ? 16 : -16), ey - 18, C.text, 15, Math.cos(m.q) >= 0 ? 'left' : 'right', 700);
    $('stageNote').textContent = `τ重力 = ${fmt(m.gravityMoment * Math.cos(m.q), 1)} N·m · ω = ${fmt(m.w * 180 / Math.PI, 0)}°/s`;
  }

  function drawElevator(g, W, H) {
    const m = sim.mech, p = m.p;
    const top = 26, bot = H - 30, carH = Math.max(26, Math.min(44, H * 0.1));
    const sc = (bot - top - carH) / p.maxHeight;
    const yOf = h => bot - h * sc;
    const cx = W * 0.52, rw = Math.min(170, W * 0.34);
    // 地板
    g.strokeStyle = C.line; g.lineWidth = 2;
    g.beginPath(); g.moveTo(16, bot + 8); g.lineTo(W - 16, bot + 8); g.stroke();
    // 尺規
    const tick = p.maxHeight > 1 ? 0.2 : 0.1;
    for (let h = 0; h <= p.maxHeight + 1e-9; h += tick) {
      const y = yOf(h);
      g.strokeStyle = C.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(cx - rw / 2 - 40, y); g.lineTo(cx - rw / 2 - 8, y); g.stroke();
      label(g, `${h.toFixed(1)} m`, cx - rw / 2 - 46, y, C.muted, 11, 'right', 500);
    }
    // 滑軌
    g.fillStyle = C.panel2; g.strokeStyle = C.metal; g.lineWidth = 2;
    for (const s of [-1, 1]) { const x = cx + s * rw / 2; g.beginPath(); g.rect(x - 6, top - 6, 12, bot - top + 14); g.fill(); g.stroke(); }
    // 頂部滑輪 + 繩子
    const carY = yOf(m.position) - carH;
    g.strokeStyle = C.metal; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, top + 4, 8, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = C.muted; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(cx, top + 12); g.lineTo(cx, carY); g.stroke();
    g.beginPath(); g.moveTo(cx + 8, top + 4); g.lineTo(cx + rw / 2 + 30, bot - 4); g.stroke();
    // 目標(虛線)
    const gy = yOf(sim.goal);
    g.setLineDash([6, 5]); g.strokeStyle = C.ref; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - rw / 2 - 20, gy); g.lineTo(cx + rw / 2 + 20, gy); g.stroke(); g.setLineDash([]);
    label(g, `目標 ${fmt(sim.goal, 2)} m`, cx + rw / 2 + 24, gy, C.text2, 12, 'left', 600);
    // 設定點(橘色小三角)
    if (sim.profile && sim.cfg.mode === 'closed') {
      const sy = yOf(sim.sp.pos);
      g.fillStyle = C.s2;
      g.beginPath(); g.moveTo(cx - rw / 2 - 8, sy); g.lineTo(cx - rw / 2 - 20, sy - 7); g.lineTo(cx - rw / 2 - 20, sy + 7); g.fill();
    }
    // 車架
    g.fillStyle = C.s1; g.strokeStyle = C.panel; g.lineWidth = 2;
    g.beginPath(); g.roundRect(cx - rw / 2 + 4, carY, rw - 8, carH, 6); g.fill(); g.stroke();
    label(g, `${fmt(m.position, 3)} m · ${fmt(p.mass, 1)} kg`, cx, carY + carH / 2, '#fff', 13, 'center', 700);
    // 馬達 + 捲線滾筒(右下)
    motorIcon(g, cx + rw / 2 + 30, bot - 10, 12);
    $('stageNote').textContent = `v = ${fmt(m.velocity, 2)} m/s · 重力 ${fmt(p.mass * MechLab.G, 0)} N`;
  }

  function drawFlywheel(g, W, H, dt) {
    const m = sim.mech;
    const cx = W * 0.46, cy = H * 0.5, r = Math.min(W * 0.16, H * 0.22), gap = Math.max(18, r * 0.35);
    const w = m.w;
    // 動畫轉角:真的轉速太快眼睛看不到(而且會有車輪倒轉的錯覺),所以最多用 3 圈/秒 畫,其他用殘影表示
    visAng += Math.sign(w) * Math.min(Math.abs(w), 3 * 2 * Math.PI) * dt;
    const rpm = Math.abs(m.velocity * 60);
    const blur = Math.min(1, rpm / 3000);
    const ballPx = gap * 0.9;
    for (const [s, yy] of [[1, cy - r - gap / 2], [-1, cy + r + gap / 2]]) {
      // 輪子
      g.fillStyle = C.panel2; g.strokeStyle = C.metal2; g.lineWidth = 3;
      g.beginPath(); g.arc(cx, yy, r, 0, Math.PI * 2); g.fill(); g.stroke();
      // 胎面
      g.strokeStyle = C.s1; g.lineWidth = 6;
      g.beginPath(); g.arc(cx, yy, r - 3, 0, Math.PI * 2); g.stroke();
      // 輪輻
      const ang = s * visAng;
      g.strokeStyle = C.metal; g.lineWidth = 4;
      for (let i = 0; i < 5; i++) {
        const a = ang + i * 2 * Math.PI / 5;
        g.beginPath(); g.moveTo(cx, yy); g.lineTo(cx + Math.cos(a) * (r - 8), yy + Math.sin(a) * (r - 8)); g.stroke();
      }
      // 高速殘影
      if (blur > 0.05) {
        g.strokeStyle = C.s1; g.globalAlpha = 0.35 * blur; g.lineWidth = 3;
        for (let i = 0; i < 3; i++) {
          const a = ang + i * 2 * Math.PI / 3;
          g.beginPath(); g.arc(cx, yy, r * 0.72, a, a + s * 1.2 * blur); g.stroke();
        }
        g.globalAlpha = 1;
      }
      g.fillStyle = C.metal2; g.beginPath(); g.arc(cx, yy, 6, 0, Math.PI * 2); g.fill();
    }
    // 導槽
    g.strokeStyle = C.line; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx - r * 2.2, cy - ballPx * 0.9); g.lineTo(cx - r * 0.6, cy - ballPx * 0.9); g.stroke();
    g.beginPath(); g.moveTo(cx - r * 2.2, cy + ballPx * 0.9); g.lineTo(cx - r * 0.6, cy + ballPx * 0.9); g.stroke();
    // 球:x 是「相對兩輪中心、以公尺計」的位置
    const pxPerM = r * 2.2 / 0.35;
    g.fillStyle = '#f3c615'; g.strokeStyle = C.panel; g.lineWidth = 2;
    for (const b of balls) {
      const bx = cx + b.x * pxPerM, by = cy + b.y * pxPerM;
      if (bx > W + 20) continue;
      g.beginPath(); g.arc(bx, by, ballPx * 0.8, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    // 轉速
    label(g, `${fmt(m.velocity * 60, 0)} RPM`, cx + r + 20, cy - r - gap / 2, C.text, 18, 'left', 700);
    label(g, `目標 ${fmt(sim.goal * 60, 0)} RPM`, cx + r + 20, cy - r - gap / 2 + 22, C.text2, 12, 'left', 500);
    if (lastExit) label(g, `上一顆出球 ${fmt(lastExit.v, 1)} m/s · 掉速 ${fmt(lastExit.drop, 0)} RPM`, cx + r + 20, cy + r + gap / 2, C.text2, 12, 'left', 500);
    motorIcon(g, cx - r - 34, cy - r - gap / 2, 11);
    $('stageNote').textContent = `飛輪動能 ${fmt(0.5 * m.J * w * w, 0)} J · 風阻 ${fmt(m.p.airDrag * w * w, 3)} N·m`;
  }

  // 飛輪球的運動(用模擬時間推進,所以暫停 / 加速都會跟著)
  function stepBalls(dt) {
    for (const b of balls) {
      b.x += b.v * dt;
      if (!b.shot && b.x >= 0) {
        b.shot = true;
        const before = sim.mech.velocity * 60;
        const v = sim.mech.shoot();                // 真的從飛輪動能扣掉
        lastExit = { v, drop: before - sim.mech.velocity * 60 };
        b.v = Math.max(v, 0.5);
        b.y = 0;
      }
    }
    balls = balls.filter(b => b.x < 3);
    if (burstLeft > 0 && sim.t >= burstNext) { feedBall(); burstLeft--; burstNext = sim.t + 0.25; }
  }

  // ==========================================================
  //  主迴圈
  // ==========================================================
  function tick() {
    if (autoStep && sim.t >= autoNext) {
      const k = KIND[kind];
      setGoalDisplay(k.auto[autoIdx++ % 2]);
      autoNext = sim.t + 3;
    }
    if (kind === 'flywheel') stepBalls(sim.dt);
    const o = sim.step();
    if (sim.diverged) { sim.diverged = false; divergedT = sim.t; }
    buf.push(o);
    if (buf.length > MAXBUF) buf.splice(0, buf.length - MAXBUF);
  }
  let last = performance.now(), accT = 0, tilesT = 0;
  function frame(now) {
    const rdt = Math.min(0.1, (now - last) / 1000);
    last = now;
    let simDt = 0;
    if (running) {
      accT += rdt * speed;
      let n = 0;
      while (accT >= sim.dt && n < 40) { accT -= sim.dt; tick(); n++; simDt += sim.dt; }
      if (n >= 40) accT = 0;
    }
    drawAnim(simDt);
    drawCharts();
    if (now - tilesT > 120) { tilesT = now; updateTiles(); }
    requestAnimationFrame(frame);
  }

  // ==========================================================
  //  切換機構 / 按鈕
  // ==========================================================
  function loadKind(k, fresh) {
    kind = k;
    store.set('mechlab-kind', k);
    const saved = fresh ? null : store.get('mechlab-cfg-' + k);
    try { sim = new Simulation(saved ? Object.assign({}, saved, { kind: k }) : { kind: k }); }
    catch { sim = new Simulation({ kind: k }); }
    if (!saved) { sim.autoFF(); saveCfg(); }
    buf = []; balls = []; lastExit = null; burstLeft = 0; autoIdx = 0; autoNext = 0;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.kind === k));
    buildTargets(); buildParams(); buildCharts();
    setGoalDisplay(KIND[k].first);
    updateTiles();
  }
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => loadKind(b.dataset.kind));
  function setRunning(on) { running = on; $('playBtn').textContent = on ? '⏸ 暫停' : '▶ 繼續'; $('playBtn').classList.toggle('go', on); }
  $('playBtn').onclick = () => setRunning(!running);
  $('resetBtn').onclick = () => {
    sim.reset(); buf = []; balls = []; lastExit = null; burstLeft = 0;
    $('goalIn').value = +sim.mech.toDisplay(sim.goal).toFixed(3);
    updateTiles();
  };
  $('speedSel').onchange = e => { speed = +e.target.value; };
  $('winSel').onchange = e => { winSec = +e.target.value; };
  $('csvBtn').onclick = () => {
    const cols = ['t', 'goal', 'setpoint', 'actual', 'request', 'ffV', 'pidV', 'vApplied', 'vBus', 'iStator', 'iStatorTotal', 'iSupply', 'pIn', 'pOut', 'pHeat', 'temp', 'motorRPM'];
    const csv = cols.join(',') + '\n' + buf.map(d => cols.map(c => (typeof d[c] === 'number' ? +d[c].toFixed(5) : '')).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `mechlab-${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); setRunning(!running); }
  });
  // 在模擬器以外的地方單獨打開(例如直接開檔案)就藏掉「回模擬器」
  if (location.protocol === 'file:') $('backLink').style.display = 'none';

  loadKind(kind);
  requestAnimationFrame(frame);
})();
