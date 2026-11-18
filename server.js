require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '1221';
const SECRET = crypto
  .createHash('sha256')
  .update('valed:' + ADMIN_PASSWORD + (process.env.SESSION_SECRET || ''))
  .digest();

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// ---------- tiny stateless admin tokens ----------
const TOKEN_HOURS = 12;
const sign = (text) => crypto.createHmac('sha256', SECRET).update(text).digest('hex');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function makeToken() {
  const exp = String(Date.now() + TOKEN_HOURS * 3600 * 1000);
  return exp + '.' + sign(exp);
}
function validToken(token) {
  if (!token) return false;
  const [exp, sig] = String(token).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!validToken(token)) return res.status(401).json({ error: 'Please log in again.' });
  next();
}

// ---------- login throttle (10 tries / 15 min / IP) ----------
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}

// ---------- image helpers ----------
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
function parseDataUrl(str, allowed = /^(jpeg|png|webp|gif)$/) {
  if (typeof str !== 'string') return null;
  const m = /^data:image\/([a-z]+);base64,/.exec(str.slice(0, 40));
  if (!m || !allowed.test(m[1])) return null;
  const data = Buffer.from(str.slice(m[0].length), 'base64');
  if (!data.length || data.length > MAX_IMAGE_BYTES) return null;
  return { contentType: 'image/' + m[1], data };
}
const toDim = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n < 20000 ? n : null;
};
const validTab = (n) => [1, 2, 3].includes(Number(n));
const validId = (id) => ObjectId.isValid(id) && String(new ObjectId(id)) === id;
const BAD_IMAGE = 'Use a JPG, PNG, WebP or GIF under 8 MB.';

const DEFAULT_MESSAGE = [
  '\u{1F49A}\u{1F384} 7-JADE is HERE! Spreading Kindness at this time of the year! \u{1F384}\u{1F49A}',
  'This Christmas, we choose KINDNESS. Because the best gift is not something you buy, it is something you give from the heart.',
  'Stay tuned for our behind-the-scenes, our kindness wheel, kindness ladder and many more! You DON\'T want to miss this!',
  'This is 7-Jade. See you there!',
  '#ValEdProject #7Jade #Kindness',
].join('\n\n');
const DEFAULT_EVENT = {
  date: '2026-12-02',
  place: 'The School Pavilion',
  activities: [{ id: 'wheel', text: '\u{1F3A1} Prize Wheel' }, { id: 'chair', text: '\u{1FA91} Kindness Chair' }, { id: 'wall', text: '\u{1F4CB} Freedom Wall' }],
  credits: '\u{1F5BC} Rionnah Rodriguez\n\u{1F58B} Joaquin Balbin',
};

const SHAPES = ['auto', 'square', 'wide', 'tall'];
const num = (v, def, lo, hi) => {
  const n = Number(v);
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : def));
};
const AUDIO_TYPES = /^audio\/(mpeg|mp3|mp4|x-m4a|m4a|aac|ogg|wav|x-wav|wave|webm|flac|x-flac)$/;
const MAX_SONGS = 12;

const slugId = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'act';
// activities carry a stable id so each one keeps its own Rules and Regulations picture
function normEvent(v) {
  const ev = { ...(v || {}) };
  const used = new Set();
  ev.activities = (Array.isArray(ev.activities) ? ev.activities : [])
    .map((a) => {
      const text = String(typeof a === 'string' ? a : (a && a.text) || '').trim().slice(0, 60);
      if (!text) return null;
      let id = a && typeof a === 'object' && /^[a-z0-9]{3,24}$/.test(a.id || '') ? a.id : slugId(text.replace(/^[^\p{L}\p{N}]+/u, ''));
      if (id.length < 3) id = id + 'act';
      while (used.has(id)) id += 'x';
      used.add(id);
      return { id, text };
    })
    .filter(Boolean)
    .slice(0, 8);
  return ev;
}

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db('valed');
  const images = db.collection('images');
  const settings = db.collection('settings');
  const songs = db.collection('songs');
  await images.createIndex({ tab: 1, createdAt: 1 });

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '14mb' }));
  app.get('/healthz', (req, res) => res.send('ok'));
  app.use(express.static(path.join(__dirname, 'public')));

  // Everything the page needs in one call (no image bytes, just ids)
  app.get('/api/state', async (req, res) => {
    const [msg, logo, ev, songDocs, lv] = await Promise.all([
      settings.findOne({ _id: 'message' }),
      settings.findOne({ _id: 'logo' }, { projection: { data: 0 } }),
      settings.findOne({ _id: 'event' }),
      songs.find({}, { projection: { data: 0 } }).sort({ createdAt: 1, _id: 1 }).toArray(),
      settings.findOne({ _id: 'logoView' }),
    ]);
    const docs = await images
      .find({}, { projection: { data: 0, thumb: 0 } })
      .sort({ createdAt: 1 })
      .toArray();
    const tabs = { 1: { title: null, rules: null, pictures: [] }, 2: { title: null, rules: null, pictures: [] }, 3: { title: null, rules: null, pictures: [] } };
    const rulesMap = {};
    for (const d of docs) {
      if (d.isRules) {
        if (d.activity) rulesMap[d.activity] = { id: String(d._id), url: '/api/images/' + d._id, thumb: '/api/images/' + d._id + '/thumb' };
        continue;
      }
      if (!tabs[d.tab]) continue;
      const entry = {
        id: String(d._id),
        url: '/api/images/' + d._id,
        thumb: '/api/images/' + d._id + '/thumb',
        w: d.w || null,
        h: d.h || null,
        caption: d.caption || '',
        view: d.view || null,
      };
      if (d.isTitle) tabs[d.tab].title = entry;
      else tabs[d.tab].pictures.push(entry);
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      message: msg ? msg.text : DEFAULT_MESSAGE,
      logoZoom: lv ? lv.zoom : 1,
      logoRing: lv && lv.ring === false ? false : true,
      event: normEvent(ev ? ev.value : DEFAULT_EVENT),
      rules: rulesMap,
      songs: songDocs.map((d) => ({ id: String(d._id), name: d.name, url: '/api/songs/' + d._id + '/audio' })),
      logo: logo ? { url: '/api/logo?v=' + (logo.updatedAt ? logo.updatedAt.getTime() : 1) } : null,
      tabs,
    });
  });

  app.get('/api/images/:id', async (req, res) => {
    if (!validId(req.params.id)) return res.sendStatus(404);
    const doc = await images.findOne({ _id: new ObjectId(req.params.id) }, { projection: { thumb: 0 } });
    if (!doc) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(doc.contentType).send(Buffer.from(doc.data.buffer));
  });

  app.get('/api/images/:id/thumb', async (req, res) => {
    if (!validId(req.params.id)) return res.sendStatus(404);
    const doc = await images.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    if (doc.thumb) return res.type('image/jpeg').send(Buffer.from(doc.thumb.buffer));
    res.type(doc.contentType).send(Buffer.from(doc.data.buffer)); // older uploads have no thumbnail
  });

  app.get('/api/logo', async (req, res) => {
    const doc = await settings.findOne({ _id: 'logo' });
    if (!doc) return res.sendStatus(404);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(doc.contentType).send(Buffer.from(doc.data.buffer));
  });

  app.post('/api/login', (req, res) => {
    if (throttled(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const ok = safeEqual(req.body && req.body.password, ADMIN_PASSWORD);
    if (!ok) {
      attempts.get(req.ip).push(Date.now());
      return res.status(401).json({ error: 'Wrong password.' });
    }
    res.json({ token: makeToken() });
  });

  app.put('/api/message', requireAdmin, async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    await settings.updateOne({ _id: 'message' }, { $set: { text, updatedAt: new Date() } }, { upsert: true });
    res.json({ message: text });
  });

  app.put('/api/event', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : '';
    const place = String(b.place || '').trim().slice(0, 120);
    const { activities } = normEvent({ activities: b.activities });
    const credits = String(b.credits || '').trim().slice(0, 200);
    const value = { date, place, activities, credits };
    await settings.updateOne({ _id: 'event' }, { $set: { value, updatedAt: new Date() } }, { upsert: true });
    await images.deleteMany({ isRules: true, activity: { $nin: activities.map((a) => a.id) } });
    res.json({ event: value });
  });

  app.put('/api/logo/view', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const zoom = Math.round(num(b.zoom, 1, 0.5, 4) * 100) / 100;
    const ring = b.ring !== false;
    await settings.updateOne({ _id: 'logoView' }, { $set: { zoom, ring } }, { upsert: true });
    res.json({ zoom, ring });
  });

  app.post('/api/logo', requireAdmin, async (req, res) => {
    const img = parseDataUrl(req.body && req.body.image);
    if (!img) return res.status(400).json({ error: BAD_IMAGE });
    await settings.updateOne({ _id: 'logo' }, { $set: { ...img, updatedAt: new Date() } }, { upsert: true });
    res.json({ ok: true });
  });

  // title picture (one per tab) or extra picture
  const addImage = (kind) => async (req, res) => {
    const isTitle = kind === 'title';
    const isRules = kind === 'rules';
    if (!validTab(req.params.n)) return res.status(400).json({ error: 'Unknown tab.' });
    const body = req.body || {};
    const img = parseDataUrl(body.image);
    const thumb = body.thumb ? parseDataUrl(body.thumb, /^jpeg$/) : null;
    if (!img) return res.status(400).json({ error: BAD_IMAGE });
    const tab = Number(req.params.n);
    if (isTitle) await images.deleteMany({ tab, isTitle: true });
    if (isRules) await images.deleteMany({ tab, isRules: true });
    await images.insertOne({
      tab,
      isTitle,
      isRules,
      contentType: img.contentType,
      data: img.data,
      thumb: thumb ? thumb.data : null,
      w: toDim(body.w),
      h: toDim(body.h),
      caption: '',
      createdAt: new Date(),
    });
    res.json({ ok: true });
  };
  app.post('/api/tabs/:n/title', requireAdmin, addImage('title'));
  app.post('/api/tabs/:n/pictures', requireAdmin, addImage('pictures'));
  // Rules and Regulations picture for one activity (Prize Wheel, Kindness Chair, Freedom Wall...)
  app.post('/api/activities/:id/rules', requireAdmin, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-z0-9]{3,24}$/.test(id)) return res.status(400).json({ error: 'Bad id.' });
    const evDoc = await settings.findOne({ _id: 'event' });
    const ev = normEvent(evDoc ? evDoc.value : DEFAULT_EVENT);
    if (!ev.activities.some((a) => a.id === id)) return res.status(404).json({ error: 'Save the event details first.' });
    const body = req.body || {};
    const img = parseDataUrl(body.image);
    const thumb = body.thumb ? parseDataUrl(body.thumb, /^jpeg$/) : null;
    if (!img) return res.status(400).json({ error: BAD_IMAGE });
    await images.deleteMany({ isRules: true, activity: id });
    await images.insertOne({
      tab: 0, isTitle: false, isRules: true, activity: id,
      contentType: img.contentType, data: img.data, thumb: thumb ? thumb.data : null,
      w: toDim(body.w), h: toDim(body.h), caption: '', createdAt: new Date(),
    });
    res.json({ ok: true });
  });

  app.put('/api/images/:id', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    const caption = String((req.body && req.body.caption) || '').trim().slice(0, 140);
    await images.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { caption } });
    res.json({ caption });
  });

  // make a picture the title picture; the old title becomes a normal picture
  app.post('/api/images/:id/promote', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    const _id = new ObjectId(req.params.id);
    const doc = await images.findOne({ _id }, { projection: { tab: 1, isTitle: 1, isRules: 1 } });
    if (!doc) return res.status(404).json({ error: 'Picture not found.' });
    if (doc.isRules) return res.status(400).json({ error: 'Cannot change that picture.' });
    if (!doc.isTitle) {
      await images.updateMany({ tab: doc.tab, isTitle: true }, { $set: { isTitle: false, createdAt: new Date() } });
      await images.updateOne({ _id }, { $set: { isTitle: true } });
    }
    res.json({ ok: true });
  });

  // move a normal picture one place earlier (-1) or later (1)
  app.post('/api/images/:id/move', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    const dir = Number(req.body && req.body.dir) < 0 ? -1 : 1;
    const _id = new ObjectId(req.params.id);
    const doc = await images.findOne({ _id }, { projection: { tab: 1, isTitle: 1, isRules: 1, createdAt: 1 } });
    if (!doc || doc.isTitle || doc.isRules) return res.status(400).json({ error: 'Cannot move that picture.' });
    const list = await images
      .find({ tab: doc.tab, isTitle: false, isRules: { $ne: true } }, { projection: { createdAt: 1 } })
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    const i = list.findIndex((d) => String(d._id) === req.params.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return res.json({ ok: true });
    let a = list[i].createdAt, b = list[j].createdAt;
    if (a.getTime() === b.getTime()) b = new Date(b.getTime() + dir);
    await images.updateOne({ _id: list[i]._id }, { $set: { createdAt: b } });
    await images.updateOne({ _id: list[j]._id }, { $set: { createdAt: a } });
    res.json({ ok: true });
  });

  // per-picture display: size (columns), shape, zoom and focus point
  app.put('/api/images/:id/view', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    const b = req.body || {};
    const view = {
      size: [1, 2, 3].includes(Number(b.size)) ? Number(b.size) : null,
      shape: SHAPES.includes(b.shape) ? b.shape : 'auto',
      zoom: Math.round(num(b.zoom, 1, 1, 3) * 100) / 100,
      x: Math.round(num(b.x, 50, 0, 100) * 10) / 10,
      y: Math.round(num(b.y, 50, 0, 100) * 10) / 10,
    };
    await images.updateOne({ _id: new ObjectId(req.params.id) }, { $set: { view } });
    res.json({ view });
  });

  // ---------- background songs (stored in MongoDB, streamed with Range support) ----------
  app.get('/api/songs/:id/audio', async (req, res) => {
    if (!validId(req.params.id)) return res.sendStatus(404);
    const doc = await songs.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.sendStatus(404);
    const buf = Buffer.from(doc.data.buffer);
    const total = buf.length;
    res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': doc.contentType, 'Cache-Control': 'public, max-age=31536000, immutable' });
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start, end;
      if (m[1] === '') { start = Math.max(0, total - Number(m[2])); end = total - 1; }
      else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
      if (start >= total || start > end) return res.status(416).set('Content-Range', 'bytes */' + total).end();
      res.status(206).set({ 'Content-Range': 'bytes ' + start + '-' + end + '/' + total, 'Content-Length': end - start + 1 });
      return res.end(buf.subarray(start, end + 1));
    }
    res.set('Content-Length', total);
    res.end(buf);
  });

  app.post('/api/songs', requireAdmin, express.raw({ type: () => true, limit: '13mb' }), async (req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!AUDIO_TYPES.test(type)) return res.status(400).json({ error: 'Use an MP3, M4A, WAV, OGG or AAC file.' });
    const data = req.body;
    if (!Buffer.isBuffer(data) || !data.length) return res.status(400).json({ error: 'That file is empty.' });
    if ((await songs.countDocuments()) >= MAX_SONGS) return res.status(400).json({ error: 'Up to ' + MAX_SONGS + ' songs. Remove one first.' });
    const name = String(req.query.name || 'Untitled').replace(/\.[a-z0-9]{2,5}$/i, '').trim().slice(0, 80) || 'Untitled';
    await songs.insertOne({ name, contentType: type, data, size: data.length, createdAt: new Date() });
    res.json({ ok: true });
  });

  app.post('/api/songs/:id/move', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    const dir = Number(req.body && req.body.dir) < 0 ? -1 : 1;
    const list = await songs.find({}, { projection: { createdAt: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
    const i = list.findIndex((d) => String(d._id) === req.params.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return res.json({ ok: true });
    let a = list[i].createdAt, b = list[j].createdAt;
    if (a.getTime() === b.getTime()) b = new Date(b.getTime() + dir);
    await songs.updateOne({ _id: list[i]._id }, { $set: { createdAt: b } });
    await songs.updateOne({ _id: list[j]._id }, { $set: { createdAt: a } });
    res.json({ ok: true });
  });

  app.delete('/api/songs/:id', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    await songs.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  });

  app.delete('/api/images/:id', requireAdmin, async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Bad id.' });
    await images.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  });

  app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'That file is too large (songs: 12 MB max).' : 'Server error.' });
  });

  app.listen(PORT, () => console.log('7-Jade ValEd is running on port ' + PORT));
}

main().catch((e) => {
  console.error('Could not start:', e.message);
  process.exit(1);
});
