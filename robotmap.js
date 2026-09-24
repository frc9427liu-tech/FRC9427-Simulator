// ============================================================
//  機構對應(讓模擬器能跑「任何人」的機器人程式,不只 LEO)
//
//  模擬器要知道:哪個數值是左輪出力、哪個是手臂位置、哪個是飛輪轉速…
//  數值可以來自兩種地方:
//    1. NetworkTables(SmartDashboard、AdvantageKit 等,程式自己發的數字)
//    2. 模擬器的硬體訊號(HAL):SPARK MAX / Talon FX 在模擬裡會登記成 SimDevice、PWM 馬達控制器
//  對應關係存在「那個專案資料夾」的 .robot-sim.json(透過 /api/project),下次打開就不用再設。
//  LEO 內建一份預設(LEO_PRESET),沒有 .robot-sim.json 時自動套用。
//
//  讀 index.html 的全域:values, topicTypes, halData, PADS, visuals, toast
// ============================================================
const MECHS = [
  // id, 名稱, 說明, 預設參數
  ['driveL',   '底盤 左輪出力', '−1 ~ 1(出力比例)。如果來源是電壓,倍率填 1/12 = 0.0833', { scale: 1 }],
  ['driveR',   '底盤 右輪出力', '−1 ~ 1', { scale: 1 }],
  ['arm',      'Intake 手臂位置', '收起時的數值 → 放下時的數值(單位隨你的程式,例如圈數)', { up: 0, down: 10 }],
  ['turret',   '砲台角度', '數值 × 每單位幾度 = 砲台角度', { degPerUnit: 18 }],
  ['flywheel', '飛輪轉速', '換算成「圈/秒」。如果是 RPM,倍率填 1/60 = 0.01667', { scale: 1 }],
  ['indexer',  '送球(Indexer)', '數值超過門檻 = 正在把球送進飛輪', { threshold: 1 }],
  ['intake',   'Intake 滾輪', '正 = 吸、負 = 吐;只有電流(沒方向)就選「電流模式」', { threshold: 0.5, mode: 'output' }],
  ['orbit',    'Orbit 轉盤(只影響畫面)', '圈/秒', { scale: 1 }],
];
const LEO_PRESET = {
  version: 1,
  preset: 'LEO',
  mechanisms: {
    driveL: { sig: 'nt:/SmartDashboard/Drive/左 出力', scale: 1 },
    driveR: { sig: 'nt:/SmartDashboard/Drive/右 出力', scale: 1 },
    arm: { sig: 'nt:/SmartDashboard/IntakeArm/位置(圈)', up: 0, down: 10 },
    turret: { sig: 'nt:/SmartDashboard/Turret/位置(圈)', degPerUnit: 18 },
    flywheel: { sig: 'nt:/SmartDashboard/Flywheel/轉速(圈每秒)', scale: 1 },
    indexer: { sig: 'nt:/SmartDashboard/Indexer/轉速(圈每秒)', threshold: 1 },
    // LEO 的滾輪只回報電流、沒有方向 → 方向看操作手按鍵(LB 吸、X 吐)
    intake: { sig: 'nt:/SmartDashboard/IntakeRoller/左 電流', sig2: 'nt:/SmartDashboard/IntakeRoller/右 電流', threshold: 0.5, mode: 'current', inBtn: 5, outBtn: 3 },
    orbit: { sig: 'nt:/SmartDashboard/Orbit/轉速(圈每秒)', scale: 1 },
  },
  // 射球:飛輪輪徑(吋)× 出球效率 → 出球速度。LEO 的效率是用「80 圈/秒站 3.9 m 剛好進」反推的(示意)
  shooter: { wheelIn: 4, efficiency: 0.29, launchDeg: 60 },
  // 搖桿上顯示的功能名稱(跟 Robot.java 的按鍵一致)
  labels: [
    { LS: '左輪 ↕', RS: '右輪 ↕' },
    { LS: 'Turret 左右 ↔', UP: '手臂收起', DOWN: '手臂放下', LB: '吸球', X: '吐球', RT: '飛輪', A: '送球(配RT)', RB: 'Orbit' },
  ],
  demo: true,        // 展示模式是照 LEO 的按鍵寫的,別的程式不能用
};
const BLANK_CONFIG = { version: 1, mechanisms: {}, shooter: { wheelIn: 4, efficiency: 0.29, launchDeg: 60 }, labels: [{}, {}], demo: false };

const ROBOT = (() => {
  let cfg = JSON.parse(JSON.stringify(LEO_PRESET));
  let project = { name: 'LEO', path: '', canSwitch: false, api: false, fromFile: false };

  // ---------- 讀訊號 ----------
  // 'nt:/SmartDashboard/xxx' 或 'hal:SimDevice SPARK MAX [6]|Applied Output'
  function raw(sig) {
    if (!sig) return 0;
    let v;
    if (sig.startsWith('nt:')) v = values[sig.slice(3)];
    else if (sig.startsWith('hal:')) { const [dev, f] = sig.slice(4).split('|'); v = halData[dev] && halData[dev][f]; }
    if (typeof v === 'boolean') v = v ? 1 : 0;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;   // NaN / Infinity 當 0(紅隊發現過)
  }
  const m = id => cfg.mechanisms[id] || {};
  const val = id => raw(m(id).sig) * (m(id).scale ?? 1);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  // 手臂擋塊模型(armPhys / armFrac / armOver 共用,一幀可能被叫好幾次,同一個數值不重複算)
  const arm = { phys: null, last: null, pushT: -1e9 };
  function armStep() {
    const a = m('arm');
    if (!a.sig) return arm;
    const lo = Math.min(a.up ?? 0, a.down ?? 10), hi = Math.max(a.up ?? 0, a.down ?? 10);
    const r = raw(a.sig);
    if (arm.phys === null) { arm.phys = clamp(r, lo, hi); arm.last = r; return arm; }
    const d = r - arm.last;
    if (d === 0) return arm;
    arm.last = r;
    const want = arm.phys + d;
    arm.phys = clamp(want, lo, hi);
    if (want !== arm.phys) arm.pushT = performance.now();     // 想轉出行程 = 正在頂擋塊
    return arm;
  }

  const api = {
    get config() { return cfg; }, get project() { return project; },
    raw,
    driveL: () => clamp(val('driveL'), -1, 1),
    driveR: () => clamp(val('driveR'), -1, 1),
    armRaw: () => raw(m('arm').sig),
    // 手臂「實際」位置(有機構擋塊):程式的數值跑出行程時,真的手臂早就卡在底了。
    // 以前直接用程式數值 → 手臂被按到 67 圈後,要往回轉 57 圈畫面上才開始動(不真實)。
    // 現在:每幀只看數值「變化量」,加到實際位置上再夾在行程內 —— 一往回轉就馬上離開擋塊,跟真的一樣
    armPhys: () => armStep().phys,
    // 0 = 收起、1 = 放下
    armFrac: () => { const a = m('arm'), s = armStep(), span = (a.down ?? 10) - (a.up ?? 0); return span ? clamp((s.phys - (a.up ?? 0)) / span, 0, 1) : 0; },
    // 手臂正在「頂著擋塊」(程式還在叫它往外轉)→ 回傳程式數值,沒有就 0
    armOver: () => { const s = armStep(); return performance.now() - s.pushT < 800 ? (s.last || 0.001) : 0; },
    turretRaw: () => raw(m('turret').sig),
    turretRad: () => raw(m('turret').sig) * (m('turret').degPerUnit ?? 18) * Math.PI / 180,
    fly: () => val('flywheel'),
    idx: () => val('indexer'),
    feeding: () => Math.abs(raw(m('indexer').sig)) > (m('indexer').threshold ?? 1),
    orbit: () => val('orbit'),
    // 滾輪方向:+1 吸、−1 吐、0 停
    intakeDir(opButtons) {
      const c = m('intake');
      if (!c.sig) return 0;
      if (c.mode === 'current') {
        const a = Math.abs(raw(c.sig)) + Math.abs(raw(c.sig2));
        const inB = c.inBtn && opButtons[c.inBtn - 1], outB = c.outBtn && opButtons[c.outBtn - 1];
        return (a > (c.threshold ?? 0.5) || inB || outB) ? (outB ? -1 : 1) : 0;
      }
      const v = raw(c.sig) * (c.scale ?? 1);
      return Math.abs(v) > (c.threshold ?? 0.05) ? Math.sign(v) : 0;
    },
    // 出球速度 = 飛輪轉速(圈/秒)× 輪周長 × 效率
    get shootK() { const s = cfg.shooter || {}; return Math.PI * (s.wheelIn ?? 4) * 0.0254 * (s.efficiency ?? 0.29); },
    get launchRad() { return ((cfg.shooter && cfg.shooter.launchDeg) ?? 60) * Math.PI / 180; },
    get demoOK() { return !!cfg.demo; },
    catalog,
    openSettings,
    save: c => save(c),
  };

  // ---------- 目前能選的訊號(給設定畫面) ----------
  function catalog() {
    const out = [];
    for (const name of Object.keys(values).sort()) {
      const t = topicTypes[name];
      if (t && !/^(double|float|int|boolean)$/.test(t)) continue;
      if (typeof values[name] !== 'number' && typeof values[name] !== 'boolean') continue;
      out.push({ id: 'nt:' + name, group: 'NetworkTables', label: name.replace(/^\/SmartDashboard\//, 'SmartDashboard/') });
    }
    for (const dev of Object.keys(halData).sort()) {
      for (const f of Object.keys(halData[dev]).sort()) {
        if (typeof halData[dev][f] !== 'number' && typeof halData[dev][f] !== 'boolean') continue;
        out.push({ id: `hal:${dev}|${f}`, group: '模擬硬體(CAN / PWM)', label: `${dev} → ${f}` });
      }
    }
    return out;
  }

  // ---------- 搖桿上的功能名稱 ----------
  function relabel() {
    const labels = cfg.labels || [{}, {}];
    PADS.forEach((p, pi) => { p.fn = labels[pi] || {}; });
    const keyName = k => k.startsWith('POV:') ? { 'POV:u': 'UP', 'POV:d': 'DOWN', 'POV:l': 'LEFT', 'POV:r': 'RIGHT' }[k] : k;
    visuals.forEach((v, pi) => {
      if (!v) return;
      const fn = PADS[pi].fn;
      for (const b of v.buttons) {
        let f = b.querySelector('.f');
        const txt = fn[keyName(b._key)] || '';
        if (!f && txt) { f = document.createElement('span'); f.className = 'f'; b.append(f); }
        if (f) f.textContent = txt;
      }
      v.sticks.forEach(([w], i) => { const el = w.querySelector('.stickfn'); const k = i ? 'RS' : 'LS'; if (el) el.textContent = (i ? '右搖桿' : '左搖桿') + (fn[k] ? ':' + fn[k] : ''); });
      v.triggers.forEach(([t], i) => {
        const lbl = t.querySelector('.lbl'); if (!lbl) return;
        let s = lbl.querySelector('small'); const txt = fn[i ? 'RT' : 'LT'] || '';
        if (!s && txt) { s = document.createElement('small'); lbl.querySelector('.v').before(s); }
        if (s) s.textContent = txt;
      });
    });
    const demoBtn = document.getElementById('demoBtn');
    if (demoBtn) demoBtn.style.display = cfg.demo ? '' : 'none';
    const h1 = document.querySelector('.top h1');
    if (h1) h1.textContent = `🎮 ${project.name || '機器人'} 模擬器`;
    document.title = `${project.name || '機器人'} 模擬器`;
  }

  // ---------- 載入(專案資料夾的 .robot-sim.json → 沒有的話 LEO 預設 / 空白) ----------
  async function load() {
    try {
      const r = await fetch('/api/project', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const p = await r.json();
      project = { name: p.name || '', path: p.path || '', canSwitch: !!p.canSwitch, api: true, fromFile: !!p.config };
      if (p.config && typeof p.config === 'object') cfg = normalize(p.config);
      else if (/^leo$/i.test(p.name || '')) cfg = JSON.parse(JSON.stringify(LEO_PRESET));
      else { cfg = JSON.parse(JSON.stringify(BLANK_CONFIG)); setTimeout(() => openSettings(true), 1500); }
    } catch {
      // 舊版伺服器沒有 /api/project → 當成 LEO(瀏覽器版)
      project = { name: 'LEO', path: '', canSwitch: false, api: false, fromFile: false };
    }
    relabel();
    window.dispatchEvent(new Event('robot-config-loaded'));      // 🤖 自訂機器人(robotcustom.js)等這個再套用
    const sw = document.getElementById('switchProj');
    if (sw) sw.style.display = project.canSwitch ? '' : 'none';
  }
  function normalize(c) {
    const out = JSON.parse(JSON.stringify(BLANK_CONFIG));
    Object.assign(out, c);
    out.mechanisms = Object.assign({}, c.mechanisms || {});
    out.shooter = Object.assign({}, BLANK_CONFIG.shooter, c.shooter || {});
    out.labels = Array.isArray(c.labels) ? c.labels : [{}, {}];
    return out;
  }
  async function save(newCfg) {
    cfg = normalize(newCfg);
    relabel();
    if (!project.api) { toast('⚠️ 這個版本的伺服器不能存設定(只在這次有效)', 3500); return; }
    try {
      const r = await fetch('/api/project/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg, null, 2) });
      if (!r.ok) throw new Error(r.status);
      project.fromFile = true;
      toast(`✅ 已存到 ${project.name}/.robot-sim.json`, 2500);
    } catch (e) { toast('⚠️ 存檔失敗(' + e.message + '),設定只在這次有效', 4000); }
  }

  // ---------- ⚙️ 機構設定畫面 ----------
  let dlg = null, liveT = 0;
  function openSettings(firstTime) {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'mapdlg';
      document.body.append(dlg);
      dlg.addEventListener('close', () => clearInterval(liveT));
    }
    const work = JSON.parse(JSON.stringify(cfg));
    const cat = catalog();
    const opts = sel => {
      const groups = {};
      for (const c of cat) (groups[c.group] = groups[c.group] || []).push(c);
      if (sel && !cat.some(c => c.id === sel)) (groups['目前沒有這個訊號(模擬器開著才看得到)'] = []).push({ id: sel, label: sel.replace(/^(nt|hal):/, '') });
      return '<option value="">(沒有這個機構)</option>' + Object.entries(groups).map(([g, list]) =>
        `<optgroup label="${esc(g)}">${list.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</optgroup>`).join('');
    };
    const KN = { scale: '倍率', up: '收起時', down: '放下時', degPerUnit: '每單位幾度', threshold: '門檻', wheelIn: '', efficiency: '', launchDeg: '' };
    const num = (id, k, v, step, title) => `<label class="pp" title="${esc(title || '')}">${esc(KN[k] ?? k)} <input type="number" step="${step || 'any'}" data-m="${id}" data-k="${k}" value="${v ?? ''}"></label>`;
    const rows = MECHS.map(([id, name, help, def]) => {
      const c = Object.assign({}, def, work.mechanisms[id] || {});
      let extra = '';
      if ('scale' in def) extra += num(id, 'scale', c.scale, 'any', '倍率(負數 = 反向)');
      if (id === 'arm') extra += num(id, 'up', c.up) + num(id, 'down', c.down);
      if (id === 'turret') extra += num(id, 'degPerUnit', c.degPerUnit);
      if ('threshold' in def) extra += num(id, 'threshold', c.threshold);
      if (id === 'intake') extra += `<label class="pp"><input type="checkbox" data-m="intake" data-k="modeCurrent"${c.mode === 'current' ? ' checked' : ''}> 電流模式</label>`;
      return `<tr><td><b>${esc(name)}</b><div class="mh">${esc(help)}</div></td>
        <td><select data-m="${id}" data-k="sig">${opts(c.sig)}</select><div class="pps">${extra}</div></td>
        <td class="live" data-live="${id}">—</td></tr>`;
    }).join('');
    const s = work.shooter || {};
    dlg.innerHTML = `
      <form method="dialog">
        <div class="mt">⚙️ 機構設定 <span class="mp">${esc(project.name)}${project.path ? ' · ' + esc(project.path) : ''}</span></div>
        ${firstTime ? `<div class="mnote">👋 第一次開這個專案:告訴模擬器每個機構的數值在哪裡。先按「啟用」動一動搖桿,右邊「目前數值」會跳動的就是對的。用不到的機構選「沒有這個機構」就好。</div>` : ''}
        <div class="mnote">選單裡有兩種來源:<b>NetworkTables</b>(你的程式 SmartDashboard.putNumber 或 AdvantageKit 發的數字)、<b>模擬硬體</b>(程式裡的 SPARK MAX / Talon FX / PWM 馬達在模擬時自己登記的)。找不到想要的?模擬器要開著、程式要跑到那一段才會出現,按「🔄 重新整理」。</div>
        <table class="mtab"><tr><th>機構</th><th>數值來源</th><th>目前數值</th></tr>${rows}</table>
        <div class="msec"><b>射球</b>
          ${num('shooter', 'wheelIn', s.wheelIn, 'any', '飛輪直徑(英吋)')} 吋飛輪
          ${num('shooter', 'efficiency', s.efficiency, 'any', '出球速度 ÷ 飛輪表面速度,通常 0.3 ~ 0.6')} 出球效率
          ${num('shooter', 'launchDeg', s.launchDeg, 'any', '出球仰角(度)')} 度仰角
        </div>
        <div class="acts">
          <button type="button" id="mRefresh">🔄 重新整理</button>
          <button type="button" id="mLeo">套用 LEO 預設</button>
          <span style="flex:1"></span>
          <button value="cancel" formnovalidate>取消</button>
          <button type="button" class="go" id="mSave">💾 儲存</button>
        </div>
      </form>`;
    const collect = () => {
      const out = JSON.parse(JSON.stringify(work));
      out.mechanisms = {};
      for (const [id, , , def] of MECHS) {
        const c = Object.assign({}, work.mechanisms[id] || {});
        dlg.querySelectorAll(`[data-m="${id}"]`).forEach(el => {
          if (el.dataset.k === 'sig') c.sig = el.value || undefined;
          else if (el.dataset.k === 'modeCurrent') c.mode = el.checked ? 'current' : 'output';
          else if (el.value !== '') c[el.dataset.k] = +el.value;
        });
        if (c.sig) out.mechanisms[id] = c;
        void def;
      }
      out.shooter = Object.assign({}, out.shooter);
      dlg.querySelectorAll('[data-m="shooter"]').forEach(el => { if (el.value !== '') out.shooter[el.dataset.k] = +el.value; });
      return out;
    };
    dlg.querySelector('#mSave').onclick = async () => { await save(collect()); dlg.close(); };
    dlg.querySelector('#mLeo').onclick = () => { cfg = JSON.parse(JSON.stringify(LEO_PRESET)); dlg.close(); openSettings(); };
    dlg.querySelector('#mRefresh').onclick = () => { const keep = collect(); const old = cfg; cfg = keep; dlg.close(); openSettings(); cfg = old; };
    clearInterval(liveT);
    liveT = setInterval(() => {
      dlg.querySelectorAll('[data-live]').forEach(td => {
        const sel = dlg.querySelector(`select[data-m="${td.dataset.live}"]`);
        td.textContent = sel && sel.value ? raw(sel.value).toFixed(2) : '—';
      });
    }, 200);
    if (!dlg.open) dlg.showModal();
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 工具列按鈕
  const bar = document.getElementById('resetPose').parentElement;
  const gear = document.createElement('button');
  gear.id = 'mapBtn'; gear.textContent = '⚙️ 機構設定'; gear.title = '設定模擬器要讀哪些數值(換成別人的程式時用)';
  gear.onclick = () => openSettings();
  bar.insertBefore(gear, document.getElementById('fullBtn'));
  // 📖 教學:不用關模擬器,直接在畫面上打開 help.html
  const helpBtn = document.createElement('button');
  helpBtn.id = 'helpBtn'; helpBtn.textContent = '📖 教學'; helpBtn.title = '新手教學(電腦操作)';
  helpBtn.onclick = () => {
    let d = document.getElementById('helpDlg');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'helpDlg'; d.className = 'mapdlg';
      d.style.cssText = 'width:min(1100px,96vw);height:90vh;padding:0;overflow:hidden';
      d.innerHTML = '<form method="dialog" style="position:absolute;right:10px;top:8px;z-index:2"><button style="padding:4px 12px;border-radius:8px;border:1px solid #30363d;background:#1c2230;color:#e6edf3;cursor:pointer">✕ 關閉</button></form>'
        + '<iframe src="help.html" style="width:100%;height:100%;border:0;background:#0d1117"></iframe>';
      document.body.append(d);
    }
    setEnabled(false);          // 看教學時先停用,免得機器人自己跑
    d.showModal();
  };
  bar.insertBefore(helpBtn, gear);
  // 🔧 機構實驗室:單獨調手臂 / 升降台 / 飛輪的馬達、電流、PID(開新視窗,不影響比賽模擬)
  const labBtn = document.createElement('button');
  labBtn.id = 'labBtn'; labBtn.textContent = '🔧 機構實驗室'; labBtn.title = '手臂 / 升降台 / 飛輪的馬達、電流、電池、PID + 前饋模擬';
  labBtn.onclick = () => window.open('mechlab.html', '_blank');
  bar.insertBefore(labBtn, helpBtn);
  // 🎨 畫質(3D):高 = 環境遮蔽 + 光暈、中 = 光暈、低 = 最省電
  const qSel = document.createElement('select');
  qSel.id = 'qualitySel'; qSel.title = '3D 畫質(卡的話調低)';
  qSel.style.cssText = 'background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:4px 6px;font-size:13px';
  qSel.innerHTML = '<option value="high">🎨 畫質:高</option><option value="mid">🎨 畫質:中</option><option value="low">🎨 畫質:低</option>';
  try { qSel.value = localStorage.getItem('sim-quality') || 'high'; } catch {}
  qSel.onchange = () => { if (window.View3D && View3D.setQuality) View3D.setQuality(qSel.value); };
  bar.insertBefore(qSel, helpBtn);
  const sw = document.createElement('button');
  sw.id = 'switchProj'; sw.textContent = '📂 換專案'; sw.style.display = 'none';
  sw.onclick = () => { if (confirmSwitch()) fetch('/api/switch-project', { method: 'POST' }).catch(() => {}); };
  bar.insertBefore(sw, gear);
  function confirmSwitch() { setEnabled(false); return true; }

  load();
  return api;
})();
