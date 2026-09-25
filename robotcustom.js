// ============================================================
//  🤖 自訂機器人:把模擬器裡的車換成「你們隊自己的車」
//
//  - 外觀:匯入 3D 模型(Onshape / SolidWorks / Fusion 匯出的 .glb)、保險桿顏色、隊號、隊徽圖片
//  - 尺寸:含保險桿的長 × 寬 → 碰撞、吸球口、畫面都跟著變
//  - 底盤動力:馬達型號 / 數量 / 減速比 / 輪徑 / 車重 / 輪胎摩擦 / 電流限制 → physics.js 用真的馬達模型算
//  - 電池:開路電壓、內阻 → 電壓下降、Brownout
//
//  存在哪裡:
//    設定(數字)→ 專案資料夾的 .robot-sim.json 的 "robot" 欄位(跟 ⚙️ 機構設定同一個檔,可以 commit 給隊友)
//    模型檔、隊徽圖片(比較大)→ 這台電腦瀏覽器的 IndexedDB(依專案名稱分開存)
//  讀 robotmap.js 的 ROBOT、physics.js 的 PHYS、view3d.js 的 View3D、index.html 的 toast / setEnabled
// ============================================================
const BODY = (() => {
  const DEF = {
    teamNumber: '9427', bumperColor: 'red',
    length: 0.86, width: 0.86,
    drive: { motor: 'krakenX60', perSide: 2, ratio: 7.31, wheelIn: 4, mass: 60, mu: 1.1, efficiency: 0.97, statorLimit: 80, supplyLimit: 60 },
    battery: { openV: 12.6, resistance: 0.02 },
    model: { source: 'kitbot', fileName: '', rotX: 0, rotY: 0, rotZ: 0, scale: 1, autoFit: true, lift: 0, bumpers: true, showMechs: null },
    // 🧩 機構組裝:位置都是「相對車中心」,x 往前為正(公尺)
    parts: {
      intake: { type: 'pivot', width: 0.66, reach: 0.34, pivotH: 0.30 },
      shooter: { type: 'turret', x: 0.12, h: 0.47 },
      hopper: { capacity: 40 },
    },
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  // 深層合併:存檔裡沒有的欄位(舊版存的、新加的功能)用預設值補上
  function merge(base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    for (const k of Object.keys(over)) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && out[k] && typeof out[k] === 'object') out[k] = merge(out[k], over[k]);
      else if (over[k] !== undefined) out[k] = over[k];
    }
    return out;
  }
  let cur = clone(DEF);                    // 目前套用中的設定
  const LS_KEY = 'robot-body';             // 沒有專案 API(舊版伺服器)時存在瀏覽器

  // ---------- IndexedDB:放模型檔和隊徽 ----------
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((ok, fail) => {
      try {
        const r = indexedDB.open('frc9427-sim', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('blobs');
        r.onsuccess = () => ok(r.result);
        r.onerror = () => fail(r.error);
      } catch (e) { fail(e); }
    }));
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((ok, fail) => {
        const t = db.transaction('blobs', mode), st = t.objectStore('blobs');
        const req = fn(st);
        t.oncomplete = () => ok(req && req.result);
        t.onerror = () => fail(t.error);
      });
    };
    return {
      get: k => tx('readonly', st => st.get(k)).catch(() => null),
      put: (k, v) => tx('readwrite', st => st.put(v, k)),
      del: k => tx('readwrite', st => st.delete(k)).catch(() => {}),
    };
  })();
  const blobKey = kind => `${kind}:${(ROBOT.project && ROBOT.project.name) || 'default'}`;

  // ---------- 套用 ----------
  let modelLoadedFor = null, logoLoadedFor = null;
  let memModel = { key: null, buf: null };  // 這次剛選、還沒存的模型檔
  let memLogo;                               // 還沒存的隊徽:undefined = 沒動、null = 刪掉、字串 = 新圖(👀 看一下 再回來也還在)
  function view() { return window.View3D && window.View3D.setRobotLook ? window.View3D : null; }
  async function apply(c, { reloadBlobs = false } = {}) {
    cur = c;
    if (typeof PHYS !== 'undefined' && PHYS.configure) PHYS.configure(c);
    // 籃子容量(screen.js 的 MAX_HELD;車上已經超過的球先留著)
    if (typeof MAX_HELD !== 'undefined') MAX_HELD = Math.max(1, Math.min(80, Math.round(+c.parts.hopper.capacity || 40)));
    const V = view();
    if (!V) return;
    // 模型 / 隊徽只在換專案或重新匯入時才從 IndexedDB 讀
    const mk = blobKey('model'), lk = blobKey('logo');
    // KitBot 模式不用清掉已經讀進來的模型(畫面會自己藏起來),切回來就不用重讀
    if (c.model.source === 'custom' && (reloadBlobs || modelLoadedFor !== mk)) {
      modelLoadedFor = mk;
      const buf = memModel.key === mk ? memModel.buf : await idb.get(mk);
      if (buf) { try { await V.setRobotModel(buf); } catch (e) { toast('⚠️ ' + e.message, 4000); } }
      else await V.setRobotModel(null);
    }
    if (reloadBlobs || logoLoadedFor !== lk) {
      logoLoadedFor = lk;
      const url = await idb.get(lk);
      V.setRobotLogo(url ? await loadImg(url).catch(() => null) : null);
    }
    V.setRobotLook(c);
  }
  const loadImg = src => new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = src; });

  function fromConfig() {
    let r = ROBOT.config && ROBOT.config.robot;
    if (!r && !(ROBOT.project && ROBOT.project.api)) { try { r = JSON.parse(localStorage.getItem(LS_KEY)); } catch {} }
    return merge(DEF, r);
  }
  async function saveBody(c) {
    if (ROBOT.project && ROBOT.project.api) await ROBOT.save(Object.assign({}, ROBOT.config, { robot: c }));
    else { try { localStorage.setItem(LS_KEY, JSON.stringify(c)); toast('✅ 已存在這台電腦的瀏覽器', 2500); } catch { toast('⚠️ 存檔失敗', 3000); } }
  }

  window.addEventListener('robot-config-loaded', () => apply(fromConfig(), { reloadBlobs: true }));
  window.addEventListener('view3d-ready', () => apply(cur, { reloadBlobs: true }));
  apply(fromConfig());

  // ==========================================================
  //  🤖 設定畫面
  // ==========================================================
  const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  let dlg = null, savedAtOpen = null;
  function open(fromReset) {
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.className = 'mapdlg';
      document.body.append(dlg);
    }
    if (typeof setEnabled === 'function') setEnabled(false);      // 改設定時先停用,免得車子自己跑
    if (!fromReset) savedAtOpen = clone(cur);
    const saved = savedAtOpen;
    let work = clone(cur);
    const motors = (typeof MechLab !== 'undefined' ? Object.values(MechLab.MOTORS) : []);
    const num = (path, label, unit, attrs = '', help = '') => {
      const v = path.split('.').reduce((o, k) => o && o[k], work);
      return `<label class="rc-f"><span>${esc(label)}${help ? ` <em>${esc(help)}</em>` : ''}</span>
        <span class="rc-r"><input type="number" data-p="${path}" value="${v ?? ''}" ${attrs}>${unit ? `<small>${esc(unit)}</small>` : ''}</span></label>`;
    };
    const rotSel = axis => `<label class="rc-f"><span>繞 ${axis} 軸轉</span><span class="rc-r"><select data-p="model.rot${axis}">
      ${[0, 90, 180, 270].map(d => `<option value="${d}"${+work.model['rot' + axis] === d ? ' selected' : ''}>${d}°</option>`).join('')}</select></span></label>`;
    dlg.innerHTML = `
      <style>
        .rc-sec { border-top: 1px solid var(--line); padding: 10px 0 4px; }
        .rc-sec h3 { margin: 0 0 6px; font-size: 15px; }
        .rc-g { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px 14px; }
        .rc-f { display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
        .rc-f > span:first-child { color: var(--dim); font-size: 12px; }
        .rc-f em { font-style: normal; opacity: .75; }
        .rc-r { display: flex; align-items: center; gap: 6px; }
        .rc-r input[type=number], .rc-r input[type=text], .rc-r select { flex: 1; min-width: 0; background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 7px; padding: 4px 6px; }
        .rc-r small { color: var(--dim); white-space: nowrap; }
        .rc-seg { display: inline-flex; gap: 4px; flex-wrap: wrap; }
        .rc-seg button, .rc-btn { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; cursor: pointer; }
        .rc-seg button.on { background: #2f81f7; border-color: #2f81f7; color: #fff; }
        .rc-info { font-size: 12px; color: var(--dim); background: var(--panel2); border-radius: 8px; padding: 7px 10px; margin-top: 8px; line-height: 1.6; }
        .rc-info b { color: var(--text); }
        .rc-bad { color: #f85149; } .rc-ok { color: #3fb950; } .rc-warn { color: #d29922; }
        .rc-logo { width: 48px; height: 48px; object-fit: contain; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; }
      </style>
      <form method="dialog">
        <div class="mt">🤖 自訂機器人 <span class="mp">${esc((ROBOT.project && ROBOT.project.name) || '')}</span></div>
        <div class="mnote">改了馬上就套用到畫面和物理,按 💾 儲存才會記下來(存進專案的 <code>.robot-sim.json</code>,可以 commit 給隊友)。3D 模型和隊徽圖片比較大,存在這台電腦。</div>

        <div class="rc-sec"><h3>🧱 車身 3D 模型</h3>
          <div class="rc-seg" id="rcSrc">
            <button type="button" data-src="kitbot">官方 KitBot</button>
            <button type="button" data-src="custom">我們自己的模型</button>
          </div>
          <div id="rcCustom">
            <div class="rc-r" style="margin-top:8px;flex-wrap:wrap">
              <input type="file" id="rcFile" accept=".glb,.gltf,model/gltf-binary">
              <span id="rcFileName" style="font-size:12px;color:var(--dim)">${esc(work.model.fileName || '')}</span>
            </div>
            <div class="rc-info">📤 <b>從 Onshape 匯出</b>:在組合件(Assembly)分頁上按右鍵 → <b>Export</b> → 格式選 <b>GLTF</b>,
              能選的話勾 <b>binary(.glb)</b> → 下載後在這裡選檔案。SolidWorks / Fusion 360 / Blender 一樣匯出成 <b>.glb</b> 就行。
              <br>模型歪了或躺著:用下面的旋轉調正(車頭要朝畫面的「前方」);單位不對就改縮放(公釐 = 0.001)。</div>
            <div class="rc-g" style="margin-top:8px">
              ${rotSel('X')}${rotSel('Y')}${rotSel('Z')}
              ${num('model.scale', '縮放', '倍', 'step="any" min="0.0001"', '勾自動縮放時可以不管')}
              ${num('model.lift', '離地高度微調', 'm', 'step="0.005"')}
              <label class="rc-f"><span>選項</span><span class="rc-r" style="flex-direction:column;align-items:flex-start;gap:3px">
                <label><input type="checkbox" data-p="model.autoFit"${work.model.autoFit !== false ? ' checked' : ''}> 自動縮放到車身尺寸</label>
                <label><input type="checkbox" data-p="model.bumpers"${work.model.bumpers !== false ? ' checked' : ''}> 自動加保險桿</label>
                <label><input type="checkbox" data-p="model.showMechs"${work.model.showMechs ? ' checked' : ''}> 顯示模擬器的砲台 / 手臂 / 球</label>
              </span></label>
            </div>
            <div class="rc-info" id="rcModelInfo"></div>
          </div>
        </div>

        <div class="rc-sec"><h3>🎨 保險桿與隊號</h3>
          <div class="rc-g">
            <label class="rc-f"><span>保險桿顏色(聯盟)</span><span class="rc-seg" id="rcColor">
              <button type="button" data-c="red">🔴 紅</button><button type="button" data-c="blue">🔵 藍</button></span></label>
            <label class="rc-f"><span>隊號</span><span class="rc-r"><input type="text" data-p="teamNumber" maxlength="6" value="${esc(work.teamNumber)}"></span></label>
            <label class="rc-f"><span>隊徽圖片(印在保險桿上)</span><span class="rc-r">
              <img class="rc-logo" id="rcLogoPrev" alt="" style="display:none">
              <input type="file" id="rcLogo" accept="image/*" style="max-width:170px">
              <button type="button" class="rc-btn" id="rcLogoDel">拿掉</button></span></label>
          </div>
        </div>

        <div class="rc-sec"><h3>📐 尺寸(含保險桿)</h3>
          <div class="rc-g">
            ${num('length', '長(前後)', 'm', 'step="0.01" min="0.4" max="1.5"')}
            ${num('width', '寬(左右)', 'm', 'step="0.01" min="0.4" max="1.5"')}
          </div>
        </div>

        <div class="rc-sec"><h3>🧩 機構組裝</h3>
          <div class="rc-info" style="margin-top:0">藍圖可以直接拖:<b>俯視圖</b>拖橘色圓點 = Shooter 前後位置、拖綠色框的邊 = Intake 寬度 / 伸出長度;<b>側視圖</b>拖橘色圓點 = Shooter 高度。
            這些數字會真的影響模擬:吸得到多寬的球、球從哪裡射出去、籃子裝幾顆。</div>
          <canvas id="rcBlue" style="width:100%;height:230px;display:block;margin-top:8px;border-radius:10px;background:#0b1016;touch-action:none;cursor:grab"></canvas>
          <div class="rc-g" style="margin-top:8px">
            <label class="rc-f"><span>Intake</span><span class="rc-r"><select data-p="parts.intake.type">
              <option value="pivot"${work.parts.intake.type !== 'none' ? ' selected' : ''}>放下式(手臂往前放)</option>
              <option value="none"${work.parts.intake.type === 'none' ? ' selected' : ''}>沒有 Intake</option></select></span></label>
            ${num('parts.intake.width', 'Intake 寬度', 'm', 'step="0.01" min="0.2" max="1.4"')}
            ${num('parts.intake.reach', 'Intake 伸出保險桿外', 'm', 'step="0.01" min="0.08" max="0.8"')}
            ${num('parts.intake.pivotH', 'Intake 樞紐高度', 'm', 'step="0.01" min="0.1" max="0.8"')}
            <label class="rc-f"><span>Shooter</span><span class="rc-r"><select data-p="parts.shooter.type">
              <option value="turret"${work.parts.shooter.type === 'turret' ? ' selected' : ''}>砲塔(可以左右轉)</option>
              <option value="fixed"${work.parts.shooter.type === 'fixed' ? ' selected' : ''}>固定朝前(要轉車身瞄準)</option>
              <option value="none"${work.parts.shooter.type === 'none' ? ' selected' : ''}>沒有 Shooter</option></select></span></label>
            ${num('parts.shooter.x', 'Shooter 前後位置(+ 往前)', 'm', 'step="0.01" min="-0.7" max="0.7"')}
            ${num('parts.shooter.h', 'Shooter 高度', 'm', 'step="0.01" min="0.2" max="1.6"')}
            ${num('parts.hopper.capacity', '籃子容量', '顆', 'step="1" min="1" max="80"')}
          </div>
        </div>

        <div class="rc-sec"><h3>⚡ 底盤動力(坦克式)</h3>
          <div class="rc-g">
            <label class="rc-f"><span>馬達</span><span class="rc-r"><select data-p="drive.motor">
              ${motors.map(m => `<option value="${m.id}"${m.id === work.drive.motor ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></span></label>
            ${num('drive.perSide', '每一邊幾顆馬達', '顆', 'step="1" min="1" max="4"')}
            ${num('drive.ratio', '減速比', ': 1', 'step="0.01" min="1"')}
            ${num('drive.wheelIn', '輪子直徑', '吋', 'step="0.25" min="2" max="8"')}
            ${num('drive.mass', '整車重量(含電池、保險桿)', 'kg', 'step="0.5" min="10" max="80"')}
            ${num('drive.mu', '輪胎摩擦係數', '', 'step="0.05" min="0.3" max="2"', '防滑胎約 1.1、全向輪約 0.7')}
            ${num('drive.statorLimit', '定子電流限制(每顆)', 'A', 'step="5" min="0"', '0 = 不限制')}
            ${num('drive.supplyLimit', '供電電流限制(每顆)', 'A', 'step="5" min="0"', '0 = 不限制')}
          </div>
          <div class="rc-info" id="rcDriveInfo"></div>
        </div>

        <div class="rc-sec"><h3>🔋 電池</h3>
          <div class="rc-g">
            ${num('battery.openV', '開路電壓', 'V', 'step="0.1" min="10" max="13.5"', '充飽 12.8、快沒電 12.0')}
            ${num('battery.resistance', '內阻 + 線路電阻', 'Ω', 'step="0.001" min="0.005" max="0.1"', '新電池約 0.015')}
          </div>
        </div>

        <div class="acts">
          <button type="button" id="rcReset">恢復預設</button>
          <button type="button" id="rcPeek" title="先把這個視窗收起來,看看 3D 畫面裡的車">👀 看一下</button>
          <span style="flex:1"></span>
          <button value="cancel" id="rcCancel" formnovalidate>取消</button>
          <button type="button" class="go" id="rcSave">💾 儲存</button>
        </div>
      </form>`;
    const $ = sel => dlg.querySelector(sel);

    const refresh = () => {
      $('#rcSrc').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.src === work.model.source));
      $('#rcColor').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.c === work.bumperColor));
      $('#rcCustom').style.display = work.model.source === 'custom' ? '' : 'none';
      // 模型資訊
      const V = view(), info = V && V.robotModelInfo;
      $('#rcModelInfo').innerHTML = !V ? '3D 畫面還沒開過:切到 3D 之後就會看到模型。'
        : info && info.error ? `<span class="rc-bad">⚠️ ${esc(info.error)}</span>`
        : info ? `模型:${info.parts} 個零件、${info.tris.toLocaleString()} 個三角形(合併成 ${info.merged} 塊,略過 ${info.dropped} 個小零件)
            <br>原始大小 ${info.rawSize.join(' × ')}(長 × 寬 × 高)→ 套用後 <b>${info.size.join(' × ')} m</b>
            ${info.tris > 800000 ? '<br><span class="rc-warn">⚠️ 三角形很多,手機或舊電腦可能會卡。Onshape 匯出時可以調低精細度,或先把螺絲、線材拿掉。</span>' : ''}
            ${info.rawSize[0] > 50 ? '<br><span class="rc-warn">原始大小很大,單位可能是公釐:沒勾自動縮放的話,縮放填 0.001</span>' : ''}`
        : '還沒選模型檔。';
      // 底盤性能
      const sp = PHYS.driveSpecs && PHYS.driveSpecs(work);
      if (sp) {
        $('#rcDriveInfo').innerHTML = `理論極速 <b>${sp.vFree.toFixed(2)} m/s</b>(${(sp.vFree * 3.281).toFixed(1)} ft/s,12 V 沒負載;實際會再低一些)
          · 最大加速度 <b>${sp.aMax.toFixed(1)} m/s²</b>(${(sp.aMax / 9.81).toFixed(2)} g)
          <br>馬達在電流限制下的推力 ${sp.fMotor.toFixed(0)} N、輪胎抓地力 ${sp.fGrip.toFixed(0)} N →
          ${sp.slips ? '<span class="rc-warn">推力比抓地力大:全力起步和推車時輪子會打滑(加速度被輪胎限制)</span>' : '<span class="rc-ok">不會打滑(加速度被馬達電流限制)</span>'}
          ${sp.vFree > 6 ? '<br><span class="rc-warn">⚠️ 極速超過 6 m/s:加速會很慢、很難控制,可以加大減速比</span>' : ''}`;
      }
    };
    // ---------- 🧩 藍圖(俯視 + 側視),可以拖 ----------
    const bp = $('#rcBlue');
    let bpGeo = null, drag = null;
    const drawBlue = () => {
      const dpr = window.devicePixelRatio || 1, Wc = bp.clientWidth, Hc = bp.clientHeight;
      if (!Wc) return;
      if (bp.width !== Math.round(Wc * dpr)) { bp.width = Math.round(Wc * dpr); bp.height = Math.round(Hc * dpr); }
      const g = bp.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, Wc, Hc);
      const L = +work.length || 0.86, Wd = +work.width || 0.86, it = work.parts.intake, sh = work.parts.shooter;
      const reach = it.type === 'none' ? 0 : +it.reach, iw = Math.min(+it.width, Wd - 0.04);
      // 左半邊:俯視(車頭朝右)
      const topW = Wc * 0.55, sc = Math.min((topW - 40) / (L + reach + 0.2), (Hc - 40) / (Wd + 0.2));
      const cx = 20 + (topW - 40) / 2 - reach * sc / 2, cy = Hc / 2;
      const X = x => cx + x * sc, Y = y => cy + y * sc;
      g.font = '600 11px system-ui,sans-serif'; g.textBaseline = 'middle';
      g.fillStyle = '#8b949e'; g.fillText('俯視(車頭 →)', 10, 12);
      const bumper = work.bumperColor === 'blue' ? '#1f6feb' : '#c8102e';
      g.fillStyle = bumper; g.fillRect(X(-L / 2), Y(-Wd / 2), L * sc, Wd * sc);
      g.fillStyle = '#2b3138'; g.fillRect(X(-L / 2 + 0.085), Y(-Wd / 2 + 0.085), (L - 0.17) * sc, (Wd - 0.17) * sc);
      // 籃子(示意:車身後半)
      g.strokeStyle = '#1fb5a8'; g.lineWidth = 1.5; g.setLineDash([4, 3]);
      g.strokeRect(X(-L / 2 + 0.12), Y(-Wd / 2 + 0.14), (L * 0.45) * sc, (Wd - 0.28) * sc); g.setLineDash([]);
      g.fillStyle = '#1fb5a8'; g.fillText(`籃子 ${work.parts.hopper.capacity} 顆`, X(-L / 2 + 0.14), Y(-Wd / 2 + 0.22));
      // Intake(放下的樣子)
      let intakeBox = null;
      if (it.type !== 'none') {
        intakeBox = { x0: X(L / 2), x1: X(L / 2 + reach), y0: Y(-iw / 2), y1: Y(iw / 2) };
        g.fillStyle = 'rgba(63,185,80,.25)'; g.strokeStyle = '#3fb950'; g.lineWidth = 2;
        g.fillRect(intakeBox.x0, intakeBox.y0, intakeBox.x1 - intakeBox.x0, intakeBox.y1 - intakeBox.y0);
        g.strokeRect(intakeBox.x0, intakeBox.y0, intakeBox.x1 - intakeBox.x0, intakeBox.y1 - intakeBox.y0);
        g.fillStyle = '#3fb950'; g.fillText(`Intake ${iw.toFixed(2)} m`, intakeBox.x0 + 3, intakeBox.y0 - 8);
      }
      // Shooter
      let shDot = null;
      if (sh.type !== 'none') {
        shDot = { x: X(+sh.x), y: cy };
        g.fillStyle = '#f0883e'; g.beginPath(); g.arc(shDot.x, shDot.y, 8, 0, 7); g.fill();
        g.strokeStyle = '#f0883e'; g.lineWidth = 2; g.beginPath(); g.moveTo(shDot.x, shDot.y); g.lineTo(shDot.x + 26, shDot.y); g.stroke();
        if (sh.type === 'turret') { g.beginPath(); g.arc(shDot.x, shDot.y, 16, -0.9, 0.9); g.stroke(); }
      }
      // 右半邊:側視
      const sx0 = topW + 10, sw = Wc - sx0 - 10, ground = Hc - 26;
      const ss = Math.min(sw / (L + reach + 0.9), (ground - 24) / 1.9);
      const SX = x => sx0 + 20 + (x + L / 2) * ss, SY = h => ground - h * ss;
      g.fillStyle = '#8b949e'; g.fillText('側視', sx0, 12);
      g.strokeStyle = '#30363d'; g.lineWidth = 1; g.beginPath(); g.moveTo(sx0, ground); g.lineTo(Wc - 6, ground); g.stroke();
      g.fillStyle = bumper; g.fillRect(SX(-L / 2), SY(0.165), L * ss, 0.13 * ss);
      g.fillStyle = '#39424d'; g.fillRect(SX(-L / 2 + 0.05), SY(0.3), (L - 0.1) * ss, 0.135 * ss);
      if (it.type !== 'none') {                                   // 放下的 Intake 手臂
        g.strokeStyle = '#3fb950'; g.lineWidth = 4;
        g.beginPath(); g.moveTo(SX(L / 2 - 0.05), SY(+it.pivotH)); g.lineTo(SX(L / 2 + reach), SY(0.06)); g.stroke();
      }
      let shSide = null;
      if (sh.type !== 'none') {
        const mz = +sh.h + 0.08, la = ((ROBOT.config.shooter && ROBOT.config.shooter.launchDeg) ?? 60) * Math.PI / 180;
        g.strokeStyle = '#6e7781'; g.lineWidth = 3; g.beginPath(); g.moveTo(SX(+sh.x), SY(0.3)); g.lineTo(SX(+sh.x), SY(+sh.h)); g.stroke();
        shSide = { x: SX(+sh.x), y: SY(mz) };
        g.setLineDash([5, 4]); g.strokeStyle = '#f0883e'; g.lineWidth = 1.5;   // 出球方向
        g.beginPath(); g.moveTo(shSide.x, shSide.y); g.lineTo(shSide.x + Math.cos(la) * 60, shSide.y - Math.sin(la) * 60); g.stroke(); g.setLineDash([]);
        g.fillStyle = '#f0883e'; g.beginPath(); g.arc(shSide.x, shSide.y, 7, 0, 7); g.fill();
        g.fillText(`出球點 ${mz.toFixed(2)} m`, shSide.x + 10, shSide.y + 14);
      }
      g.fillStyle = '#8b949e'; g.fillText(`${L.toFixed(2)} × ${Wd.toFixed(2)} m`, 10, Hc - 10);
      bpGeo = { sc, ss, intakeBox, shDot, shSide, L, Wd, cy };
    };
    const setField = (path, v) => {
      const ks = path.split('.'), last = ks.pop();
      ks.reduce((a, k) => a[k], work)[last] = +v.toFixed(3);
      const el = dlg.querySelector(`[data-p="${path}"]`); if (el) el.value = +v.toFixed(3);
    };
    bp.addEventListener('pointerdown', e => {
      if (!bpGeo) return;
      const r = bp.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G2 = bpGeo;
      const near = (a, b, d = 12) => a && Math.hypot(x - a.x, y - b) < d;
      if (G2.shDot && near(G2.shDot, G2.shDot.y)) drag = { k: 'shx', x0: x, v0: +work.parts.shooter.x };
      else if (G2.shSide && near(G2.shSide, G2.shSide.y)) drag = { k: 'shh', y0: y, v0: +work.parts.shooter.h };
      else if (G2.intakeBox) {
        const b = G2.intakeBox;
        if (Math.abs(x - b.x1) < 8 && y > b.y0 && y < b.y1) drag = { k: 'reach', x0: x, v0: +work.parts.intake.reach };
        else if ((Math.abs(y - b.y0) < 8 || Math.abs(y - b.y1) < 8) && x > b.x0 - 4 && x < b.x1 + 4) drag = { k: 'width', y0: y, v0: +work.parts.intake.width, sgn: y < G2.cy ? -1 : 1 };
      }
      if (drag) { bp.setPointerCapture(e.pointerId); bp.style.cursor = 'grabbing'; }
    });
    bp.addEventListener('pointermove', e => {
      if (!drag || !bpGeo) return;
      const r = bp.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G2 = bpGeo;
      const clampV = (v, a, b) => Math.max(a, Math.min(b, v));
      if (drag.k === 'shx') setField('parts.shooter.x', clampV(drag.v0 + (x - drag.x0) / G2.sc, -G2.L / 2 + 0.1, G2.L / 2 - 0.05));
      if (drag.k === 'shh') setField('parts.shooter.h', clampV(drag.v0 - (y - drag.y0) / G2.ss, 0.2, 1.6));
      if (drag.k === 'reach') setField('parts.intake.reach', clampV(drag.v0 + (x - drag.x0) / G2.sc, 0.08, 0.8));
      if (drag.k === 'width') setField('parts.intake.width', clampV(drag.v0 + drag.sgn * 2 * (y - drag.y0) / G2.sc, 0.2, G2.Wd - 0.04));
      drawBlue();
    });
    const endDrag = () => { if (drag) { drag = null; bp.style.cursor = 'grab'; live(); } };
    bp.addEventListener('pointerup', endDrag);
    bp.addEventListener('pointercancel', endDrag);

    const live = () => { apply(work); refresh(); drawBlue(); };

    dlg.querySelectorAll('[data-p]').forEach(el => el.addEventListener('change', () => {
      const path = el.dataset.p.split('.'), last = path.pop();
      const o = path.reduce((a, k) => a[k], work);
      if (el.type === 'checkbox') o[last] = el.checked;
      else if (el.type === 'number' || el.tagName === 'SELECT' && /^rot/.test(last)) {
        const v = parseFloat(el.value);
        if (!Number.isFinite(v)) return;
        o[last] = v;
      } else o[last] = el.value;
      live();
    }));
    $('#rcSrc').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      work.model.source = b.dataset.src;
      apply(work, { reloadBlobs: true }).then(refresh);
      refresh();
    };
    $('#rcColor').onclick = e => { const b = e.target.closest('button'); if (!b) return; work.bumperColor = b.dataset.c; live(); };
    $('#rcFile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      if (!/\.glb$/i.test(f.name)) toast('💡 .gltf 如果有另外的 .bin / 貼圖檔會讀不到,建議匯出成 .glb', 4000);
      $('#rcModelInfo').textContent = `讀取中… ${(f.size / 1048576).toFixed(1)} MB`;
      try {
        const buf = await f.arrayBuffer();
        const V = view();
        work.model.source = 'custom';
        work.model.fileName = f.name;
        $('#rcFileName').textContent = f.name;
        if (V) { await V.setRobotModel(buf); V.setRobotLook(work); }
        memModel = { key: blobKey('model'), buf };
        refresh();
      } catch (err) { $('#rcModelInfo').innerHTML = `<span class="rc-bad">⚠️ ${esc(err.message)}</span>`; }
    };
    // 隊徽:縮到 256 px 以內存成 PNG(保險桿上的字牌也才 160 px 高)
    const logoPrev = url => { const im = $('#rcLogoPrev'); im.style.display = url ? '' : 'none'; if (url) im.src = url; };
    if (memLogo !== undefined) logoPrev(memLogo); else idb.get(blobKey('logo')).then(u => logoPrev(u));
    $('#rcLogo').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const im = await loadImg(URL.createObjectURL(f));
        const k = Math.min(1, 256 / Math.max(im.width, im.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(im.width * k); cv.height = Math.round(im.height * k);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        const url = cv.toDataURL('image/png');
        memLogo = url; logoPrev(url);
        const V = view(); if (V) V.setRobotLogo(cv);
      } catch { toast('⚠️ 讀不到這張圖片', 3000); }
    };
    $('#rcLogoDel').onclick = () => { memLogo = null; logoPrev(null); const V = view(); if (V) V.setRobotLogo(null); };
    $('#rcReset').onclick = () => {
      const keepModel = work.model.fileName;
      work = clone(DEF); work.model.fileName = keepModel;
      dlg.close('reset'); apply(work).then(() => open(true));
    };
    // 👀 看一下:收起視窗(不還原設定),畫面上方出現「回到自訂機器人」
    $('#rcPeek').onclick = () => {
      dlg.close('peek');
      let bar = document.getElementById('rcPeekBar');
      if (!bar) {
        bar = document.createElement('div'); bar.id = 'rcPeekBar';
        bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:50;background:#1f6feb;color:#fff;padding:8px 14px;border-radius:10px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4)';
        document.body.append(bar);
      }
      bar.textContent = '↩ 回到 🤖 自訂機器人(還沒儲存)';
      bar.style.display = '';
      bar.onclick = () => { bar.style.display = 'none'; open(true); };
    };
    $('#rcSave').onclick = async () => {
      if (memModel.buf && memModel.key === blobKey('model'))
        await idb.put(memModel.key, memModel.buf).catch(() => toast('⚠️ 模型檔太大,這台電腦存不下(只在這次有效)', 4000));
      if (memLogo !== undefined) await (memLogo ? idb.put(blobKey('logo'), memLogo) : idb.del(blobKey('logo')));
      memLogo = undefined;
      cur = work;
      await saveBody(work);
      dlg.close('saved');
    };
    dlg.onclose = () => {
      // 取消 / 按 Esc:回到原本的設定
      if (!['saved', 'reset', 'peek'].includes(dlg.returnValue)) { memModel = { key: null, buf: null }; memLogo = undefined; apply(saved, { reloadBlobs: true }); }
    };
    dlg.returnValue = '';
    refresh();
    if (!dlg.open) dlg.showModal();
    requestAnimationFrame(drawBlue);
  }

  // 工具列按鈕(放在 ⚙️ 機構設定 旁邊)
  const bar = document.getElementById('resetPose').parentElement;
  const btn = document.createElement('button');
  btn.id = 'bodyBtn'; btn.textContent = '🤖 自訂機器人'; btn.title = '匯入 3D 模型、保險桿、尺寸、底盤馬達、電池';
  btn.onclick = open;
  bar.insertBefore(btn, document.getElementById('mapBtn') || document.getElementById('fullBtn'));

  return { open, get config() { return cur; }, DEF };
})();
