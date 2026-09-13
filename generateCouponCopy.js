/**
 * Bachat Bazaar - Coupon Copy Generator (ADMIN ONLY, Netlify Function)
 * ====================================================================
 * `generateBannerCopy.js` jaisa hi admin-only pattern (`requireAdmin`),
 * par simpler - koi Firestore data fetch nahi karta, seedha admin ke
 * diye hue coupon code/discount se copy banata hai. Admin naya coupon
 * banata hai (jaise code "SALE20", 20% off), ye function catchy naam
 * (headline) + ek-line description ke 3 variants suggest karta hai,
 * taaki har coupon manually likhna na pade.
 *
 * IMPORTANT: ye function khud koi coupon Firestore mein CREATE/SAVE
 * nahi karta - sirf copy suggest karta hai. Admin apne existing
 * "coupon create" form mein se jo variant pasand aaye wo select/paste
 * karke khud save karega (jo already admin-only write path hai) - koi
 * bhi cheez seedha AI se live coupon nahi ban jaati.
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

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { headline: { type: 'STRING' }, description: { type: 'STRING' } },
        required: ['headline', 'description'],
      },
    },
  },
  required: ['suggestions'],
};

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, audit } = ctx;
    getFirebaseApp();

    let idToken, code, discountText, category, occasion;
    try { ({ idToken, code, discountText, category, occasion } = JSON.parse(event.body || '{}')); } catch (e) {}
    const decoded = await requireAdmin(idToken);
    if (!decoded) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sirf admin ye feature use kar sakta hai.', errorCode: 'UNAUTHORIZED' }) };
    }
    code = (code || '').trim().slice(0, 40);
    discountText = (discountText || '').trim().slice(0, 60);
    category = (category || '').trim().slice(0, 60);
    occasion = (occasion || '').trim().slice(0, 60);
    if (!code && !discountText) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Coupon code ya discount detail chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server par API Key set nahi hai.', errorCode: 'API_KEY_MISSING' }) };
    }

    const promptText = `Tum ek Indian e-commerce marketplace ke liye coupon-copy writer ho. Admin ne ye ASLI coupon detail di hai (in facts ko badalna mat - koi extra discount/condition invent mat karna):

Coupon code: ${code || 'N/A'}
Discount: ${discountText || 'N/A'}
${category ? `Category (agar specific hai): ${category}` : ''}
${occasion ? `Occasion/sale: ${occasion}` : ''}

3 ALAG variants do (Hindi, Devanagari script), har ek mein:
- headline: chhota, catchy naam/banner-line (6-8 words max) jo coupon ko highlight kare
- description: 1 chhoti line jo customer ko batae kya offer hai (discount % ya amount jo diya gaya hai wahi use karo, naya number mat banana)

Generic "Best Offer!" jaisa mat likhna - diya gaya discount/code/category/occasion use karke specific banao.`;

    let suggestions = [];
    try {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA } }),
      });
      if (res.status === 429) {
        await audit({ event: 'quota_exceeded' });
        return { statusCode: 429, headers, body: JSON.stringify({ error: 'Aaj ka free quota khatam ho gaya hai. Kal dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
      }
      if (!res.ok) {
        console.error('Gemini API error:', res.status, await res.text());
        return { statusCode: 502, headers, body: JSON.stringify({ error: 'Coupon copy generate nahi ho paayi. Dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
      }
      const data = await res.json();
      const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
      if (textPart) suggestions = (JSON.parse(textPart.text).suggestions) || [];
    } catch (e) {
      console.error('Coupon copy generation failed:', e);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Coupon copy generate nahi ho paayi. Dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ suggestions }) };
  },
  { functionName: 'generateCouponCopy', methods: ['POST'], rateLimit: { limit: 20, windowMs: 60 * 60 * 1000 } }
);
