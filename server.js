import express from 'express';
import webpush from 'web-push';
import cron from 'node-cron';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── VAPID setup ───────────────────────────────────────────
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || 'mailto:example@example.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Upstash Redis (REST API — no SDK needed) ──────────────
async function redis(command, ...args) {
  const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  });
  const { result } = await res.json();
  return result;
}

async function redisGet(key) {
  const raw = await redis('GET', key);
  return raw ? JSON.parse(raw) : null;
}
async function redisSet(key, value, exSeconds) {
  const args = ['SET', key, JSON.stringify(value)];
  if (exSeconds) args.push('EX', exSeconds);
  return redis(...args);
}

// ── API: return VAPID public key to browser ───────────────
app.get('/api/config', (req, res) => {
  res.json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ── API: save push subscription + questions ───────────────
app.post('/api/subscribe', async (req, res) => {
  const { subscription, questions, timezoneOffset } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Missing subscription' });

  const id = crypto
    .createHash('sha256')
    .update(subscription.endpoint)
    .digest('hex')
    .slice(0, 16);

  await redisSet(`sub:${id}`, { subscription, questions: questions || [], timezoneOffset: timezoneOffset ?? 0 });
  await redis('SADD', 'subs', id);

  return res.json({ ok: true });
});

// ── Cron: runs every minute, sends due notifications ──────
async function sendDueNotifications() {
  const ids = await redis('SMEMBERS', 'subs');
  if (!ids?.length) return;

  const now = new Date();

  for (const id of ids) {
    const data = await redisGet(`sub:${id}`);
    if (!data) continue;

    const { subscription, questions, timezoneOffset } = data;

    // Convert UTC → user's local time
    const local     = new Date(now.getTime() - (timezoneOffset ?? 0) * 60000);
    const localTime = `${local.getUTCHours().toString().padStart(2,'0')}:${local.getUTCMinutes().toString().padStart(2,'0')}`;
    const localDate = local.toISOString().slice(0, 10);

    for (const q of questions || []) {
      if (q.time !== localTime) continue;

      // Skip if already sent today
      const sentKey = `sent:${id}:${q.id}:${localDate}`;
      const already = await redis('GET', sentKey);
      if (already) continue;

      try {
        await webpush.sendNotification(
          subscription,
          JSON.stringify({
            title:   'Daily Check-in',
            body:    q.text,
            icon:    '/icon-192.png',
            badge:   '/icon-192.png',
            tag:     `checkin-${q.id}`,
            data:    { questionId: q.id, questionText: q.text },
            actions: [
              { action: 'yes', title: '✅ Yes' },
              { action: 'no',  title: '❌ No'  },
            ],
          })
        );
        // Mark sent — expires in 25h to handle DST edge cases
        await redis('SET', sentKey, '1', 'EX', 90000);
        console.log(`Sent "${q.text}" to ${id}`);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expired — clean it up
          await redis('DEL', `sub:${id}`);
          await redis('SREM', 'subs', id);
        }
        console.error(`Push failed for ${id}:`, err.message);
      }
    }
  }
}

// Run every minute
cron.schedule('* * * * *', sendDueNotifications);

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));
