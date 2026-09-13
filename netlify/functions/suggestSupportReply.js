/**
 * Bachat Bazaar - Support Draft Reply Suggestion (ADMIN ONLY, Netlify Function)
 * ====================================================================
 * `generateBannerCopy.js` jaisा hi admin-only pattern (`requireAdmin`).
 * Admin ke paas jab customer/seller ka support message aata hai, ye
 * function ek DRAFT Hindi reply suggest karta hai jise admin edit
 * karke khud bhejta hai.
 *
 * IMPORTANT: ye function KABHI khud message send/email/notify nahi
 * karta - sirf ek suggested draft text return karta hai. Actual bhejna
 * hamesha admin ke apne support-panel "Send" button se hota hai (jo
 * already admin-only write/action path hai) - koi bhi cheez seedha AI
 * se customer ko nahi jaati, insaan hi final call leta hai aur alfaaz
 * edit kar sakta hai.
 *
 * Auth: sirf ADMIN (requireAdmin) - ye internal admin tool hai.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, UNAUTHORIZED, API_KEY_MISSING, GEMINI_API_ERROR,
 *   PARSE_FAILED, RATE_LIMITED, INTERNAL_ERROR
 */

const { withSecurity, getFirebaseApp, requireAdmin } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_MESSAGE_CHARS = 4000;

// category diya jaaye to (triageSupportMessage.js se) tone thodi tune ho
// jaati hai - warna generic helpful tone use hoti hai.
const CATEGORY_TONE = {
  'urgent-refund': 'Customer refund/paise ko lekar pareshan hai - reassuring tone rakho, clear next-step batao (jaise refund kitne din mein process hoga), koi jhoothi timeline commitment mat do jo pata na ho.',
  'delivery-issue': 'Delivery se related shikayat hai - order/tracking status ke baare mein politely poochho ya update do, apology genuine rakho, over-promise mat karo.',
  'general-query': 'Ek general sawaal/query hai - seedha, friendly, helpful jawab do.',
};

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, audit } = ctx;
    getFirebaseApp();

    let idToken, message, category, senderName;
    try { ({ idToken, message, category, senderName } = JSON.parse(event.body || '{}')); } catch (e) {}
    const decoded = await requireAdmin(idToken);
    if (!decoded) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sirf admin ye feature use kar sakta hai.', errorCode: 'UNAUTHORIZED' }) };
    }
    if (!message || !message.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Original support message chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }
    message = message.trim().slice(0, MAX_MESSAGE_CHARS);
    senderName = (senderName || '').trim().slice(0, 80);
    const toneNote = CATEGORY_TONE[category] || CATEGORY_TONE['general-query'];

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server par API Key set nahi hai.', errorCode: 'API_KEY_MISSING' }) };
    }

    const promptText = `Tum ek Indian e-commerce marketplace ke support team ke liye reply-drafting assistant ho. Neeche customer/seller ka original message hai:

"${message}"
${senderName ? `\n(Bhejne wale ka naam: ${senderName})` : ''}

${toneNote}

Ek DRAFT Hindi reply likho jo admin edit karke bheje ga (isliye placeholder-style rakho jahan zaroori ho, jaise order number ya exact refund date - admin khud bharega):
- Polite, warm, professional tone
- 3-5 sentences se zyada lamba mat karo
- Koi bhi cheez promise mat karo jo tumhe pata nahi (jaise exact refund date, ya "guaranteed" jaisi baat) - agar zaroori ho to "hum jald hi update karenge" jaisा phrase use karo
- Customer/seller ke asli message ka seedha jawab do, generic template mat lagna`;

    let draftReply = '';
    try {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
      });
      if (res.status === 429) {
        await audit({ event: 'quota_exceeded' });
        return { statusCode: 429, headers, body: JSON.stringify({ error: 'Aaj ka free quota khatam ho gaya hai. Kal dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
      }
      if (!res.ok) {
        console.error('Gemini API error:', res.status, await res.text());
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Draft reply generate nahi ho paayi. Dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
      }
      const data = await res.json();
      const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
      if (!textPart) {
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Draft reply generate nahi ho paayi. Dobara try karein.', errorCode: 'PARSE_FAILED' }) };
      }
      draftReply = textPart.text.trim();
    } catch (e) {
      console.error('Draft reply generation failed:', e);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Draft reply generate nahi ho paayi. Dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ draftReply }) };
  },
  { functionName: 'suggestSupportReply', methods: ['POST'], rateLimit: { limit: 60, windowMs: 60 * 60 * 1000 } }
);
