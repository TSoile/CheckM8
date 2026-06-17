const CACHE = 'checkins-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Store timers in memory (re-seeded on each SW activation from main thread)
const timers = {};

function scheduleNotification(q) {
  if (timers[q.id]) clearTimeout(timers[q.id]);

  const now = new Date();
  const [h, m] = q.time.split(':').map(Number);
  let fire = new Date();
  fire.setHours(h, m, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);

  const delay = fire - now;

  timers[q.id] = setTimeout(async () => {
    await self.registration.showNotification(q.text, {
      body: 'Tap to answer',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: `checkin-${q.id}`,
      renotify: true,
      data: { questionId: q.id, questionText: q.text },
      actions: [
        { action: 'yes', title: '✅ Yes' },
        { action: 'no',  title: '❌ No'  }
      ]
    });
    // Reschedule for tomorrow
    scheduleNotification(q);
  }, delay);
}

self.addEventListener('message', e => {
  if (e.data?.type === 'SEED_SCHEDULES') {
    // Clear old timers
    Object.keys(timers).forEach(id => clearTimeout(timers[id]));
    (e.data.questions || []).forEach(q => scheduleNotification(q));
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { questionId, questionText } = e.notification.data || {};
  const answer = e.action; // 'yes' or 'no' or '' (tapped body)

  if (answer === 'yes' || answer === 'no') {
    // Log answer directly from SW, then open app
    e.waitUntil(
      clients.matchAll({ type: 'window' }).then(async wins => {
        const payload = JSON.stringify({ questionId, questionText, answer, ts: Date.now() });
        if (wins.length > 0) {
          wins[0].postMessage({ type: 'LOG_ANSWER', payload });
          wins[0].focus();
        } else {
          const win = await clients.openWindow(`/?log=${encodeURIComponent(payload)}`);
        }
      })
    );
  } else {
    // Body tapped — open app to answer
    e.waitUntil(
      clients.matchAll({ type: 'window' }).then(wins => {
        const url = `/?answer=${questionId}`;
        if (wins.length > 0) { wins[0].focus(); wins[0].navigate(url); }
        else clients.openWindow(url);
      })
    );
  }
});
