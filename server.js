// 模擬搖桿的小網頁伺服器:把 index.html 給瀏覽器(電腦或同一個 Wi-Fi 的手機),
// 再加上「目前開的是哪個機器人專案」的小 API(/api/project)。
// 搖桿數值是網頁自己直接連模擬器送的,這支程式不經手。
// 用法:node server.js   → 打開 http://localhost:8765
//       環境變數 PORT 改 port、LEO_PROJECT 改專案資料夾
// 桌面軟體版(app/main.js)也是 require 這支的 createServer,兩邊的 API 保證一樣。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
                '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
                '.glb': 'model/gltf-binary', '.json': 'application/json', '.md': 'text/markdown' };
const CONFIG_NAME = '.robot-sim.json';      // 每個專案自己的機構設定(哪個 CAN ID 是什麼馬達),放在專案資料夾裡
const MAX_BODY = 256 * 1024;

function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) urls.push(`http://${a.address}:${port}`);
    }
  }
  return urls;
}
// 寫入類的 API 只接受這台電腦自己(手機可以看,不能改)
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const sendJson = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function readConfig(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_NAME), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

// opts:webDir 網頁檔在哪、port、getProject() 回傳目前專案的絕對路徑(沒有就 null)、
//      canSwitch 能不能換專案(桌面軟體 true)、onSwitch() 換專案時呼叫
function createServer({ webDir, port, getProject, canSwitch = false, onSwitch = null }) {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/info') return sendJson(res, 200, { urls: lanUrls(port) });

    // ---------- 專案 API ----------
    if (url === '/api/project' && req.method === 'GET') {
      const dir = getProject();
      if (!dir) return sendJson(res, 404, { error: '還沒開專案' });
      return sendJson(res, 200, { name: path.basename(dir), path: dir, config: readConfig(dir), canSwitch });
    }
    if (url === '/api/project/config' && req.method === 'PUT') {
      if (!isLocal(req)) return sendJson(res, 403, { error: '只能在跑模擬器的這台電腦上改設定' });
      const dir = getProject();
      if (!dir) return sendJson(res, 404, { error: '還沒開專案' });
      let body = '', size = 0, dead = false;
      req.setEncoding('utf8');
      req.on('data', c => {
        size += Buffer.byteLength(c);
        if (size > MAX_BODY && !dead) { dead = true; sendJson(res, 413, { error: '設定檔太大(上限 256KB)' }); req.destroy(); }
        else body += c;
      });
      req.on('end', () => {
        if (dead) return;
        let obj;
        try { obj = JSON.parse(body); } catch { return sendJson(res, 400, { error: '不是正確的 JSON' }); }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return sendJson(res, 400, { error: '設定要是一個 JSON 物件' });
        try { fs.writeFileSync(path.join(dir, CONFIG_NAME), JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
        catch (e) { return sendJson(res, 500, { error: '寫不進去:' + e.message }); }
        sendJson(res, 200, { ok: true });
      });
      return;
    }
    if (url === '/api/switch-project' && req.method === 'POST') {
      if (!canSwitch || !onSwitch) { res.writeHead(404); return res.end(); }
      if (!isLocal(req)) return sendJson(res, 403, { error: '只能在跑模擬器的這台電腦上換專案' });
      sendJson(res, 200, { ok: true });
      return setImmediate(onSwitch);        // 先回應,再關模擬器(不然網頁收不到回應)
    }
    if (url.startsWith('/api/')) return sendJson(res, 404, { error: '沒有這個 API' });

    // ---------- 網頁檔 ----------
    // 只給這個資料夾第一層的網頁檔(不接受子資料夾或 ..,避免被讀到別的檔案)
    // 畸形的 % 編碼會讓 decodeURIComponent 丟例外 → 以前整個伺服器會當掉(紅隊實測)
    let name;
    try { name = decodeURIComponent(url).replace(/^\/+/, '') || 'index.html'; }
    catch { res.writeHead(400); return res.end(); }
    if (name === 'server.js') { res.writeHead(404); return res.end(); }   // 伺服器自己的程式不給看
    const type = TYPES[path.extname(name).toLowerCase()];
    // 例外:assets/ 底下的官方 3D 模型(只允許 assets/資料夾/檔名 這一層,不接受 ..)
    const okPath = !name.includes('..') && !name.includes('\\') && (!name.includes('/') || /^assets\/[\w.-]+\/[\w.-]+$/.test(name));
    const file = path.join(webDir, name);
    if (type && okPath && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const isText = /^(text|application\/(json|manifest))/.test(type) || type === 'image/svg+xml';
      res.writeHead(200, { 'Content-Type': isText ? `${type}; charset=utf-8` : type,
                           'Cache-Control': name.startsWith('assets/') ? 'max-age=86400' : 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end();
  });
}

module.exports = { createServer, lanUrls, CONFIG_NAME };

if (require.main === module) {
  // 單一請求出錯不能讓整個搖桿伺服器死掉
  process.on('uncaughtException', e => console.error('[server] 忽略錯誤:', e && e.message));
  const PORT = +process.env.PORT || 8765;
  const PROJECT = process.env.LEO_PROJECT || 'C:\\Users\\frc94\\Downloads\\FRC\\LEO';
  createServer({ webDir: __dirname, port: PORT, getProject: () => (fs.existsSync(PROJECT) ? PROJECT : null) })
    .listen(PORT, '0.0.0.0', () => {
      console.log(`模擬搖桿網頁:http://localhost:${PORT}`);
      for (const u of lanUrls(PORT)) console.log(`手機(同一個 Wi-Fi):${u}`);
    });
}
