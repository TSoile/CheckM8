// ── Install / Activate ────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

// ── Local scheduling (fallback when server push isn't available) ──
const timers = {};

function scheduleLocal(q) {
  if (timers[q.id]) clearTimeout(timers[q.id]);

  const now  = new Date();
  const [h, m] = q.time.split(':').map(Number);
  const fire = new Date();
  fire.setHours(h, m, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);

  timers[q.id] = setTimeout(async () => {
    await self.registration.showNotification('Pact', {
      body:      q.text,
      icon:      '/icon-192.png',
      badge:     '/icon-192.png',
      tag:       `checkin-${q.id}`,
      renotify:  true,
      data:      { questionId: q.id, questionText: q.text },
      actions:   [{ action: 'yes', title: '✅ Yes' }, { action: 'no', title: '❌ No' }],
    });
    scheduleLocal(q); // reschedule for tomorrow
  }, fire - now);
}

self.addEventListener('message', e => {
  if (e.data?.type === 'SEED_SCHEDULES') {
    Object.keys(timers).forEach(id => clearTimeout(timers[id]));
    (e.data.questions || []).forEach(scheduleLocal);
  }
});

// ── Server push handler ───────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Pact', {
      body:     data.body,
      icon:     data.icon     || '/icon-192.png',
      badge:    data.badge    || '/icon-192.png',
      tag:      data.tag,
      renotify: true,
      data:     data.data     || {},
      actions:  data.actions  || [{ action: 'yes', title: '✅ Yes' }, { action: 'no', title: '❌ No' }],
    })
  );
});

// ── Notification click ────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { questionId, questionText } = e.notification.data || {};
  const ans = e.action; // 'yes', 'no', or '' (body tap)

  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(async wins => {
      if (ans === 'yes' || ans === 'no') {
        const payload = JSON.stringify({ questionId, questionText, answer: ans, ts: Date.now() });
        if (wins.length > 0) {
          wins[0].postMessage({ type: 'LOG_ANSWER', payload });
          wins[0].focus();
        } else {
          await clients.openWindow(`/?log=${encodeURIComponent(payload)}`);
        }
      } else {
        const url = `/?answer=${questionId}`;
        if (wins.length > 0) { wins[0].focus(); wins[0].navigate(url); }
        else await clients.openWindow(url);
      }
    })
  );
});
