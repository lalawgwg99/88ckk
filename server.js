/**
 * 《凡人問道錄：一念掌天》— 雲端帳密存檔與九天仙榜伺服器 (Node.js Zero-Dependency Server)
 * 啟動方式：node server.js (預設連接埠 3000)
 * 支援 API：
 *   GET  /api/health       — 伺服器狀態檢查
 *   POST /api/auth         — 帳密註冊 / 登入並載入雲端存檔
 *   POST /api/save         — 儲存玩家遊戲進度與更新弟子/宗門排行榜
 *   POST /api/load         — 依帳密下載伺服器最新存檔
 *   GET  /api/leaderboard  — 取得全服弟子排行與宗門排行資料
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'server_db.json');

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        parsed.users = parsed.users || {};
        parsed.leaderboard = parsed.leaderboard || {};
        return parsed;
      }
    }
  } catch (e) {
    console.error('Failed to read DB_FILE:', e.message);
  }
  return { users: {}, leaderboard: {} };
}

function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write DB_FILE:', e.message);
  }
}

function hashPassword(username, password) {
  return crypto
    .createHash('sha256')
    .update(`88ckk_salt_${username.toLowerCase().trim()}_${password}`)
    .digest('hex');
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 200, { ok: true });
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, mode: 'local-node-server', timestamp: Date.now() });
  }

  if (pathname === '/api/leaderboard' && req.method === 'GET') {
    const db = loadDb();
    const players = Object.values(db.leaderboard || {});
    return sendJson(res, 200, { ok: true, players });
  }

  if (pathname === '/api/auth' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || username.length < 2 || password.length < 3) {
        return sendJson(res, 400, { ok: false, error: '帳號需至少 2 字元，密碼需至少 3 字元' });
      }
      const db = loadDb();
      const pHash = hashPassword(username, password);
      const existing = db.users[username];

      if (!existing) {
        // 新帳號自動註冊並保存當前存檔
        db.users[username] = {
          username,
          passwordHash: pHash,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          saveData: body.saveData || null
        };
        if (body.summary && body.summary.playerName) {
          db.leaderboard[username] = Object.assign({}, body.summary, {
            username,
            updatedAt: Date.now()
          });
        }
        saveDb(db);
        return sendJson(res, 200, {
          ok: true,
          action: 'registered',
          username,
          saveData: db.users[username].saveData,
          players: Object.values(db.leaderboard)
        });
      }

      if (existing.passwordHash !== pHash) {
        return sendJson(res, 401, { ok: false, error: '密碼錯誤，請重新確認！' });
      }

      return sendJson(res, 200, {
        ok: true,
        action: 'logged_in',
        username,
        saveData: existing.saveData,
        updatedAt: existing.updatedAt,
        players: Object.values(db.leaderboard)
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/save' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password) {
        return sendJson(res, 400, { ok: false, error: '請先輸入帳號與密碼' });
      }
      const db = loadDb();
      const pHash = hashPassword(username, password);
      const existing = db.users[username];

      if (existing && existing.passwordHash !== pHash) {
        return sendJson(res, 401, { ok: false, error: '帳號密碼驗證失敗，無法覆寫伺服器存檔' });
      }

      db.users[username] = {
        username,
        passwordHash: pHash,
        createdAt: existing ? existing.createdAt : Date.now(),
        updatedAt: Date.now(),
        saveData: body.saveData || (existing ? existing.saveData : null)
      };

      if (body.summary && body.summary.playerName) {
        db.leaderboard[username] = Object.assign({}, body.summary, {
          username,
          updatedAt: Date.now()
        });
      }

      saveDb(db);
      return sendJson(res, 200, {
        ok: true,
        updatedAt: db.users[username].updatedAt,
        players: Object.values(db.leaderboard)
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (pathname === '/api/load' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const db = loadDb();
      const existing = db.users[username];
      if (!existing) {
        return sendJson(res, 404, { ok: false, error: '伺服器上找不到此帳號存檔' });
      }
      if (existing.passwordHash !== hashPassword(username, password)) {
        return sendJson(res, 401, { ok: false, error: '密碼錯誤，無法讀取存檔' });
      }
      return sendJson(res, 200, {
        ok: true,
        saveData: existing.saveData,
        updatedAt: existing.updatedAt,
        players: Object.values(db.leaderboard)
      });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // Static file serving for index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(htmlPath).pipe(res);
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`《凡人問道錄：一念掌天》雲端存檔與仙榜伺服器已啟動`);
  console.log(`👉 請開啟瀏覽器訪問: http://localhost:${PORT}`);
  console.log(`💾 伺服器存檔資料庫: ${DB_FILE}`);
  console.log(`====================================================`);
});
