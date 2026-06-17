import express from 'express';
import webpush from 'web-push';
import cron from 'node-cron';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { createClient } from 'redis';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:example@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const db = createClient({ url: process.env.REDIS_URL });
db.on('error', err => console.error('Redis:', err));
await db.connect();

// ── Redis helpers ──────────────────────────────────────────
const rGet = async k => { const v = await db.get(k); return v ? JSON.parse(v) : null; };
const rSet = async (k, v, ex) => db.set(k, JSON.stringify(v), ex ? { EX: ex } : {});

// ── Auth middleware ────────────────────────────────────────
async function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  const userId = await db.get(`tok:${token}`);
  if (!userId) return res.status(401).json({ error: 'Invalid session' });
  req.userId = userId;
  next();
}

// ── Streak calculation ─────────────────────────────────────
// records: [{ answer: 'yes'|'no', date: 'YYYY-MM-DD' }]
function calcStreak(records) {
  const byDate = {};
  for (const r of records) {
    if (r.answer === 'yes') byDate[r.date] = true;
    else if (!byDate[r.date]) byDate[r.date] = false;
  }

  const fmt = d => d.toISOString().slice(0, 10);
  const today = new Date();

  // Current streak — walk back from today
  let current = 0;
  const d = new Date(today);
  for (let i = 0; i < 365; i++) {
    const key = fmt(d);
    d.setDate(d.getDate() - 1);
    if (byDate[key] === true) { current++; continue; }
    if (byDate[key] === false) break;          // explicit no → streak broken
    if (i === 0) continue;                      // today not yet answered → check yesterday
    break;
  }

  // Longest streak ever
  let longest = 0, run = 0, prev = null;
  for (const date of Object.keys(byDate).sort()) {
    if (!byDate[date]) { run = 0; prev = date; continue; }
    if (prev && (new Date(date) - new Date(prev)) / 86400000 === 1) run++;
    else run = 1;
    longest = Math.max(longest, run);
    prev = date;
  }

  const total = records.filter(r => r.answer === 'yes').length;
  return { current, longest: Math.max(longest, current), total };
}

async function getChalAnswers(userId, chalId) {
  const raw = await db.lRange(`ans:${userId}:${chalId}`, 0, -1);
  return raw.map(r => JSON.parse(r));
}

// ── Auth ───────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
    return res.status(400).json({ error: 'Username: 3-20 chars, letters/numbers/underscore' });

  const nameKey = `uname:${username.toLowerCase()}`;
  if (await db.get(nameKey)) return res.status(400).json({ error: 'Username already taken' });

  const id = crypto.randomUUID();
  const hash = await bcrypt.hash(password, 10);
  await rSet(`user:${id}`, { id, username, hash, createdAt: Date.now() });
  await db.set(nameKey, id);

  const token = crypto.randomBytes(32).toString('hex');
  await db.set(`tok:${token}`, id, { EX: 60 * 60 * 24 * 30 });
  res.json({ token, username, id });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const userId = await db.get(`uname:${username?.toLowerCase()}`);
  if (!userId) return res.status(400).json({ error: 'User not found' });
  const user = await rGet(`user:${userId}`);
  if (!user || !(await bcrypt.compare(password, user.hash)))
    return res.status(400).json({ error: 'Wrong password' });

  const token = crypto.randomBytes(32).toString('hex');
  await db.set(`tok:${token}`, userId, { EX: 60 * 60 * 24 * 30 });
  res.json({ token, username: user.username, id: userId });
});

app.get('/api/me', auth, async (req, res) => {
  const user = await rGet(`user:${req.userId}`);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ id: user.id, username: user.username });
});

// ── Friends ────────────────────────────────────────────────
app.get('/api/friends', auth, async (req, res) => {
  const [friendIds, reqIds] = await Promise.all([
    db.sMembers(`friends:${req.userId}`),
    db.sMembers(`freq:${req.userId}`),
  ]);
  const hydrate = async ids => {
    const users = await Promise.all(ids.map(id => rGet(`user:${id}`)));
    return users.filter(Boolean).map(u => ({ id: u.id, username: u.username }));
  };
  res.json({ friends: await hydrate(friendIds), requests: await hydrate(reqIds) });
});

app.post('/api/friends/add', auth, async (req, res) => {
  const targetId = await db.get(`uname:${req.body.username?.toLowerCase()}`);
  if (!targetId) return res.status(404).json({ error: 'User not found' });
  if (targetId === req.userId) return res.status(400).json({ error: "Can't add yourself" });
  if (await db.sIsMember(`friends:${req.userId}`, targetId))
    return res.status(400).json({ error: 'Already friends' });

  // If they already sent us a request → auto-accept
  if (await db.sIsMember(`freq:${req.userId}`, targetId)) {
    await db.sRem(`freq:${req.userId}`, targetId);
    await db.sAdd(`friends:${req.userId}`, targetId);
    await db.sAdd(`friends:${targetId}`, req.userId);
    return res.json({ ok: true, accepted: true });
  }

  await db.sAdd(`freq:${targetId}`, req.userId);
  res.json({ ok: true, accepted: false });
});

app.post('/api/friends/accept', auth, async (req, res) => {
  const { fromId } = req.body;
  if (!(await db.sIsMember(`freq:${req.userId}`, fromId)))
    return res.status(400).json({ error: 'No request from this user' });
  await db.sRem(`freq:${req.userId}`, fromId);
  await db.sAdd(`friends:${req.userId}`, fromId);
  await db.sAdd(`friends:${fromId}`, req.userId);
  res.json({ ok: true });
});

app.post('/api/friends/decline', auth, async (req, res) => {
  await db.sRem(`freq:${req.userId}`, req.body.fromId);
  res.json({ ok: true });
});

// ── Challenges ─────────────────────────────────────────────
app.get('/api/challenges', auth, async (req, res) => {
  const ids = await db.sMembers(`uchals:${req.userId}`);
  const today = new Date().toISOString().slice(0, 10);
  const list = await Promise.all(ids.map(async id => {
    const c = await rGet(`challenge:${id}`);
    if (!c) return null;
    const records = await getChalAnswers(req.userId, id);
    return { ...c, myStreak: calcStreak(records), answeredToday: records.some(r => r.date === today) };
  }));
  res.json(list.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt));
});

app.post('/api/challenges', auth, async (req, res) => {
  const { text, inviteUsernames = [] } = req.body || {};
  if (!text?.trim()) return res.status(400).json({ error: 'Question required' });

  const participants = [req.userId];
  for (const uname of inviteUsernames) {
    const uid = await db.get(`uname:${uname.toLowerCase()}`);
    if (uid && uid !== req.userId && !participants.includes(uid)) participants.push(uid);
  }

  const id = crypto.randomUUID();
  const challenge = { id, text: text.trim(), creatorId: req.userId, participants, createdAt: Date.now() };
  await rSet(`challenge:${id}`, challenge);
  for (const uid of participants) await db.sAdd(`uchals:${uid}`, id);
  res.json(challenge);
});

app.get('/api/challenges/:id', auth, async (req, res) => {
  const c = await rGet(`challenge:${req.params.id}`);
  if (!c) return res.status(404).json({ error: 'Not found' });

  const today = new Date().toISOString().slice(0, 10);
  const board = await Promise.all(c.participants.map(async uid => {
    const user = await rGet(`user:${uid}`);
    const records = await getChalAnswers(uid, c.id);
    const streak = calcStreak(records);
    return { userId: uid, username: user?.username || '?', isYou: uid === req.userId,
             answeredToday: records.some(r => r.date === today), ...streak };
  }));
  board.sort((a, b) => b.current - a.current || b.longest - a.longest);

  const myRecords = await getChalAnswers(req.userId, c.id);
  res.json({ ...c, leaderboard: board, answeredToday: myRecords.some(r => r.date === today) });
});

app.post('/api/challenges/:id/answer', auth, async (req, res) => {
  const { answer } = req.body;
  if (!['yes', 'no'].includes(answer)) return res.status(400).json({ error: 'Invalid answer' });
  const c = await rGet(`challenge:${req.params.id}`);
  if (!c || !c.participants.includes(req.userId))
    return res.status(403).json({ error: 'Not a participant' });

  const today = new Date().toISOString().slice(0, 10);
  const existing = await getChalAnswers(req.userId, c.id);
  const todayIdx = existing.findIndex(r => r.date === today);

  if (todayIdx >= 0) {
    existing[todayIdx] = { answer, date: today, ts: Date.now() };
    await db.del(`ans:${req.userId}:${c.id}`);
    for (const r of existing) await db.rPush(`ans:${req.userId}:${c.id}`, JSON.stringify(r));
  } else {
    await db.rPush(`ans:${req.userId}:${c.id}`, JSON.stringify({ answer, date: today, ts: Date.now() }));
  }

  const updated = await getChalAnswers(req.userId, c.id);
  res.json({ ok: true, streak: calcStreak(updated) });
});

// ── Personal questions push subscription ───────────────────
app.post('/api/subscribe', auth, async (req, res) => {
  const { subscription, questions, timezoneOffset } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Missing subscription' });
  await rSet(`sub:${req.userId}`, { subscription, questions: questions || [], timezoneOffset: timezoneOffset ?? 0 });
  await db.sAdd('subUsers', req.userId);
  res.json({ ok: true });
});

app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── Cron: send notifications every minute ─────────────────
cron.schedule('* * * * *', async () => {
  const userIds = await db.sMembers('subUsers');
  const now = new Date();

  for (const userId of userIds) {
    const subData = await rGet(`sub:${userId}`);
    if (!subData) continue;
    const { subscription, questions = [], timezoneOffset = 0 } = subData;

    const local = new Date(now.getTime() - timezoneOffset * 60000);
    const localTime = `${local.getUTCHours().toString().padStart(2,'0')}:${local.getUTCMinutes().toString().padStart(2,'0')}`;
    const localDate = local.toISOString().slice(0, 10);

    const send = async (tag, title, body) => {
      const sentKey = `sent:${userId}:${tag}:${localDate}`;
      if (await db.get(sentKey)) return;
      try {
        await webpush.sendNotification(subscription, JSON.stringify({
          title, body, icon: '/icon-192.png', badge: '/icon-192.png', tag,
          actions: [{ action: 'yes', title: '✅ Yes' }, { action: 'no', title: '❌ No' }],
          data: { tag },
        }));
        await db.set(sentKey, '1', { EX: 90000 });
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.del(`sub:${userId}`);
          await db.sRem('subUsers', userId);
        }
      }
    };

    // Personal questions at their set time
    for (const q of questions) {
      if (q.time === localTime) await send(`q-${q.id}`, 'Pact', q.text);
    }

    // Challenge reminders at 9:00 AM local time
    if (localTime === '09:00') {
      const chalIds = await db.sMembers(`uchals:${userId}`);
      for (const chalId of chalIds) {
        const c = await rGet(`challenge:${chalId}`);
        if (!c) continue;
        const records = await getChalAnswers(userId, chalId);
        if (records.some(r => r.date === localDate)) continue;
        await send(`chal-${chalId}`, '🏆 Challenge Reminder', c.text);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
