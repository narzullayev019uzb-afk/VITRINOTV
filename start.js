require('dotenv').config();
const fs = require('fs');
const path = require('path');
const st = require('./storage');
(async () => {
  try {
    if (st.enabled) {
      const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
      const dbPath = path.join(DATA, 'app.db');
      fs.mkdirSync(DATA, { recursive: true });
      if (!fs.existsSync(dbPath)) {
        try {
          const r = await st.getObject('db/app.db');
          await new Promise((ok, no) => {
            const ws = fs.createWriteStream(dbPath);
            r.Body.on('error', no);
            ws.on('error', no);
            ws.on('finish', ok);
            r.Body.pipe(ws);
          });
          console.log('Baza S3 dan tiklandi');
        } catch (e) {
          console.log('S3 da baza topilmadi, yangi boshlanadi:', e.name || e.message);
          fs.rmSync(dbPath, { force: true });
        }
      }
    }
  } catch (e) { console.error('Tiklashda xato:', e.message); }
  require('./server');
})();
