import os

SRV = 'server.js'
ADM = 'views/admin.html' if os.path.exists('views/admin.html') else 'admin.html'

def sub(path, old, new):
    s = open(path, encoding='utf-8').read()
    if s.count(old) != 1:
        raise SystemExit('Topilmadi yoki takror: %s -> %s' % (path, old[:50]))
    open(path, 'w', encoding='utf-8').write(s.replace(old, new))

srv = open(SRV, encoding='utf-8').read()
if 'api/chunk' in srv:
    raise SystemExit('Allaqachon qo\'shilgan')

sub(SRV, "const PRIV = path.join(UP, 'private');",
"const PRIV = path.join(UP, 'private');\ntry { fs.rmSync(path.join(UP, 'tmp'), { recursive: true, force: true }); } catch (e) {}")

sub(SRV, "A.get('/api/users', (req, res) => {", """A.post('/api/chunk/:uid/:idx', express.raw({ type: 'application/octet-stream', limit: '20mb' }), (req, res) => {
  const dir = path.join(UP, 'tmp', String(req.params.uid).replace(/\\W/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFile(path.join(dir, String(parseInt(req.params.idx, 10) || 0)), req.body, e => e ? res.status(500).json({ error: 'Diskka yozilmadi' }) : res.json({ ok: 1 }));
});
A.post('/api/movies/:id/finish', async (req, res) => {
  const { uid, total, ext, number } = req.body;
  const dir = path.join(UP, 'tmp', String(uid).replace(/\\W/g, ''));
  let e2 = String(ext || '.mp4').toLowerCase();
  if (!/^\\.[a-z0-9]{1,6}$/.test(e2)) e2 = '.mp4';
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
    res.json({ ok: 1 });
  } catch (err) { res.status(500).json({ error: 'Birlashtirishda xato' }); }
});
A.get('/api/users', (req, res) => {""")

sub(ADM, "async function saveMovie() {", """async function chunkUpload(file, id, number, cb) {
  const CH = 8 * 1024 * 1024, total = Math.ceil(file.size / CH);
  const uid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let done = 0, next = 0;
  async function worker() {
    while (next < total) {
      const i = next++;
      const blob = file.slice(i * CH, (i + 1) * CH);
      for (let t = 0; ; t++) {
        try {
          const r = await fetch(B + '/api/chunk/' + uid + '/' + i, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: blob });
          if (!r.ok) throw 0;
          break;
        } catch (e) {
          if (t >= 4) throw new Error('chunk');
          await new Promise(r => setTimeout(r, 1500 * (t + 1)));
        }
      }
      done++;
      if (cb) cb(Math.round(done / total * 100));
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const ext = (file.name.match(/\\.[A-Za-z0-9]+$/) || ['.mp4'])[0];
  await req('POST', '/movies/' + id + '/finish', { uid, total, ext, number });
}
async function saveMovie() {""")

sub(ADM, """  if ($('#mv').files[0]) fd.append('video', $('#mv').files[0]);
  $('#msave').disabled = true;
  try { await upload('/movies', fd, p => $('#mbar').style.width = p + '%'); toast('✅ Saqlandi'); go('movies'); } catch (e) { toast('Yuklashda xato'); $('#msave').disabled = false; }""",
"""  const vid = $('#mv').files[0];
  $('#msave').disabled = true;
  try {
    const r = await upload('/movies', fd);
    if (vid) await chunkUpload(vid, r.id, $('#mn').value, p => $('#mbar').style.width = p + '%');
    toast('✅ Saqlandi'); go('movies');
  } catch (e) { toast('Yuklashda xato'); $('#msave').disabled = false; }""")

sub(ADM, """i.onchange = async () => { const fd = new FormData(); fd.append('number', n); fd.append('video', i.files[0]); toast('Yuklanmoqda...'); try { await upload('/movies/' + id + '/episodes', fd, p => toast('Yuklanmoqda ' + p + '%')); toast("✅ Qism qo'shildi"); go('movies'); } catch (e) { toast('Xato'); } };""",
"""i.onchange = async () => { toast('Yuklanmoqda...'); try { await chunkUpload(i.files[0], id, n, p => toast('Yuklanmoqda ' + p + '%')); toast("✅ Qism qo'shildi"); go('movies'); } catch (e) { toast('Xato'); } };""")

print('OK: tezkor yuklash qoshildi')
