require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { Bot, InlineKeyboard, webhookCallback } = require('grammy');
const { db, DATA } = require('./db');

const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const AP = (process.env.ADMIN_PATH || 'panel').replace(/[^\w-]/g, '');
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
const PORT = process.env.PORT || 3000;
const now = () => Math.floor(Date.now() / 1000);
const hmac = d => crypto.createHmac('sha256', SECRET).update(String(d)).digest('hex');
const hashPw = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');
const UP = path.join(DATA, 'uploads');
const PRIV = path.join(UP, 'private');
const rm = (f, priv) => { if (f) fs.unlink(path.join(priv ? PRIV : UP, path.basename(f)), () => {}); };

if (!db.prepare('SELECT 1 FROM admins').get()) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admins(id,username,salt,hash) VALUES(1,?,?,?)')
    .run(process.env.ADMIN_USER || 'admin', salt, hashPw(process.env.ADMIN_PASS || 'admin12345', salt));
  if (!process.env.ADMIN_PASS) console.warn('ADMIN_PASS berilmagan! Panelda parolni darhol almashtiring.');
}
if (process.env.RESET_ADMIN === '1' && process.env.ADMIN_USER && process.env.ADMIN_PASS) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET username=?,salt=?,hash=? WHERE id=1').run(process.env.ADMIN_USER, salt, hashPw(process.env.ADMIN_PASS, salt));
  console.log('Admin login va parol tiklandi. RESET_ADMIN ni olib tashlang!');
}
if (!db.prepare('SELECT 1 FROM categories').get())
  ['Kinolar', 'Seriallar', 'Komediya', 'Jangari', 'Multfilmlar'].forEach(n => db.prepare('INSERT INTO categories(name) VALUES(?)').run(n));

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex'); next(); });

const storage = multer.diskStorage({
  destination: (req, f, cb) => cb(null, ['video', 'receipt'].includes(f.fieldname) ? PRIV : UP),
  filename: (req, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase())
});
const upAdmin = multer({ storage, limits: { fileSize: 5 * 1024 ** 3 } });
const upReceipt = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: (r, f, cb) => cb(null, /^image\//.test(f.mimetype)) });

const bots = new Map();
const mainBot = () => bots.get(db.prepare('SELECT MIN(id) id FROM bots').get().id);

async function startBot(row) {
  const bot = new Bot(row.token);
  bot.command('start', async ctx => {
    const u = db.prepare('SELECT blocked FROM users WHERE tg_id=?').get(ctx.from.id);
    if (u && u.blocked) return;
    const r = db.prepare('SELECT * FROM bots WHERE id=?').get(row.id);
    const kb = new InlineKeyboard().webApp(r.button || 'Ochish', `${BASE}/?b=${row.id}`);
    await ctx.reply(r.welcome || 'VITRINO TV ga xush kelibsiz!', { reply_markup: kb, parse_mode: 'HTML' });
  });
  await bot.init();
  await bot.api.setWebhook(`${BASE}/hook/${row.id}`, { secret_token: hmac('hook' + row.id).slice(0, 32) });
  try {
    await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Kinolar', web_app: { url: `${BASE}/?b=${row.id}` } } });
  } catch (e) {}
  bots.set(row.id, bot);
  db.prepare('UPDATE bots SET username=? WHERE id=?').run(bot.botInfo.username, row.id);
}
app.post('/hook/:id', (req, res, next) => {
  const b = bots.get(+req.params.id);
  if (!b) return res.sendStatus(404);
  return webhookCallback(b, 'express', { secretToken: hmac('hook' + req.params.id).slice(0, 32) })(req, res, next);
});

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
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  let usr = db.prepare('SELECT * FROM users WHERE tg_id=?').get(u.id);
  if (!usr) {
    db.prepare('INSERT INTO users(tg_id,name,username,created_at,last_seen) VALUES(?,?,?,?,?)').run(u.id, name, u.username || '', now(), now());
    usr = { blocked: 0 };
  } else db.prepare('UPDATE users SET last_seen=?,name=?,username=? WHERE tg_id=?').run(now(), name, u.username || '', u.id);
  if (usr.blocked) return res.status(403).json({ error: 'blocked' });
  req.uid = u.id;
  next();
}
async function missingChannels(uid) {
  const chs = db.prepare('SELECT * FROM channels').all();
  if (!chs.length) return [];
  const main = mainBot();
  const miss = [];
  for (const c of chs) {
    try {
      const m = await main.api.getChatMember(c.chat, uid);
      if (['left', 'kicked'].includes(m.status)) miss.push(c);
    } catch (e) { /* bot kanalda admin emas - otkazib yuboramiz */ }
  }
  return miss;
}
const owned = (uid, m) => m.price === 0 || !!db.prepare("SELECT 1 FROM purchases WHERE user_id=? AND movie_id=? AND status='approved'").get(uid, m.id);

const clients = new Set();
app.get('/live', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
const push = (t, d) => clients.forEach(c => c.write(`event: ${t}\ndata: ${JSON.stringify(d)}\n\n`));
setInterval(() => push('online', { n: clients.size }), 15000);

app.get('/health', (req, res) => res.send('ok'));
app.get('/api/home', auth, async (req, res) => {
  const missing = await missingChannels(req.uid);
  if (missing.length) return res.json({ missing });
  const { q, cat } = req.query;
  let sql = `SELECT m.id,m.title,m.year,m.type,m.poster,m.price,c.name AS cat FROM movies m LEFT JOIN categories c ON c.id=m.category_id WHERE 1=1`;
  const a = [];
  if (q) { sql += ' AND m.title LIKE ?'; a.push(`%${q}%`); }
  if (cat) { sql += ' AND m.category_id=?'; a.push(cat); }
  sql += ' ORDER BY m.id DESC LIMIT 200';
  res.json({
    missing: [],
    banners: db.prepare('SELECT id,file,kind,link FROM banners WHERE active=1 ORDER BY id DESC').all(),
    categories: db.prepare('SELECT * FROM categories ORDER BY sort,id').all(),
    movies: db.prepare(sql).all(...a)
  });
});
app.get('/api/movie/:id', auth, (req, res) => {
  const m = db.prepare('SELECT m.*,c.name cat FROM movies m LEFT JOIN categories c ON c.id=m.category_id WHERE m.id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  const ok = owned(req.uid, m);
  const pending = !!db.prepare("SELECT 1 FROM purchases WHERE user_id=? AND movie_id=? AND status='pending'").get(req.uid, m.id);
  db.prepare('UPDATE movies SET views=views+1 WHERE id=?').run(m.id);
  res.json({
    movie: m, owned: ok, pending,
    episodes: db.prepare('SELECT id,number FROM episodes WHERE movie_id=? ORDER BY number').all(m.id),
    pay: ok ? [] : db.prepare('SELECT * FROM pay_methods').all()
  });
});
app.get('/api/my', auth, (req, res) => {
  res.json(db.prepare(`SELECT m.id,m.title,m.year,m.type,m.poster,m.price,'' cat FROM purchases p JOIN movies m ON m.id=p.movie_id WHERE p.user_id=? AND p.status='approved' GROUP BY m.id ORDER BY MAX(p.id) DESC`).all(req.uid));
});
app.get('/api/play/:id', auth, (req, res) => {
  const e = db.prepare('SELECT e.*,m.price,m.allow_download FROM episodes e JOIN movies m ON m.id=e.movie_id WHERE e.id=?').get(req.params.id);
  if (!e) return res.sendStatus(404);
  if (!owned(req.uid, { id: e.movie_id, price: e.price })) return res.status(402).json({ error: 'pay' });
  const exp = now() + 4 * 3600;
  const t = `${req.uid}.${exp}.${hmac(`${e.id}.${req.uid}.${exp}`)}`;
  res.json({ url: `/stream/${e.id}?t=${t}`, dl: e.allow_download ? `/stream/${e.id}?t=${t}&dl=1` : null });
});
app.get('/stream/:id', (req, res) => {
  const [uid, exp, sig] = String(req.query.t || '').split('.');
  if (!sig || +exp < now() || hmac(`${req.params.id}.${uid}.${exp}`) !== sig) return res.sendStatus(403);
  const e = db.prepare('SELECT e.*,m.title FROM episodes e JOIN movies m ON m.id=e.movie_id WHERE e.id=?').get(req.params.id);
  if (!e) return res.sendStatus(404);
  if (req.query.dl) res.attachment(`${e.title}-${e.number}${path.extname(e.file)}`.replace(/[^\w.\-]+/g, '_'));
  res.sendFile(path.join(PRIV, path.basename(e.file)));
});
app.post('/api/buy/:id', auth, upReceipt.single('receipt'), (req, res) => {
  const m = db.prepare('SELECT id FROM movies WHERE id=?').get(req.params.id);
  if (!m || !req.file) return res.status(400).json({ error: 'Chek rasmi kerak' });
  if (db.prepare("SELECT 1 FROM purchases WHERE user_id=? AND movie_id=? AND status='pending'").get(req.uid, m.id)) return res.status(400).json({ error: 'Allaqachon yuborilgan' });
  db.prepare('INSERT INTO purchases(user_id,movie_id,receipt,created_at) VALUES(?,?,?,?)').run(req.uid, m.id, req.file.filename, now());
  res.json({ ok: 1 });
});

const A = express.Router();
app.use('/' + AP, A);
A.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'admin.html')));
const tries = new Map();
A.post('/api/login', (req, res) => {
  const t = tries.get(req.ip) || { n: 0, until: 0 };
  if (t.until > Date.now()) return res.status(429).json({ error: "Kop urinish. 15 daqiqa kuting" });
  const a = db.prepare('SELECT * FROM admins WHERE id=1').get();
  const ok = req.body.username === a.username &&
    crypto.timingSafeEqual(Buffer.from(hashPw(String(req.body.password || ''), a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  if (!ok) {
    t.n++;
    if (t.n >= 5) { t.until = Date.now() + 15 * 60e3; t.n = 0; }
    tries.set(req.ip, t);
    return res.status(401).json({ error: "Login yoki parol notogri" });
  }
  tries.delete(req.ip);
  const exp = now() + 12 * 3600;
  res.cookie('adm', `${exp}.${hmac('adm' + exp + a.hash)}`, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 12 * 3600e3, path: '/' + AP });
  res.json({ ok: 1 });
});
A.use('/api', (req, res, next) => {
  const m = (req.headers.cookie || '').match(/adm=([^;]+)/);
  const a = db.prepare('SELECT hash FROM admins WHERE id=1').get();
  if (m) {
    const [exp, sig] = m[1].split('.');
    if (+exp > now() && sig === hmac('adm' + exp + a.hash)) return next();
  }
  res.status(401).json({ error: 'auth' });
});

A.get('/api/stats', (req, res) => {
  const q = s => db.prepare(s).get().n;
  res.json({
    users: q('SELECT COUNT(*) n FROM users'),
    online: db.prepare('SELECT COUNT(*) n FROM users WHERE last_seen>?').get(now() - 300).n,
    blocked: q('SELECT COUNT(*) n FROM users WHERE blocked=1'),
    movies: q('SELECT COUNT(*) n FROM movies'),
    pending: q("SELECT COUNT(*) n FROM purchases WHERE status='pending'"),
    views: q('SELECT COALESCE(SUM(views),0) n FROM movies'),
    live: clients.size
  });
});
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
A.get('/api/movies', (req, res) => res.json(db.prepare('SELECT m.*,c.name cat,(SELECT COUNT(*) FROM episodes WHERE movie_id=m.id) eps FROM movies m LEFT JOIN categories c ON c.id=m.category_id ORDER BY m.id DESC').all()));
const mf = upAdmin.fields([{ name: 'poster', maxCount: 1 }, { name: 'video', maxCount: 1 }]);
A.post('/api/movies', mf, (req, res) => {
  const b = req.body, f = req.files || {};
  if (!b.title) return res.status(400).json({ error: 'Nomi kerak' });
  const id = db.prepare('INSERT INTO movies(title,year,category_id,type,description,poster,price,allow_download,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(b.title, +b.year || null, +b.category_id || null, b.type === 'series' ? 'series' : 'movie', b.description || '',
      f.poster ? f.poster[0].filename : null, +b.price || 0, b.allow_download === '0' ? 0 : 1, now()).lastInsertRowid;
  if (f.video) db.prepare('INSERT INTO episodes(movie_id,number,file) VALUES(?,?,?)').run(id, +b.number || 1, f.video[0].filename);
  push('new', { id, title: b.title });
  res.json({ ok: 1, id });
});
A.put('/api/movies/:id', upAdmin.fields([{ name: 'poster', maxCount: 1 }]), (req, res) => {
  const b = req.body, m = db.prepare('SELECT * FROM movies WHERE id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  let poster = m.poster;
  if (req.files && req.files.poster) { rm(m.poster); poster = req.files.poster[0].filename; }
  db.prepare('UPDATE movies SET title=?,year=?,category_id=?,description=?,price=?,allow_download=?,poster=? WHERE id=?')
    .run(b.title ?? m.title, +b.year || m.year, b.category_id === undefined ? m.category_id : (+b.category_id || null),
      b.description ?? m.description, b.price === undefined ? m.price : +b.price,
      b.allow_download === undefined ? m.allow_download : +b.allow_download, poster, m.id);
  res.json({ ok: 1 });
});
A.delete('/api/movies/:id', (req, res) => {
  const m = db.prepare('SELECT * FROM movies WHERE id=?').get(req.params.id);
  if (!m) return res.sendStatus(404);
  rm(m.poster);
  db.prepare('SELECT file FROM episodes WHERE movie_id=?').all(m.id).forEach(e => rm(e.file, true));
  db.prepare('DELETE FROM episodes WHERE movie_id=?').run(m.id);
  db.prepare('DELETE FROM movies WHERE id=?').run(m.id);
  res.json({ ok: 1 });
});
A.post('/api/movies/:id/episodes', upAdmin.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Video tanlang' });
  db.prepare('INSERT INTO episodes(movie_id,number,file) VALUES(?,?,?)').run(req.params.id, +req.body.number || 1, req.file.filename);
  res.json({ ok: 1 });
});
A.get('/api/users', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.prepare('SELECT * FROM users WHERE name LIKE ? OR username LIKE ? OR CAST(tg_id AS TEXT) LIKE ? ORDER BY created_at DESC LIMIT 300').all(q, q, q));
});
A.post('/api/users/:id/block', (req, res) => {
  db.prepare('UPDATE users SET blocked=? WHERE tg_id=?').run(req.body.blocked ? 1 : 0, req.params.id);
  res.json({ ok: 1 });
});
A.get('/api/purchases', (req, res) => res.json(db.prepare("SELECT p.*,m.title,u.name,u.username FROM purchases p JOIN movies m ON m.id=p.movie_id LEFT JOIN users u ON u.tg_id=p.user_id WHERE p.status='pending' ORDER BY p.id DESC").all()));
A.get('/api/receipt/:id', (req, res) => {
  const p = db.prepare('SELECT receipt FROM purchases WHERE id=?').get(req.params.id);
  if (!p) return res.sendStatus(404);
  res.sendFile(path.join(PRIV, path.basename(p.receipt)));
});
A.post('/api/purchases/:id/:act', async (req, res) => {
  const p = db.prepare('SELECT p.*,m.title FROM purchases p JOIN movies m ON m.id=p.movie_id WHERE p.id=?').get(req.params.id);
  if (!p) return res.sendStatus(404);
  const ok = req.params.act === 'approve';
  db.prepare('UPDATE purchases SET status=? WHERE id=?').run(ok ? 'approved' : 'rejected', p.id);
  try {
    await mainBot().api.sendMessage(p.user_id, ok ? `Tolov tasdiqlandi! "${p.title}" endi ochiq. Mini ilovadan tomosha qiling.` : `"${p.title}" uchun tolov tasdiqlanmadi. Chekni qayta yuboring.`);
  } catch (e) {}
  res.json({ ok: 1 });
});
A.get('/api/paymethods', (req, res) => res.json(db.prepare('SELECT * FROM pay_methods').all()));
A.post('/api/paymethods', (req, res) => {
  const b = req.body;
  db.prepare('INSERT INTO pay_methods(name,card,holder,note) VALUES(?,?,?,?)').run(b.name, b.card, b.holder || '', b.note || '');
  res.json({ ok: 1 });
});
A.delete('/api/paymethods/:id', (req, res) => { db.prepare('DELETE FROM pay_methods WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
A.get('/api/channels', (req, res) => res.json(db.prepare('SELECT * FROM channels').all()));
A.post('/api/channels', (req, res) => {
  const b = req.body;
  if (!b.chat) return res.status(400).json({ error: 'Kanal @username yoki ID kerak' });
  const link = b.link || (String(b.chat).startsWith('@') ? `https://t.me/${b.chat.slice(1)}` : '');
  db.prepare('INSERT INTO channels(chat,title,link) VALUES(?,?,?)').run(b.chat, b.title || b.chat, link);
  res.json({ ok: 1 });
});
A.delete('/api/channels/:id', (req, res) => { db.prepare('DELETE FROM channels WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
A.get('/api/banners', (req, res) => res.json(db.prepare('SELECT * FROM banners ORDER BY id DESC').all()));
A.post('/api/banners', upAdmin.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fayl tanlang' });
  db.prepare('INSERT INTO banners(file,kind,link) VALUES(?,?,?)').run(req.file.filename, req.file.mimetype.startsWith('video') ? 'video' : 'image', req.body.link || '');
  res.json({ ok: 1 });
});
A.post('/api/banners/:id/toggle', (req, res) => { db.prepare('UPDATE banners SET active=1-active WHERE id=?').run(req.params.id); res.json({ ok: 1 }); });
A.delete('/api/banners/:id', (req, res) => {
  const b = db.prepare('SELECT file FROM banners WHERE id=?').get(req.params.id);
  if (b) rm(b.file);
  db.prepare('DELETE FROM banners WHERE id=?').run(req.params.id);
  res.json({ ok: 1 });
});
A.get('/api/bots', (req, res) => res.json(db.prepare('SELECT id,username,welcome,button,active FROM bots').all()));
A.post('/api/bots', async (req, res) => {
  const token = String(req.body.token || '').trim();
  try {
    const t = new Bot(token);
    await t.init();
    const r = db.prepare('INSERT INTO bots(token,welcome,button) VALUES(?,?,?)').run(token, '<b>VITRINO TV</b> ga xush kelibsiz!', 'Kinolarni ochish');
    await startBot(db.prepare('SELECT * FROM bots WHERE id=?').get(r.lastInsertRowid));
    res.json({ ok: 1 });
  } catch (e) { res.status(400).json({ error: "Token xato yoki bot allaqachon qoshilgan" }); }
});
A.put('/api/bots/:id', async (req, res) => {
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
});
A.delete('/api/bots/:id', async (req, res) => {
  const id = +req.params.id;
  if (id === db.prepare('SELECT MIN(id) id FROM bots').get().id) return res.status(400).json({ error: "Asosiy botni ochirib bolmaydi" });
  try { await bots.get(id).api.deleteWebhook(); } catch (e) {}
  bots.delete(id);
  db.prepare('DELETE FROM bots WHERE id=?').run(id);
  res.json({ ok: 1 });
});
A.post('/api/account', (req, res) => {
  const a = db.prepare('SELECT * FROM admins WHERE id=1').get();
  const { current, username, password } = req.body;
  if (hashPw(String(current || ''), a.salt) !== a.hash) return res.status(400).json({ error: 'Joriy parol xato' });
  if (String(password || '').length < 8) return res.status(400).json({ error: "Parol kamida 8 belgi bolsin" });
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admins SET username=?,salt=?,hash=? WHERE id=1').run(username || a.username, salt, hashPw(password, salt));
  res.clearCookie('adm', { path: '/' + AP });
  res.json({ ok: 1 });
});

app.use('/files', (req, res, next) => req.path.startsWith('/private') ? res.sendStatus(403) : next(), express.static(UP, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((err, req, res, next) => { console.error(err.message); res.status(500).json({ error: err.message }); });

(async () => {
  const t = process.env.BOT_TOKEN;
  if (t) db.prepare('INSERT OR IGNORE INTO bots(token,welcome,button) VALUES(?,?,?)').run(t, '<b>VITRINO TV</b> ga xush kelibsiz!\n\nBir joyda - barcha media.', 'Kinolarni ochish');
  for (const r of db.prepare('SELECT * FROM bots WHERE active=1').all()) {
    try { await startBot(r); } catch (e) { console.error('Bot ishga tushmadi', r.id, e.message); }
  }
  app.listen(PORT, () => console.log(`VITRINO TV: port ${PORT} | panel: ${BASE}/${AP}`));
})();
