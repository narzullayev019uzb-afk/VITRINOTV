const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA, 'uploads', 'private'), { recursive: true });
const db = new Database(path.join(DATA, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(tg_id INTEGER PRIMARY KEY, name TEXT, username TEXT, blocked INTEGER DEFAULT 0, created_at INTEGER, last_seen INTEGER, phone TEXT);
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS movies(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, year INTEGER, category_id INTEGER, type TEXT DEFAULT 'movie', description TEXT, poster TEXT, price INTEGER DEFAULT 0, allow_download INTEGER DEFAULT 1, views INTEGER DEFAULT 0, created_at INTEGER, featured INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS episodes(id INTEGER PRIMARY KEY AUTOINCREMENT, movie_id INTEGER, number INTEGER DEFAULT 1, file TEXT, size INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS purchases(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, movie_id INTEGER, receipt TEXT, status TEXT DEFAULT 'pending', created_at INTEGER);
CREATE TABLE IF NOT EXISTS pay_methods(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, card TEXT, holder TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT, title TEXT, link TEXT);
CREATE TABLE IF NOT EXISTS banners(id INTEGER PRIMARY KEY AUTOINCREMENT, file TEXT, kind TEXT, link TEXT, active INTEGER DEFAULT 1, place TEXT DEFAULT 'top', views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS bots(id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, username TEXT, welcome TEXT, button TEXT, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS admins(id INTEGER PRIMARY KEY, username TEXT, salt TEXT, hash TEXT, role TEXT DEFAULT 'helper');
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS favs(user_id INTEGER, movie_id INTEGER, PRIMARY KEY(user_id, movie_id));
CREATE TABLE IF NOT EXISTS progress(user_id INTEGER, episode_id INTEGER, movie_id INTEGER, pos REAL, dur REAL, updated_at INTEGER, PRIMARY KEY(user_id, episode_id));
`);
for (const q of [
  'ALTER TABLE users ADD COLUMN phone TEXT',
  'ALTER TABLE movies ADD COLUMN featured INTEGER DEFAULT 0',
  'ALTER TABLE episodes ADD COLUMN size INTEGER DEFAULT 0',
  "ALTER TABLE banners ADD COLUMN place TEXT DEFAULT 'top'",
  'ALTER TABLE banners ADD COLUMN views INTEGER DEFAULT 0',
  'ALTER TABLE banners ADD COLUMN clicks INTEGER DEFAULT 0'
]) { try { db.exec(q); } catch (e) {} }
try { db.exec("ALTER TABLE admins ADD COLUMN role TEXT DEFAULT 'helper'"); } catch (e) {}
db.exec(`
UPDATE admins SET role='super' WHERE id=1;
CREATE INDEX IF NOT EXISTS i_movies_cat ON movies(category_id);
CREATE INDEX IF NOT EXISTS i_movies_views ON movies(views);
CREATE INDEX IF NOT EXISTS i_eps_movie ON episodes(movie_id, number);
CREATE INDEX IF NOT EXISTS i_pur ON purchases(user_id, movie_id, status);
CREATE INDEX IF NOT EXISTS i_prog ON progress(user_id, updated_at);
CREATE INDEX IF NOT EXISTS i_users_seen ON users(last_seen);
`);
const getSetting = (k, d) => { const r = db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? r.v : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
module.exports = { db, DATA, getSetting, setSetting };
