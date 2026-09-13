/**
 * Bachat Bazaar - Admin Login (Netlify Function) — Security Item #1
 * ====================================================================
 * PEHLE: admin login sirf browser mein check hota tha (username/password
 * Firestore se seedha padh ke compare), aur "logged in" hona sirf ek
 * localStorage flag { loggedIn: true } tha. Koi bhi browser console
 * kholke `localStorage.setItem('admin-session','{"loggedIn":true}')`
 * likh ke seedha admin panel access kar sakta tha - password ki bhi
 * zaroorat nahi thi.
 *
 * AB: password verify SIRF yahan, server par hota hai (Firebase Admin
 * SDK se, jo Firestore Rules ko bypass karta hai - is function ke paas
 * hi admin-secure doc padhne ki permission hai). Sahi password par ye
 * ek REAL Firebase custom token deta hai jisme { role: 'admin' } claim
 * hota hai. Frontend `firebase.auth().signInWithCustomToken(token)` karta
 * hai - ab admin ke paas ek asli request.auth session hai jise
 * firestore.rules mein check kiya ja sakta hai (isAdmin()). Sirf UI
 * flag hona ab kaafi nahi hai.
 *
 * NAYA (shared helper migration): CORS/method-check ab
 * `_shared/security.js` se aata hai, aur is par ab rate limit
 * (8 attempts / 15 minute per IP) + audit log (success/fail/rate-limit
 * har ek `audit_logs` mein) lag gaya hai - taaki koi password brute-force
 * guess na kar sake, aur agar kare to record rahe.
 *
 * One-time migration: agar admin-secure doc abhi tak nahi bana, to ye
 * function purane store-settings doc se adminUsername/Hash/Salt padhta
 * hai, verify karta hai, aur sahi hone par unhe admin-secure mein copy
 * karke store-settings se hata deta hai - bina kisi manual step ke.
 *
 * ---- Required Netlify environment variables ----
 *   FIREBASE_SERVICE_ACCOUNT_KEY  -> Firebase Console > Project Settings
 *     > Service Accounts > Generate new private key. Poora JSON file ka
 *     content ek hi line mein (ya as-is) is env var mein paste karein.
 *   ADMIN_SESSION_UID (optional)  -> default 'bachat-bazaar-admin'
 *
 * ---- errorCode values ----
 *   METHOD_NOT_ALLOWED, MISSING_CREDENTIALS, SERVER_NOT_CONFIGURED,
 *   INVALID_CREDENTIALS, RATE_LIMITED, INTERNAL_ERROR
 */

const crypto = require('crypto');
const admin = require('firebase-admin');
const { withSecurity } = require('./_shared/security');

const ADMIN_UID = process.env.ADMIN_SESSION_UID || 'bachat-bazaar-admin';

// Frontend ka `hashPassword` = sha256Hex(salt + ':' + password). Same
// algorithm yahan server par bhi - hash format compatible rehta hai.
function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}
function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, db, audit } = ctx;

    let username, password;
    try {
      ({ username, password } = JSON.parse(event.body || '{}'));
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.', errorCode: 'MISSING_CREDENTIALS' }) };
    }
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username aur password dono chahiye.', errorCode: 'MISSING_CREDENTIALS' }) };
    }

    if (!db) {
      console.error('FIREBASE_SERVICE_ACCOUNT_KEY set nahi hai. Netlify dashboard > Site settings > Environment variables mein set karein.');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server par admin login configure nahi hai. Admin ko Netlify Environment Variables check karne ko kahein.', errorCode: 'SERVER_NOT_CONFIGURED' }) };
    }

    // 1) Preferred path: naya secure doc.
    let secureRef = db.collection('store').doc('admin-secure');
    let secureSnap = await secureRef.get();
    let record = secureSnap.exists ? secureSnap.data() : null;
    let migratingFrom = null;

    // 2) Migration path: agar admin-secure abhi tak nahi bana, purane
    //    store-settings doc se credentials uthao.
    if (!record) {
      const settingsRef = db.collection('store').doc('store-settings');
      const settingsSnap = await settingsRef.get();
      const settings = settingsSnap.exists ? settingsSnap.data().value || {} : {};
      if (settings.adminUsername && settings.adminPasswordHash && settings.adminPasswordSalt) {
        record = {
          adminUsername: settings.adminUsername,
          adminPasswordHash: settings.adminPasswordHash,
          adminPasswordSalt: settings.adminPasswordSalt,
        };
        migratingFrom = settingsRef;
      } else if (settings.adminUsername && settings.adminPassword) {
        // legacy plain-password fallback (pre-hash era) - verify, then
        // migrate straight into hashed admin-secure record.
        record = { adminUsername: settings.adminUsername, adminPasswordPlain: settings.adminPassword };
        migratingFrom = settingsRef;
      }
    }

    if (!record || record.adminUsername !== username) {
      await audit({ event: 'login_failed', reason: 'unknown_username', username });
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Username ya password galat hai.', errorCode: 'INVALID_CREDENTIALS' }) };
    }

    let ok = false;
    if (record.adminPasswordHash && record.adminPasswordSalt) {
      ok = hashPassword(password, record.adminPasswordSalt) === record.adminPasswordHash;
    } else if (record.adminPasswordPlain != null) {
      ok = record.adminPasswordPlain === password;
    }
    if (!ok) {
      await audit({ event: 'login_failed', reason: 'wrong_password', username });
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Username ya password galat hai.', errorCode: 'INVALID_CREDENTIALS' }) };
    }

    // Password sahi hai. Agar migration pending thi, ab poora karo:
    // admin-secure mein hashed record likho, store-settings se secrets hatao.
    if (migratingFrom) {
      const salt = record.adminPasswordSalt || genSalt();
      const hash = record.adminPasswordHash || hashPassword(password, salt);
      await secureRef.set({ adminUsername: record.adminUsername, adminPasswordHash: hash, adminPasswordSalt: salt });
      await migratingFrom.update({
        'value.adminPassword': admin.firestore.FieldValue.delete(),
        'value.adminPasswordHash': admin.firestore.FieldValue.delete(),
        'value.adminPasswordSalt': admin.firestore.FieldValue.delete(),
      });
      await audit({ event: 'admin_secure_migrated', username });
    }

    const token = await admin.auth().createCustomToken(ADMIN_UID, { role: 'admin' });
    await audit({ event: 'login_success', username });
    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) };
  },
  {
    functionName: 'adminLogin',
    methods: ['POST'],
    rateLimit: { limit: 8, windowMs: 15 * 60 * 1000 }, // 8 attempts / 15 min per IP
  }
);
