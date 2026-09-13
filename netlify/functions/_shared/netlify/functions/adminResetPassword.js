/**
 * Bachat Bazaar - Admin Forgot-Password Reset (Netlify Function) — Item #1
 * ===========================================================================
 * Naye firestore.rules mein `store/admin-secure` sirf server hi likh sakta
 * hai, isliye "Naya password set karein" step ab yahan se hota hai - security
 * answer yahan dobara (server par) verify hota hai, aur nayi hash yahan hi
 * banti hai. Client kabhi seedha admin-secure nahi likhta.
 *
 * NAYA (shared helper migration): CORS/method-check ab `_shared/security.js`
 * se aata hai, aur is par ab rate limit (5 attempts / 15 minute per IP) +
 * audit log lag gaya hai - security-answer bhi guess ki jaa sakti hai,
 * isliye ye adminLogin se bhi tighter hai.
 *
 * NAYA (username-check fix): pehle sirf security-answer se hi reset ho
 * jaata tha - username kabhi verify nahi hota tha. Ab client se `username`
 * bhi bhejna zaroori hai aur wo admin-secure (ya migration se pehle
 * store-settings) ke adminUsername se match hona chahiye, tabhi reset
 * hoga. Isse audit_logs mein bhi saaf pata chalta hai ki reset kis
 * admin username ke against attempt hua tha.
 *
 * errorCode: METHOD_NOT_ALLOWED, MISSING_FIELDS, SERVER_NOT_CONFIGURED,
 *            WRONG_ANSWER, RATE_LIMITED, INTERNAL_ERROR
 */

const crypto = require('crypto');
const { withSecurity } = require('./_shared/security');

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}
function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, db, audit } = ctx;

    let username, answer, newPassword;
    try {
      ({ username, answer, newPassword } = JSON.parse(event.body || '{}'));
    } catch (e) {
      username = null;
      answer = null;
    }
    if (!username || !answer || !newPassword || newPassword.length < 6) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username, security answer aur kam se kam 6 character ka naya password chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }

    if (!db) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server par reset configure nahi hai.', errorCode: 'SERVER_NOT_CONFIGURED' }) };
    }

    const settingsRef = db.collection('store').doc('store-settings');
    const settingsSnap = await settingsRef.get();
    const settings = settingsSnap.exists ? settingsSnap.data().value || {} : {};

    const secureRef = db.collection('store').doc('admin-secure');
    const secureSnap = await secureRef.get();
    const currentUsername = secureSnap.exists ? secureSnap.data().adminUsername : (settings.adminUsername || 'admin');

    if (username !== currentUsername) {
      await audit({ event: 'reset_failed', reason: 'wrong_username', username });
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Jawab galat hai.', errorCode: 'WRONG_ANSWER' }) };
    }

    const correctAnswer = (settings.securityAnswer || '').trim().toLowerCase();
    if (!correctAnswer || answer.trim().toLowerCase() !== correctAnswer) {
      await audit({ event: 'reset_failed', reason: 'wrong_answer', username });
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Jawab galat hai.', errorCode: 'WRONG_ANSWER' }) };
    }

    const salt = genSalt();
    const hash = hashPassword(newPassword, salt);
    await secureRef.set({ adminUsername: currentUsername, adminPasswordHash: hash, adminPasswordSalt: salt });

    await audit({ event: 'reset_success', username: currentUsername });
    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  },
  {
    functionName: 'adminResetPassword',
    methods: ['POST'],
    rateLimit: { limit: 5, windowMs: 15 * 60 * 1000 }, // 5 attempts / 15 min per IP
  }
);
