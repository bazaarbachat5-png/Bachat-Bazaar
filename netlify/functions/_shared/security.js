/**
 * Bachat Bazaar - Shared Netlify Function Security Helper
 * =========================================================
 * Ab tak har function (adminLogin, adminResetPassword, ...) mein
 * ye 3 cheezein alag-alag copy-paste hoti thi:
 *   1. CORS headers + OPTIONS handling
 *   2. Firebase Admin app init
 *   3. Kuch bhi rate-limit ya audit log nahi tha
 *
 * Is file mein ab teeno cheezein ek jagah hain:
 *
 * 1) CORS + method check - jaisa pehle tha, bas ek hi jagah se.
 *
 * 2) Rate limiting - Netlify Functions stateless hain (har request
 *    naya container ho sakta hai), isliye in-memory counter kaam
 *    nahi karta. Firestore mein `rate_limits/{functionName:ip}` doc
 *    mein ek fixed-window counter rakhte hain (transaction se atomic).
 *    Isse admin password brute-force guess (adminLogin,
 *    adminResetPassword) aur Gemini quota abuse (generateStyleAdvice)
 *    dono se bacha jaata hai.
 *
 * 3) Audit log - har security-sensitive event (login success/fail,
 *    password reset, rate-limit hit, unhandled error) ek chhota
 *    record `audit_logs` collection mein ban jaata hai: kaun function,
 *    kya hua, kaunse IP se, kab. Sirf Admin SDK (server) isme likhta
 *    hai - firestore.rules mein client ke liye likhna poori tarah
 *    band hai, padhna sirf admin ke liye khula hai.
 *
 * Har function ab bas apna "business logic" likhta hai; CORS/rate-limit
 * /audit ka boilerplate is `withSecurity()` wrapper ke andar hai.
 */

const admin = require('firebase-admin');

function getFirebaseApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) return null;
  try {
    return admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  } catch (err) {
    console.error('FIREBASE_SERVICE_ACCOUNT_KEY invalid JSON:', err);
    return null;
  }
}

function corsHeaders(methods) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': `${methods.join(', ')}, OPTIONS`,
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// Netlify request se best-effort client IP nikalta hai (rate-limit key
// aur audit log ke liye - exact/legal-grade IP ki zarurat nahi hai,
// sirf "same abuser dobara aaya" pehchaanna hai).
function getClientIp(event) {
  const h = event.headers || {};
  return (
    h['x-nf-client-connection-ip'] ||
    (h['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

/**
 * Firestore-backed fixed-window rate limiter.
 * key: e.g. "adminLogin:1.2.3.4"
 * Returns { allowed, retryAfterSeconds }
 */
async function checkRateLimit(db, key, limit, windowMs) {
  const ref = db.collection('rate_limits').doc(key.replace(/\//g, '_'));
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;

    if (!data || now - data.windowStart > windowMs) {
      tx.set(ref, { windowStart: now, count: 1 });
      return { allowed: true };
    }
    if (data.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((data.windowStart + windowMs - now) / 1000) };
    }
    tx.update(ref, { count: admin.firestore.FieldValue.increment(1) });
    return { allowed: true };
  });
}

async function writeAudit(db, entry) {
  try {
    await db.collection('audit_logs').add({
      ...entry,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // Audit likhna fail ho jaaye to bhi asli request kabhi na toote.
    console.error('audit log write failed:', err);
  }
}

/**
 * withSecurity(handler, opts)
 *   opts.functionName : string  - rate-limit key + audit "function" field
 *   opts.methods       : string[] (default ['POST']) - allowed HTTP methods
 *   opts.rateLimit      : { limit, windowMs } | null - Firestore available
 *                          hone par hi lagta hai; nahi to skip (fail-open)
 *
 * handler(event, ctx) likhna hai, jahan ctx = {
 *   app, db (null agar Firebase configure nahi hai), ip, headers,
 *   audit(fields) -> Firestore mein ek audit_logs record daalta hai
 * }
 */
function withSecurity(handler, opts) {
  const { functionName, methods = ['POST'], rateLimit = null } = opts;
  const headers = corsHeaders(methods);

  return async function (event) {
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers, body: '' };
    }
    if (!methods.includes(event.httpMethod)) {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Only ' + methods.join('/') + ' allowed', errorCode: 'METHOD_NOT_ALLOWED' }),
      };
    }

    const app = getFirebaseApp();
    const db = app ? admin.firestore() : null;
    const ip = getClientIp(event);
    const ctx = {
      app,
      db,
      ip,
      headers,
      audit: (fields) => (db ? writeAudit(db, { function: functionName, ip, ...fields }) : Promise.resolve()),
    };

    if (rateLimit && db) {
      const key = `${functionName}:${ip}`;
      const result = await checkRateLimit(db, key, rateLimit.limit, rateLimit.windowMs);
      if (!result.allowed) {
        await ctx.audit({ event: 'rate_limited' });
        return {
          statusCode: 429,
          headers: { ...headers, 'Retry-After': String(result.retryAfterSeconds) },
          body: JSON.stringify({
            error: 'Bahut zyada attempts ho gaye. Thodi der (' + Math.ceil(result.retryAfterSeconds / 60) + ' minute) baad try karein.',
            errorCode: 'RATE_LIMITED',
            retryAfterSeconds: result.retryAfterSeconds,
          }),
        };
      }
    }

    try {
      return await handler(event, ctx);
    } catch (err) {
      console.error(`${functionName} failed:`, err);
      await ctx.audit({ event: 'unhandled_error', message: String((err && err.message) || err) });
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Kuch anjaani gadbad ho gayi. Thodi der baad dobara try karein.', errorCode: 'INTERNAL_ERROR' }),
      };
    }
  };
}

module.exports = { withSecurity, getFirebaseApp, corsHeaders, getClientIp };
