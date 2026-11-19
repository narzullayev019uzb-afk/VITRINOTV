require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const multer = require('multer');
const { Bot, InlineKeyboard, webhookCallback } = require('grammy');
const { db, DATA, getSetting, setSetting } = require('./db');
const st = require('./storage');

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const AP = (process.env.ADMIN_PATH || 'panel').replace(/[^\w-]/g, '');
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
const PORT = process.env.PORT || 3000;
const now = () => Math.floor(Date.now() / 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hmac = d => crypto.createHmac('sha256', SECRET).update(String(d)).digest('hex');
const hashPw = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');
const escHtml = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => { console.error(err); if (!res.headersSent) res.status(500).json({ error: 'Server xatosi' }); });

const UP = path.join(DATA, 'uploads');
const PRIV = path.join(UP, 'private');
try { fs.rmSync(path.join(UP, 'tmp'), { recursive: true, force: true }); } catch (e) {}
const rm = (f, priv) => { if (f) fs.unlink(path.join(priv ? PRIV : UP, path.basename(f)), () => {}); };
const isS3 = f => String(f || '').startsWith('s3:');
function rmEp(file) { if (isS3(file)) st.del(file.slice(3)).catch(() => {}); else rm(file, true); }
async function persistImage(name, type) {
  if (!name || !st.enabled) return name;
  try { await st.putFile('img/' + name, path.join(UP, name), type || (/\.png$/i.test(name) ? 'image/png' : 'image/jpeg')); }
  catch (e) { console.error('S3 rasm xato:', e.message); }
  return name;
}
async function proxyS3(req, res, key, type, cache) {
  const range = req.headers.range;
  const r = await st.getObject(key, range);
  res.status(range && r.ContentRange ? 206 : 200);
  res.set({ 'Content-Type': r.ContentType || type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': cache || 'public, max-age=2592000, immutable' });
  if (r.ContentLength != null) res.set('Content-Length', String(r.ContentLength));
  if (r.ContentRange) res.set('Content-Range', r.ContentRange);
  r.Body.pipe(res);
}
let bkT = null, syT = null, bkBusy = false, bkLast = -1;
async function runBackup(force) {
  if (!st.enabled || bkBusy) return;
  const n = db.prepare('SELECT total_changes() n').get().n;
  if (!force && n === bkLast) return;
  bkBusy = true;
  try {
    const tmp = path.join(DATA, 'backup.tmp');
    fs.rmSync(tmp, { force: true });
    await db.backup(tmp);
    await st.putFile('db/app.db', tmp, 'application/octet-stream');
    bkLast = n;
  } catch (e) { console.error('Zaxira xato:', e.message); }
  bkBusy = false;
}
function scheduleBackup() { if (!st.enabled) return; clearTimeout(bkT); bkT = setTimeout(() => runBackup(false), 4000); }
function scheduleSync() { clearTimeout(syT); syT = setTimeout(() => pushAll('sync', {}), 1200); }
const SYNC = /\/api\/(categories|banners|episodes|settings|movies)(\/\d+)?(\/toggle)?$/;

function isPersistent() {
  if (!process.env.RENDER) return true;
  try { return fs.statSync(DATA).dev !== fs.statSync('/').dev; } catch (e) { return true; }
}
const PERSIST = isPersistent() || st.enabled;
if (!PERSIST) console.warn("DIQQAT: doimiy disk ulanmagan! Kinolar va sozlamalar qayta ishga tushganda o'chadi.");

// ---------- rasm va video ishlov ----------
async function optimizeImage(name, width) {
  let sharp;
  try { sharp = require('sharp'); } catch (e) { return name; }
  try {
    const out = name.replace(/\.\w+$/, '') + '-o.jpg';
    await sharp(path.join(UP, name)).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toFile(path.join(UP, out));
    rm(name);
    return out;
  } catch (e) { return name; }
}
let burnQ = Promise.resolve();
function burnWatermark(epId, file) {
  if (process.env.WATERMARK_BURN !== '1') return;
  let ff;
  try { ff = require('ffmpeg-static'); } catch (e) { return console.warn('ffmpeg-static topilmadi'); }
  const wm = path.join(__dirname, 'public', 'watermark.png');
  burnQ = burnQ.then(() => new Promise(resolve => {
    const outName = crypto.randomBytes(12).toString('hex') + '.mp4';
    const out = path.join(PRIV, outName);
    const args = ['-y', '-i', path.join(PRIV, file), '-i', wm, '-filter_complex', '[1:v]scale=220:-1[w];[0:v][w]overlay=W-w-24:24',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
    const p = spawn(ff, args, { stdio: 'ignore' });
    p.on('error', () => resolve());
    p.on('close', code => {
      if (code === 0) { db.prepare('UPDATE episodes SET file=? WHERE id=?').run(outName, epId); rm(file, true); }
      else fs.unlink(out, () => {});
      resolve();
    });
  }));
}

// ---------- boshlang'ich ma'lumotlar ----------
if (!db.prepare('SELECT 1 FROM admins WHERE id=1').get()) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO admins(id,username,salt,hash,role) VALUES(1,?,?,?,'super')")
    .run(process.env.ADMIN_USER || 'admin', salt, hashPw(process.env.ADMIN_PASS || 'admin12345', salt));
  if (!process.env.ADMIN_PASS) console.warn('ADMIN_PASS berilmagan! Panelda parolni darhol almashtiring.');
}
if (process.env.RESET_ADMIN === '1' && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE admins SET username=?,salt=?,hash=?,role='super' WHERE id=1").run(process.env.ADMIN_USER, salt, hashPw(process.env.ADMIN_PASS, salt));
  console.log('Admin login va parol tiklandi. RESET_ADMIN ni olib tashlang!');
}
if (!db.prepare('SELECT 1 FROM categories').get())
  ['Kinolar', 'Seriallar', 'Komediya', 'Jangari', 'Multfilmlar'].forEach(n => db.prepare('INSERT INTO categories(name) VALUES(?)').run(n));

const app = express();
app.set('trust proxy', 1);
app.use(compression({ filter: (req, res) => (req.path.endsWith('/live') ? false : compression.filter(req, res)) }));
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex'); next(); });

const storage = multer.diskStorage({
  destination: (req, f, cb) => cb(null, ['video', 'receipt'].includes(f.fieldname) ? PRIV : UP),
  filename: (req, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase())
});
const upAdmin = multer({ storage, limits: { fileSize: 5 * 1024 ** 3 } });
const upReceipt = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });

// ---------- real vaqt (SSE) ----------
const live = new Map();
const adminLive = new Set();
const sse = (res, ev, data) => { try { res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} };
function pushAll(ev, data) { live.forEach(set => set.forEach(r => sse(r, ev, data))); }
function pushUser(uid, ev, data) { const s = live.get(uid); if (s) s.forEach(r => sse(r, ev, data)); }
function pushAdmin(ev, data) { adminLive.forEach(r => sse(r, ev, data)); }
function openSse(req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(': ok\n\n');
}
setInterval(() => { pushAll('online', { n: live.size }); pushAdmin('online', { n: live.size }); }, 15000);
app.get('/live', (req, res) => {
  const [uid, exp, sig] = String(req.query.t || '').split('.');
  if (!sig || +exp < now() || hmac(`live.${uid}.${exp}`) !== sig) return res.sendStatus(403);
  const id = +uid;
  openSse(req, res);
  if (!live.has(id)) live.set(id, new Set());
  live.get(id).add(res);
  sse(res, 'online', { n: live.size });
  req.on('close', () => { const s = live.get(id); if (s) { s.delete(res); if (!s.size) live.delete(id); } });
});

// ---------- foydalanuvchilar va botlar ----------
function upsertUser(u) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  let usr = db.prepare('SELECT * FROM users WHERE tg_id=?').get(u.id);
  if (!usr) {
    db.prepare('INSERT INTO users(tg_id,name,username,created_at,last_seen) VALUES(?,?,?,?,?)').run(u.id, name, u.username || '', now(), now());
    usr = { tg_id: u.id, blocked: 0, phone: null };
    pushAdmin('user', { name });
  } else if (!usr.last_seen || now() - usr.last_seen > 60 || usr.name !== name) db.prepare('UPDATE users SET last_seen=?,name=?,username=? WHERE tg_id=?').run(now(), name, u.username || '', u.id);
  return usr;
}
const bots = new Map();
const mainBot = () => bots.get(db.prepare('SELECT MIN(id) id FROM bots').get().id);
const subCache = new Map();
async function missingChannels(uid) {
  if (getSetting('sub_required', '0') !== '1') return [];
  const chs = db.prepare('SELECT * FROM channels').all();
  if (!chs.length) return [];
  const hit = subCache.get(uid);
  if (hit && hit > Date.now()) return [];
  const main = mainBot();
  const miss = [];
  for (const c of chs) {
    try {
      const m = await main.api.getChatMember(c.chat, uid);
      if (['left', 'kicked'].includes(m.status)) miss.push(c);
    } catch (e) { /* bot kanalda admin emas - otkazib yuboramiz */ }
  }
  if (!miss.length) subCache.set(uid, Date.now() + 5 * 60 * 1000);
  return miss;
}

async function broadcast({ html, photo, movieId }) {
  const main = mainBot();
  const users = db.prepare('SELECT tg_id FROM users WHERE blocked=0').all();
  const kb = movieId ? new InlineKeyboard().url('▶ Ko\'rish', `https://t.me/${main.botInfo.username}?start=m${movieId}`) : undefined;
  let ok = 0, fail = 0;
  for (let i = 0; i < users.length; i++) {
    try {
      if (photo) await main.api.sendPhoto(users[i].tg_id, photo, { caption: html, parse_mode: 'HTML', reply_markup: kb });
      else await main.api.sendMessage(users[i].tg_id, html, { parse_mode: 'HTML', reply_markup: kb });
      ok++;
    } catch (e) {
      const wait = e && e.parameters && e.parameters.retry_after;
      if (wait) { await sleep((wait + 1) * 1000); i--; } else fail++;
    }
    if (i % 25 === 24) await sleep(1100);
  }
  return { ok, fail };
}
function announce(id, notify, isNew) {
  const m = db.prepare('SELECT * FROM movies WHERE id=?').get(id);
  if (!m) return;
  if (isNew) {
    const row = db.prepare(`SELECT ${MCOLS} ${FROMM} WHERE m.id=?`).get(m.id);
    pushAll('new', row || { id: m.id, title: m.title });
  }
  if (notify) {
    const html = `🎬 <b>${escHtml(m.title)}</b>${m.year ? ' (' + m.year + ')' : ''}\n\nYangi kino qo'shildi! Hoziroq tomosha qiling 👇`;
    broadcast({ html, photo: m.poster ? `${BASE}/files/${m.poster}` : null, movieId: m.id })
      .then(r => pushAdmin('broadcast', r)).catch(() => {});
  }
}

async function startBot(row) {
  const bot = new Bot(row.token);
  async function gate(ctx, payload) {
    const usr = upsertUser(ctx.from);
    if (usr.blocked) return;
    const miss = await missingChannels(ctx.from.id);
    if (miss.length) {
      const kb = new InlineKeyboard();
      miss.forEach(c => { if (c.link) kb.url('📢 ' + c.title, c.link).row(); });
      kb.text('✅ Tekshirish', 'check');
      const names = miss.map(c => '• ' + c.title).join('\n');
      return ctx.reply(`Botdan foydalanish uchun quyidagilarga a'zo bo'ling:\n\n${names}\n\nKeyin «Tekshirish» tugmasini bosing.`, { reply_markup: kb });
    }
    if (getSetting('phone_required', '1') === '1') {
      const me = db.prepare('SELECT phone FROM users WHERE tg_id=?').get(ctx.from.id);
      if (!me || !me.phone) {
        return ctx.reply('📱 Davom etish uchun telefon raqamingizni yuboring (pastdagi tugma orqali):', {
          reply_markup: { keyboard: [[{ text: '📱 Raqamni yuborish', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
        });
      }
    }
    const r = db.prepare('SELECT * FROM bots WHERE id=?').get(row.id);
    const mm = /^m(\d+)$/.exec(payload || '');
    const url = `${BASE}/?b=${row.id}` + (mm ? `&m=${mm[1]}` : '');
    const kb = new InlineKeyboard().webApp(r.button || 'Ochish', url);
    await ctx.reply(r.welcome || 'VITRINO TV ga xush kelibsiz!', { reply_markup: kb, parse_mode: 'HTML' });
  }
  bot.command('start', ctx => gate(ctx, ctx.match));
  bot.command('app', ctx => gate(ctx, ''));
  bot.on('inline_query', async ctx => {
    const q = (ctx.inlineQuery.query || '').trim();
    const rows = q
      ? db.prepare(`SELECT ${MCOLS} ${FROMM} WHERE m.title LIKE ? ORDER BY m.views DESC LIMIT 20`).all(`%${q}%`)
      : db.prepare(`SELECT ${MCOLS} ${FROMM} ORDER BY m.id DESC LIMIT 20`).all();
    const results = rows.map(m => ({
      type: 'article', id: String(m.id), title: m.title,
      description: [m.year, m.cat, m.price ? Number(m.price).toLocaleString('ru') + " so'm" : 'Bepul'].filter(Boolean).join(' • '),
      thumbnail_url: m.poster ? `${BASE}/files/${m.poster}` : undefined,
      input_message_content: { message_text: `🎬 <b>${escHtml(m.title)}</b>${m.year ? ' (' + m.year + ')' : ''}\n\nTomosha qiling 👇`, parse_mode: 'HTML' },
      reply_markup: { inline_keyboard: [[{ text: "▶ Ko'rish", url: `https://t.me/${bot.botInfo.username}?start=m${m.id}` }]] }
    }));
    await ctx.answerInlineQuery(results, { cache_time: 20, is_personal: false, button: { text: '🎬 VITRINO TV ni ochish', web_app: { url: `${BASE}/?b=${row.id}` } } });
  });
  bot.callbackQuery('check', async ctx => { await ctx.answerCallbackQuery(); await gate(ctx, ''); });
  bot.on('message:contact', async ctx => {
    const c = ctx.message.contact;
    if (c.user_id !== ctx.from.id) return ctx.reply("Iltimos, faqat o'zingizning raqamingizni yuboring.");
    upsertUser(ctx.from);
    const ph = c.phone_number.startsWith('+') ? c.phone_number : '+' + c.phone_number;
    db.prepare('UPDATE users SET phone=? WHERE tg_id=?').run(ph, ctx.from.id);
    await ctx.reply('✅ Rahmat!', { reply_markup: { remove_keyboard: true } });
    await gate(ctx, '');
  });
  bot.catch(e => console.error('bot xato:', e.message));
  await bot.init();
  await bot.api.setWebhook(`${BASE}/hook/${row.id}`, { secret_token: hmac('hook' + row.id).slice(0, 32) });
  try {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Kinolar', web_app: { url: `${BASE}/?b=${row.id}` } } });
  } catch (e) {}
  try { await bot.api.setMyCommands([{ command: 'start', description: 'Kinolarni ochish' }, { command: 'app', description: 'Mini ilovani ochish' }]); } catch (e) {}
  bots.set(row.id, bot);
  db.prepare('UPDATE bots SET username=? WHERE id=?').run(bot.botInfo.username, row.id);
}
app.post('/hook/:id', (req, res, next) => {
  const b = bots.get(+req.params.id);
  if (!b) return res.sendStatus(404);
  return webhookCallback(b, 'express', { secretToken: hmac('hook' + req.params.id).slice(0, 32) })(req, res, next);
});

// ---------- Telegram initData ----------
function verifyInit(initData, token) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const sec = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    const h = crypto.createHmac('sha256', sec).update(str).digest('hex');
    if (h !== hash) return null;
    if (now() - Number(p.get('auth_date')) > 86400) return null;
    return JSON.parse(p.get('user'));
  } catch (e) { return null; }
}
function auth(req, res, next) {
  const bid = +req.headers['x-bot'] || 1;
  const row = db.prepare('SELECT token FROM bots WHERE id=? AND active=1').get(bid);
  const u = row && verifyInit(req.headers['x-init'] || '', row.token);
  if (!u) return res.status(401).json({ error: 'auth' });
  const usr = upsertUser(u);
  if (usr.blocked) return res.status(403).json({ error: 'blocked' });
  req.uid = u.id;
  next();
}
const owned = (uid, m) => !m.price || !!db.prepare("SELECT 1 FROM purchases WHERE user_id=? AND movie_id=? AND status='approved'").get(uid, m.id);
const MCOLS = 'm.id,m.title,m.year,m.type,m.poster,m.price,c.name AS cat';
const FROMM = 'FROM movies m LEFT JOIN categories c ON c.id=m.category_id';

// ---------- Mini App API ----------
app.get('/health', (req, res) => res.send('ok'));
app.get('/api/live-token', auth, (req, res) => {
  const exp = now() + 6 * 3600;
  res.json({ t: `${req.uid}.${exp}.${hmac(`live.${req.uid}.${exp}`)}` });
});
app.get('/api/home', auth, ah(async (req, res) => {
  const missing = await missingChannels(req.uid);
  if (missing.length) return res.json({ missing });
  if (getSetting('phone_required', '1') === '1') {
    const me = db.prepare('SELECT phone FROM users WHERE tg_id=?').get(req.uid);
    if (!me || !me.phone) return res.json({ missing: [], needPhone: true });
  }
  const { q, cat } = req.query;
  let sql = `SELECT ${MCOLS} ${FROMM} WHERE 1=1`;
  const a = [];
  if (q) { sql += ' AND m.title LIKE ?'; a.push(`%${q}%`); }
  if (cat) { sql += ' AND m.category_id=?'; a.push(cat); }
  sql += ' ORDER BY m.id DESC LIMIT 200';
  const out = { missing: [], categories: db.prepare('SELECT * FROM categories ORDER BY sort,id').all(), movies: db.prepare(sql).all(...a) };
  if (!q && !cat) {
    out.banners = db.prepare("SELECT id,file,kind,link,place FROM banners WHERE active=1 ORDER BY id DESC").all();
    if (out.banners.length) db.prepare("UPDATE banners SET views=views+1 WHERE active=1 AND place IN ('top','inline')").run();
    out.hero = db.prepare(`SELECT ${MCOLS}, m.description ${FROMM} WHERE m.poster IS NOT NULL AND EXISTS (SELECT 1 FROM episodes e WHERE e.movie_id=m.id) ORDER BY m.featured DESC, m.id DESC LIMIT 1`).get() || null;
    out.top = db.prepare(`SELECT ${MCOLS} ${FROMM} ORDER BY m.views DESC, m.id DESC LIMIT 10`).all();
    out.cont = db.prepare(`SELECT ${MCOLS}, p.episode_id, p.pos, p.dur FROM progress p JOIN movies m ON m.id=p.movie_id LEFT JOIN categories c ON c.id=m.category_id WHERE p.user_id=? AND p.dur>0 AND p.pos>20 AND p.pos/p.dur<0.95 ORDER BY p.updated_at DESC LIMIT 12`).all(req.uid);
  }
  res.json(out);
}));
app.get('/api/movie/:id', auth, (req, res) => {
  const m = db.prepare('SELECT m.*,c.name cat FROM movies m LEFT JOIN categories c ON c.id=m.category_id WHERE m.id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  const ok = owned(req.uid, m);
  db.prepare('UPDATE movies SET views=views+1 WHERE id=?').run(m.id);
  const ad = db.prepare("SELECT id,file,kind,link,place FROM banners WHERE active=1 AND place='detail' ORDER BY RANDOM() LIMIT 1").get() || null;
  if (ad) db.prepare('UPDATE banners SET views=views+1 WHERE id=?').run(ad.id);
  const prog = {};
  db.prepare('SELECT episode_id,pos,dur FROM progress WHERE user_id=? AND movie_id=?').all(req.uid, m.id).forEach(p => { prog[p.episode_id] = { pos: p.pos, dur: p.dur }; });
  const bot = db.prepare('SELECT username FROM bots WHERE id=?').get(+req.headers['x-bot'] || 1);
  res.json({
    movie: m, owned: ok,
    pending: !!db.prepare("SELECT 1 FROM purchases WHERE user_id=? AND movie_id=? AND status='pending'").get(req.uid, m.id),
    episodes: db.prepare('SELECT id,number FROM episodes WHERE movie_id=? ORDER BY number').all(m.id),
    prog,
    related: m.category_id ? db.prepare(`SELECT ${MCOLS} ${FROMM} WHERE m.category_id=? AND m.id<>? ORDER BY m.views DESC LIMIT 10`).all(m.category_id, m.id) : [],
    fav: !!db.prepare('SELECT 1 FROM favs WHERE user_id=? AND movie_id=?').get(req.uid, m.id),
    bot: bot ? bot.username : '',
    ad,
    pay: ok ? [] : db.prepare('SELECT * FROM pay_methods').all()
  });
});
app.post('/api/fav/:id', auth, (req, res) => {
  const has = db.prepare('SELECT 1 FROM favs WHERE user_id=? AND movie_id=?').get(req.uid, req.params.id);
  if (has) db.prepare('DELETE FROM favs WHERE user_id=? AND movie_id=?').run(req.uid, req.params.id);
  else db.prepare('INSERT INTO favs(user_id,movie_id) VALUES(?,?)').run(req.uid, req.params.id);
  res.json({ fav: !has });
});
app.post('/api/banner/:id/click', auth, (req, res) => {
  db.prepare('UPDATE banners SET clicks=clicks+1 WHERE id=?').run(req.params.id);
  res.json({ ok: 1 });
});
app.get('/api/favs', auth, (req, res) => {
  res.json(db.prepare(`SELECT ${MCOLS} FROM favs f JOIN movies m ON m.id=f.movie_id LEFT JOIN categories c ON c.id=m.category_id WHERE f.user_id=? ORDER BY m.id DESC`).all(req.uid));
});
app.get('/api/profile', auth, (req, res) => {
  res.json({
    user: db.prepare('SELECT name,username,phone,created_at FROM users WHERE tg_id=?').get(req.uid),
    bought: db.prepare(`SELECT ${MCOLS}, p.status st FROM purchases p JOIN movies m ON m.id=p.movie_id LEFT JOIN categories c ON c.id=m.category_id WHERE p.user_id=? ORDER BY p.id DESC LIMIT 50`).all(req.uid),
    watched: db.prepare('SELECT COUNT(DISTINCT movie_id) n FROM progress WHERE user_id=?').get(req.uid).n,
    favs: db.prepare('SELECT COUNT(*) n FROM favs WHERE user_id=?').get(req.uid).n
  });
});
app.get('/api/downloads', auth, (req, res) => {
  const list = db.prepare(`SELECT ${MCOLS} ${FROMM} WHERE m.allow_download=1 AND (m.price=0 OR EXISTS (SELECT 1 FROM purchases p WHERE p.user_id=? AND p.movie_id=m.id AND p.status='approved')) ORDER BY m.id DESC LIMIT 100`).all(req.uid);
  const eps = db.prepare('SELECT id,number,file,size FROM episodes WHERE movie_id=? ORDER BY number');
  list.forEach(m => {
    m.eps = eps.all(m.id).map(e => {
      let size = e.size || 0;
      if (!size && !isS3(e.file)) { try { size = fs.statSync(path.join(PRIV, path.basename(e.file))).size; } catch (x) {} }
      return { id: e.id, number: e.number, size };
    });
  });
  res.json(list.filter(m => m.eps.length));
});
app.post('/api/progress', auth, (req, res) => {
  const { ep, pos, dur } = req.body || {};
  const e = db.prepare('SELECT movie_id FROM episodes WHERE id=?').get(+ep);
  if (!e) return res.sendStatus(404);
  db.prepare('INSERT INTO progress(user_id,episode_id,movie_id,pos,dur,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,episode_id) DO UPDATE SET pos=excluded.pos,dur=excluded.dur,updated_at=excluded.updated_at')
    .run(req.uid, +ep, e.movie_id, +pos || 0, +dur || 0, now());
  res.json({ ok: 1 });
});
app.get('/api/play/:id', auth, ah(async (req, res) => {
  const e = db.prepare('SELECT e.*,m.price,m.allow_download,m.title FROM episodes e JOIN movies m ON m.id=e.movie_id WHERE e.id=?').get(req.params.id);
  if (!e) return res.sendStatus(404);
  if (!owned(req.uid, { id: e.movie_id, price: e.price })) return res.status(402).json({ error: 'pay' });
  const next = db.prepare('SELECT id FROM episodes WHERE movie_id=? AND number>? ORDER BY number LIMIT 1').get(e.movie_id, e.number);
  const pr = db.prepare('SELECT pos FROM progress WHERE user_id=? AND episode_id=?').get(req.uid, e.id);
  let url, dl = null;
  if (isS3(e.file)) {
    const key = e.file.slice(3);
    url = await st.signedGet(key);
    if (e.allow_download) dl = await st.signedGet(key, { filename: `${e.title}-${e.number}${path.extname(key)}`.replace(/[^\w.\-]+/g, '_') });
  } else {
    const exp = now() + 6 * 3600;
    const t = `${req.uid}.${exp}.${hmac(`${e.id}.${req.uid}.${exp}`)}`;
    url = `/stream/${e.id}?t=${t}`;
    dl = e.allow_download ? `${url}&dl=1` : null;
  }
  const pos = pr ? pr.pos : 0;
  const introOn = getSetting('intro_on', '1') === '1' && pos < 5 && !req.query.noi && fs.existsSync(path.join(__dirname, 'public', 'intro.mp4'));
  res.json({ url, dl, title: e.title, number: e.number, next: next ? next.id : null, pos, intro: introOn ? '/intro.mp4' : null });
}));
app.get('/stream/:id', (req, res) => {
  const [uid, exp, sig] = String(req.query.t || '').split('.');
  if (!sig || +exp < now() || hmac(`${req.params.id}.${uid}.${exp}`) !== sig) return res.sendStatus(403);
  const e = db.prepare('SELECT e.*,m.title FROM episodes e JOIN movies m ON m.id=e.movie_id WHERE e.id=?').get(req.params.id);
  if (!e) return res.sendStatus(404);
  if (req.query.dl) res.attachment(`${e.title}-${e.number}${path.extname(e.file)}`.replace(/[^\w.\-]+/g, '_'));
  res.sendFile(path.join(PRIV, path.basename(e.file)));
});
app.post('/api/buy/:id', auth, upReceipt.single('receipt'), ah(async (req, res) => {
  const m = db.prepare('SELECT id,title FROM movies WHERE id=?').get(req.params.id);
  if (!m || !req.file) return res.status(400).json({ error: 'Chek rasmi kerak' });
  if (db.prepare("SELECT 1 FROM purchases WHERE user_id=? AND movie_id=? AND status='pending'").get(req.uid, m.id)) return res.status(400).json({ error: 'Allaqachon yuborilgan' });
  if (st.enabled && req.file.path) {
    try { await st.putFile('r/' + req.file.filename, req.file.path, req.file.mimetype || 'image/jpeg'); fs.unlink(req.file.path, () => {}); }
    catch (e) { console.error('S3 chek xato:', e.message); }
  }
  db.prepare('INSERT INTO purchases(user_id,movie_id,receipt,created_at) VALUES(?,?,?,?)').run(req.uid, m.id, req.file.filename, now());
  pushAdmin('pay', { title: m.title });
  res.json({ ok: 1 });
}));

// ---------- Admin panel ----------
const A = express.Router();
app.use('/' + AP, A);
A.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
const tries = new Map();
A.post('/api/login', (req, res) => {
  const t = tries.get(req.ip) || { n: 0, until: 0 };
  if (t.until > Date.now()) return res.status(429).json({ error: "Ko'p urinish. 15 daqiqa kuting" });
  const a = db.prepare('SELECT * FROM admins WHERE username=?').get(String(req.body.username || ''));
  let ok = false;
  if (a) ok = crypto.timingSafeEqual(Buffer.from(hashPw(String(req.body.password || ''), a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  if (!ok) {
    t.n++;
    if (t.n >= 5) { t.until = Date.now() + 15 * 60e3; t.n = 0; }
    tries.set(req.ip, t);
    return res.status(401).json({ error: "Login yoki parol noto'g'ri" });
  }
  tries.delete(req.ip);
  const exp = now() + 12 * 3600;
  res.cookie('adm', `${a.id}.${exp}.${hmac('adm' + a.id + exp + a.hash)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600e3, path: '/' + AP });
  res.json({ ok: 1, role: a.role });
});
A.use('/api', (req, res, next) => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)adm=([^;]+)/);
  if (m) {
    const [id, exp, sig] = m[1].split('.');
    const a = db.prepare('SELECT id,username,hash,role FROM admins WHERE id=?').get(+id);
    if (a && +exp > now() && sig === hmac('adm' + a.id + exp + a.hash)) {
      req.admin = a;
      if (req.method !== 'GET') res.on('finish', () => {
        if (res.statusCode >= 300) return;
        scheduleBackup();
        if (SYNC.test(String(req.originalUrl).split('?')[0])) scheduleSync();
      });
      return next();
    }
  }
  res.status(401).json({ error: 'auth' });
});
const sup = (req, res, next) => (req.admin.role === 'super' ? next() : res.status(403).json({ error: 'Faqat bosh admin uchun' }));

A.get('/api/me', (req, res) => res.json({ username: req.admin.username, role: req.admin.role, persistent: PERSIST, s3: st.enabled }));
A.get('/api/live', (req, res) => {
  openSse(req, res);
  adminLive.add(res);
  req.on('close', () => adminLive.delete(res));
});
A.get('/api/stats', (req, res) => {
  const q = s => db.prepare(s).get().n;
  res.json({
    users: q('SELECT COUNT(*) n FROM users'),
    online: db.prepare('SELECT COUNT(*) n FROM users WHERE last_seen>?').get(now() - 300).n,
    today: db.prepare('SELECT COUNT(*) n FROM users WHERE created_at>?').get(now() - 86400).n,
    blocked: q('SELECT COUNT(*) n FROM users WHERE blocked=1'),
    movies: q('SELECT COUNT(*) n FROM movies'),
    pending: q("SELECT COUNT(*) n FROM purchases WHERE status='pending'"),
    views: q('SELECT COALESCE(SUM(views),0) n FROM movies'),
    live: live.size,
    persistent: PERSIST
  });
});
// hisob
A.post('/api/account', (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id);
  const { current, username, password } = req.body;
  if (hashPw(String(current || ''), a.salt) !== a.hash) return res.status(400).json({ error: 'Joriy parol xato' });
  if (String(password || '').length < 8) return res.status(400).json({ error: "Parol kamida 8 belgi bo'lsin" });
  const un = String(username || a.username).trim();
  if (db.prepare('SELECT 1 FROM admins WHERE username=? AND id<>?').get(un, a.id)) return res.status(400).json({ error: 'Bu login band' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET username=?,salt=?,hash=? WHERE id=?').run(un, salt, hashPw(password, salt), a.id);
  res.clearCookie('adm', { path: '/' + AP });
  res.json({ ok: 1 });
});
// yordamchi adminlar
A.get('/api/admins', sup, (req, res) => res.json(db.prepare('SELECT id,username,role FROM admins ORDER BY id').all()));
A.post('/api/admins', sup, (req, res) => {
  const un = String(req.body.username || '').trim(), pw = String(req.body.password || '');
  if (un.length < 3) return res.status(400).json({ error: 'Login kamida 3 belgi' });
  if (pw.length < 8) return res.status(400).json({ error: 'Parol kamida 8 belgi' });
  if (db.prepare('SELECT 1 FROM admins WHERE username=?').get(un)) return res.status(400).json({ error: 'Bu login band' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO admins(username,salt,hash,role) VALUES(?,?,?,'helper')").run(un, salt, hashPw(pw, salt));
  res.json({ ok: 1 });
});
A.put('/api/admins/:id', sup, (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Parol kamida 8 belgi' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET salt=?,hash=? WHERE id=? AND id<>1').run(salt, hashPw(pw, salt), req.params.id);
  res.json({ ok: 1 });
});
A.delete('/api/admins/:id', sup, (req, res) => {
  if (+req.params.id === 1 || +req.params.id === req.admin.id) return res.status(400).json({ error: "Bosh adminni o'chirib bo'lmaydi" });
  db.prepare('DELETE FROM admins WHERE id=?').run(req.params.id);
  res.json({ ok: 1 });
});
// sozlamalar
A.get('/api/settings', sup, (req, res) => res.json({ sub_required: getSetting('sub_required', '0'), phone_required: getSetting('phone_required', '1'), intro_on: getSetting('intro_on', '1') }));
A.post('/api/settings', sup, (req, res) => {
  ['sub_required', 'phone_required', 'intro_on'].forEach(k => { if (req.body[k] !== undefined) setSetting(k, req.body[k] ? '1' : '0'); });
  subCache.clear();
  res.json({ ok: 1 });
});
// kategoriyalar
A.get('/api/categories', (req, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort,id').all()));
A.post('/api/categories', (req, res) => {
  try { db.prepare('INSERT INTO categories(name) VALUES(?)').run(String(req.body.name).trim()); res.json({ ok: 1 }); }
  catch (e) { res.status(400).json({ error: 'Bunday kategoriya bor yoki xato' }); }
});
A.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id);
  db.prepare('UPDATE movies SET category_id=NULL WHERE category_id=?').run(req.params.id);
  res.json({ ok: 1 });
});
// kinolar
A.get('/api/movies', (req, res) => res.json(db.prepare('SELECT m.*,c.name cat,(SELECT COUNT(*) FROM episodes WHERE movie_id=m.id) eps FROM movies m LEFT JOIN categories c ON c.id=m.category_id ORDER BY m.id DESC').all()));
const mf = upAdmin.fields([{ name: 'poster', maxCount: 1 }, { name: 'video', maxCount: 1 }]);
A.post('/api/movies', mf, ah(async (req, res) => {
  const b = req.body, f = req.files || {};
  if (!b.title) return res.status(400).json({ error: 'Nomi kerak' });
  const poster = f.poster ? await persistImage(await optimizeImage(f.poster[0].filename, 600)) : null;
  const id = db.prepare('INSERT INTO movies(title,year,category_id,type,description,poster,price,allow_download,created_at,featured) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(b.title, +b.year || null, +b.category_id || null, b.type === 'series' ? 'series' : 'movie', b.description || '', poster, +b.price || 0, b.allow_download === '0' ? 0 : 1, now(), b.featured === '1' ? 1 : 0).lastInsertRowid;
  if (f.video) {
    const e = db.prepare('INSERT INTO episodes(movie_id,number,file) VALUES(?,?,?)').run(id, +b.number || 1, f.video[0].filename);
    burnWatermark(e.lastInsertRowid, f.video[0].filename);
    announce(id, b.notify === '1', true);
  }
  res.json({ ok: 1, id });
}));
A.put('/api/movies/:id', upAdmin.fields([{ name: 'poster', maxCount: 1 }]), ah(async (req, res) => {
  const b = req.body, m = db.prepare('SELECT * FROM movies WHERE id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  let poster = m.poster;
  if (req.files && req.files.poster) { rm(m.poster); poster = await persistImage(await optimizeImage(req.files.poster[0].filename, 600)); }
  db.prepare('UPDATE movies SET title=?,year=?,category_id=?,description=?,price=?,allow_download=?,poster=?,featured=? WHERE id=?')
    .run(b.title ?? m.title, +b.year || m.year, b.category_id === undefined ? m.category_id : (+b.category_id || null),
      b.description ?? m.description, b.price === undefined ? m.price : +b.price,
      b.allow_download === undefined ? m.allow_download : +b.allow_download, poster, b.featured === undefined ? m.featured : +b.featured, m.id);
  res.json({ ok: 1 });
}));
A.delete('/api/movies/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  rm(m.poster);
  db.prepare('SELECT file FROM episodes WHERE movie_id=?').all(m.id).forEach(e => rmEp(e.file));
  db.prepare('DELETE FROM episodes WHERE movie_id=?').run(m.id);
  db.prepare('DELETE FROM progress WHERE movie_id=?').run(m.id);
  db.prepare('DELETE FROM favs WHERE movie_id=?').run(m.id);
  db.prepare('DELETE FROM movies WHERE id=?').run(m.id);
  res.json({ ok: 1 });
});
A.get('/api/movies/:id/episodes', (req, res) => res.json(db.prepare('SELECT id,number FROM episodes WHERE movie_id=? ORDER BY number').all(req.params.id)));
A.delete('/api/episodes/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM episodes WHERE id=?').get(req.params.id);
  if (!e) return res.sendStatus(404);
  rmEp(e.file);
  db.prepare('DELETE FROM progress WHERE episode_id=?').run(e.id);
  db.prepare('DELETE FROM episodes WHERE id=?').run(e.id);
  res.json({ ok: 1 });
});
A.post('/api/movies/:id/episodes', upAdmin.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Video tanlang' });
  const e = db.prepare('INSERT INTO episodes(movie_id,number,file) VALUES(?,?,?)').run(req.params.id, +req.body.number || 1, req.file.filename);
  burnWatermark(e.lastInsertRowid, req.file.filename);
  res.json({ ok: 1 });
});
// bo'laklab tez yuklash
A.post('/api/chunk/:uid/:idx', express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  const dir = path.join(UP, 'tmp', String(req.params.uid).replace(/\W/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFile(path.join(dir, String(parseInt(req.params.idx, 10) || 0)), req.body, e => (e ? res.status(500).json({ error: 'Diskka yozilmadi' }) : res.json({ ok: 1 })));
});
A.post('/api/movies/:id/finish', async (req, res) => {
  const { uid, total, ext, number, first, notify } = req.body;
  const dir = path.join(UP, 'tmp', String(uid).replace(/\W/g, ''));
  let e2 = String(ext || '.mp4').toLowerCase();
  if (!/^\.[a-z0-9]{1,6}$/.test(e2)) e2 = '.mp4';
  const name = crypto.randomBytes(12).toString('hex') + e2;
  try {
    const ws = fs.createWriteStream(path.join(PRIV, name));
    for (let i = 0; i < +total; i++) {
      await new Promise((ok, no) => {
        const rs = fs.createReadStream(path.join(dir, String(i)));
        rs.on('error', no);
        rs.on('end', ok);
        rs.pipe(ws, { end: false });
      });
    }
    await new Promise(ok => ws.end(ok));
    fs.rm(dir, { recursive: true, force: true }, () => {});
    const e = db.prepare('INSERT INTO episodes(movie_id,number,file) VALUES(?,?,?)').run(req.params.id, +number || 1, name);
    burnWatermark(e.lastInsertRowid, name);
    if (first) announce(+req.params.id, !!notify, true);
    res.json({ ok: 1 });
  } catch (err) { res.status(500).json({ error: 'Birlashtirishda xato' }); }
});
// S3 ga to'g'ridan-to'g'ri tez yuklash
A.post('/api/s3/init', ah(async (req, res) => {
  if (!st.enabled) return res.status(400).json({ error: 'S3 sozlanmagan' });
  const size = +req.body.size || 0;
  let ext = String(req.body.ext || '.mp4').toLowerCase();
  if (!/^\.[a-z0-9]{1,6}$/.test(ext)) ext = '.mp4';
  const partSize = 16 * 1024 * 1024, n = Math.max(1, Math.ceil(size / partSize));
  if (n > 9000) return res.status(400).json({ error: 'Fayl juda katta' });
  const key = 'v/' + crypto.randomBytes(12).toString('hex') + ext;
  const uploadId = await st.mpInit(key, req.body.type || 'video/mp4');
  const urls = await Promise.all(Array.from({ length: n }, (_, i) => st.partUrl(key, uploadId, i + 1)));
  res.json({ key, uploadId, partSize, urls });
}));
A.post('/api/s3/complete', ah(async (req, res) => {
  const { key, uploadId, parts, movieId, number, size, first, notify } = req.body;
  if (!st.enabled || !/^v\/[a-f0-9]{24}\.[a-z0-9]{1,6}$/.test(String(key))) return res.status(400).json({ error: 'Xato' });
  await st.mpComplete(key, uploadId, (parts || []).map(p => ({ PartNumber: +p.n, ETag: p.etag })));
  db.prepare('INSERT INTO episodes(movie_id,number,file,size) VALUES(?,?,?,?)').run(movieId, +number || 1, 's3:' + key, +size || 0);
  if (first) announce(+movieId, !!notify, true);
  res.json({ ok: 1 });
}));
A.post('/api/s3/abort', ah(async (req, res) => {
  try { await st.mpAbort(req.body.key, req.body.uploadId); } catch (e) {}
  res.json({ ok: 1 });
}));
// to'lovlar
A.get('/api/purchases', (req, res) => res.json(db.prepare("SELECT p.*,m.title,u.name,u.username FROM purchases p JOIN movies m ON m.id=p.movie_id LEFT JOIN users u ON u.tg_id=p.user_id WHERE p.status='pending' ORDER BY p.id DESC").all()));
A.get('/api/receipt/:id', ah(async (req, res) => {
  const p = db.prepare('SELECT receipt FROM purchases WHERE id=?').get(req.params.id);
  if (!p) return res.sendStatus(404);
  const f = path.join(PRIV, path.basename(p.receipt));
  if (fs.existsSync(f)) return res.sendFile(f);
  if (st.enabled) return proxyS3(req, res, 'r/' + path.basename(p.receipt), 'image/jpeg', 'private, max-age=3600');
  res.sendStatus(404);
}));
A.post('/api/purchases/:id/:act', ah(async (req, res) => {
  const p = db.prepare('SELECT p.*,m.title FROM purchases p JOIN movies m ON m.id=p.movie_id WHERE p.id=?').get(req.params.id);
  if (!p) return res.sendStatus(404);
  const ok = req.params.act === 'approve';
  db.prepare('UPDATE purchases SET status=? WHERE id=?').run(ok ? 'approved' : 'rejected', p.id);
  pushUser(p.user_id, 'paid', { movie: p.movie_id, ok, title: p.title });
  try {
    await mainBot().api.sendMessage(p.user_id, ok ? `✅ To'lov tasdiqlandi! «${p.title}» endi ochiq. Mini ilovadan tomosha qiling.` : `❌ «${p.title}» uchun to'lov tasdiqlanmadi. Chekni qayta yuboring.`);
  } catch (e) {}
  res.json({ ok: 1 });
}));
A.get('/api/paymethods', (req, res) => res.json(db.prepare('SELECT * FROM pay_methods').all()));
A.post('/api/paymethods', sup, (req, res) => {
  const b = req.body;
  db.prepare('INSERT INTO pay_methods(name,card,holder,note) VALUES(?,?,?,?)').run(b.name, b.card, b.holder || '', b.note || '');
  res.json({ ok: 1 });
});
A.delete('/api/paymethods/:id', sup, (req, res) => { db.prepare('DELETE FROM pay_methods WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
// foydalanuvchilar
A.get('/api/users', sup, (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.prepare('SELECT * FROM users WHERE name LIKE ? OR username LIKE ? OR phone LIKE ? OR CAST(tg_id AS TEXT) LIKE ? ORDER BY created_at DESC LIMIT 300').all(q, q, q, q));
});
A.post('/api/users/:id/block', sup, (req, res) => {
  db.prepare('UPDATE users SET blocked=? WHERE tg_id=?').run(req.body.blocked ? 1 : 0, req.params.id);
  res.json({ ok: 1 });
});
// majburiy obuna
A.get('/api/channels', sup, (req, res) => res.json(db.prepare('SELECT * FROM channels').all()));
A.post('/api/channels', sup, (req, res) => {
  const b = req.body;
  if (!b.chat) return res.status(400).json({ error: 'Kanal @username yoki ID kerak' });
  const link = b.link || (String(b.chat).startsWith('@') ? `https://t.me/${b.chat.slice(1)}` : '');
  db.prepare('INSERT INTO channels(chat,title,link) VALUES(?,?,?)').run(b.chat, b.title || b.chat, link);
  subCache.clear();
  res.json({ ok: 1 });
});
A.delete('/api/channels/:id', sup, (req, res) => { db.prepare('DELETE FROM channels WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
// reklama
A.get('/api/banners', (req, res) => res.json(db.prepare('SELECT * FROM banners ORDER BY id DESC').all()));
A.post('/api/banners', upAdmin.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fayl tanlang' });
  const isVideo = req.file.mimetype.startsWith('video');
  const file = isVideo ? req.file.filename : await optimizeImage(req.file.filename, 1200);
  await persistImage(file, isVideo ? 'video/mp4' : null);
  const place = ['top', 'inline', 'detail'].includes(req.body.place) ? req.body.place : 'top';
  db.prepare('INSERT INTO banners(file,kind,link,place) VALUES(?,?,?,?)').run(file, isVideo ? 'video' : 'image', req.body.link || '', place);
  res.json({ ok: 1 });
}));
A.post('/api/banners/:id/toggle', (req, res) => { db.prepare('UPDATE banners SET active=1-active WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
A.delete('/api/banners/:id', (req, res) => {
  const b = db.prepare('SELECT file FROM banners WHERE id=?').get(req.params.id);
  if (b) rm(b.file);
  db.prepare('DELETE FROM banners WHERE id=?').run(req.params.id);
  res.json({ ok: 1 });
});
// xabar yuborish
A.post('/api/broadcast', sup, (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Matn yozing' });
  const total = db.prepare('SELECT COUNT(*) n FROM users WHERE blocked=0').get().n;
  broadcast({ html: escHtml(text), movieId: +req.body.movieId || null }).then(r => pushAdmin('broadcast', r)).catch(() => {});
  res.json({ ok: 1, total });
});
// botlar
A.get('/api/bots', sup, (req, res) => res.json(db.prepare('SELECT id,username,welcome,button,active FROM bots').all()));
A.post('/api/bots', sup, ah(async (req, res) => {
  const token = String(req.body.token || '').trim();
  try {
    await new Bot(token).init();
    const r = db.prepare('INSERT INTO bots(token,welcome,button) VALUES(?,?,?)').run(token, '<b>VITRINO TV</b> ga xush kelibsiz!', 'Kinolarni ochish');
    await startBot(db.prepare('SELECT * FROM bots WHERE id=?').get(r.lastInsertRowid));
    res.json({ ok: 1 });
  } catch (e) { res.status(400).json({ error: "Token xato yoki bot allaqachon qo'shilgan" }); }
}));
A.put('/api/bots/:id', sup, ah(async (req, res) => {
  const id = +req.params.id, b = req.body;
  const row = db.prepare('SELECT * FROM bots WHERE id=?').get(id);
  if (!row) return res.sendStatus(404);
  db.prepare('UPDATE bots SET welcome=?,button=?,active=? WHERE id=?').run(b.welcome ?? row.welcome, b.button ?? row.button, b.active === undefined ? row.active : (b.active ? 1 : 0), id);
  const fresh = db.prepare('SELECT * FROM bots WHERE id=?').get(id);
  try {
    if (fresh.active && !bots.has(id)) await startBot(fresh);
    if (!fresh.active && bots.has(id)) { await bots.get(id).api.deleteWebhook(); bots.delete(id); }
  } catch (e) {}
  res.json({ ok: 1 });
}));
A.delete('/api/bots/:id', sup, ah(async (req, res) => {
  const id = +req.params.id;
  if (id === db.prepare('SELECT MIN(id) id FROM bots').get().id) return res.status(400).json({ error: "Asosiy botni o'chirib bo'lmaydi" });
  try { await bots.get(id).api.deleteWebhook(); } catch (e) {}
  bots.delete(id);
  db.prepare('DELETE FROM bots WHERE id=?').run(id);
  res.json({ ok: 1 });
}));

// ---------- statik ----------
app.get('/files/:name', ah(async (req, res) => {
  const name = path.basename(req.params.name), local = path.join(UP, name);
  try { if (fs.statSync(local).isFile()) return res.sendFile(local, { maxAge: '30d', immutable: true }); } catch (e) {}
  if (!st.enabled) return res.sendStatus(404);
  if (process.env.S3_PUBLIC_URL) {
    res.set('Cache-Control', 'public, max-age=86400');
    return res.redirect(302, `${process.env.S3_PUBLIC_URL.replace(/\/$/, '')}/img/${encodeURIComponent(name)}`);
  }
  try { await proxyS3(req, res, 'img/' + name); } catch (e) { if (!res.headersSent) res.sendStatus(404); }
}));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { res.setHeader('Cache-Control', p.endsWith('.html') ? 'no-cache' : 'public, max-age=86400'); }
}));
app.use((err, req, res, next) => { console.error(err.message); res.status(500).json({ error: err.message }); });

(async () => {
  const t = process.env.BOT_TOKEN;
  if (t) db.prepare('INSERT OR IGNORE INTO bots(token,welcome,button) VALUES(?,?,?)').run(t, '<b>VITRINO TV</b> ga xush kelibsiz!\n\nBir joyda - barcha media.', 'Kinolarni ochish');
  for (const r of db.prepare('SELECT * FROM bots WHERE active=1').all()) {
    try { await startBot(r); } catch (e) { console.error('Bot ishga tushmadi', r.id, e.message); }
  }
  app.listen(PORT, () => console.log(`VITRINO TV: port ${PORT} | panel: ${BASE}/${AP} | saqlash: ${st.enabled ? 'S3' : PERSIST ? 'disk' : 'DOIMIY EMAS'}`));
  if (st.enabled) {
    setInterval(() => runBackup(false), 30000);
    ['SIGTERM', 'SIGINT'].forEach(sg => process.on(sg, async () => { await runBackup(true); process.exit(0); }));
  }
  if (BASE && process.env.RENDER && process.env.KEEP_AWAKE !== '0') setInterval(() => { fetch(BASE + '/health').catch(() => {}); }, 9 * 60 * 1000);
})();
