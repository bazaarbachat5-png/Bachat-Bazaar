/**
 * Bachat Bazaar - Seller KYC Document Pre-Check (Netlify Function)
 * ====================================================================
 * Naya seller apna Aadhar/PAN/GST photo upload karta hai signup ke waqt.
 * `checkPhotoQuality.js` jaisa hi image-analysis setup use karta hai,
 * par kaam hai: sirf ye dekhna ki naam/number CLEARLY READABLE hai ya
 * nahi, photo blurry/glare/crop to nahi - taaki admin approval queue
 * mein pehle se hi kharab photo wapas na bhejni pade, aur admin ka time
 * bache.
 *
 * IMPORTANT - YE FINAL VERIFICATION NAHI HAI:
 *   - Ye function KABHI seller ko approve/reject nahi karta.
 *   - Ye sirf ek "pehli nazar" readability check hai - admin panel mein
 *     ye photo hamesha jaati hai aur ASLI approval/reject FAISLA hamesha
 *     ek insaan (admin) hi leta hai.
 *   - Ye kabhi bhi document number ko poora extract/store/log nahi karta
 *     (privacy) - sirf ye batata hai ki number "readable hai ya nahi",
 *     khud number kahin bhi return/save nahi hota.
 *   - Seller signup flow kabhi is wajah se nahi rukta ki AI unavailable
 *     hai - key na ho ya Gemini fail ho to bhi generic "admin dekh
 *     lenge" jaisa graceful message deke aage badhne dete hain.
 *
 * IMAGE HANDLING: `moderateProduct.js` jaisa hi - sirf `data:...;base64,...`
 * URI accept hoti hai, koi arbitrary URL kabhi fetch nahi hoti.
 *
 * Auth: signed-in user (naya seller signup flow mein already logged-in
 * hota hai) - idToken verify hota hai, role check nahi.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, UNAUTHORIZED, IMAGE_TOO_LARGE, RATE_LIMITED,
 *   INTERNAL_ERROR
 */

const admin = require('firebase-admin');
const { withSecurity, getFirebaseApp } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_BODY_BYTES = 5.5 * 1024 * 1024;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    document_type_guess: { type: 'STRING', enum: ['aadhar', 'pan', 'gst', 'other', 'unclear'] },
    readable: { type: 'STRING', enum: ['yes', 'partial', 'no'] },
    name_visible: { type: 'BOOLEAN' },
    number_visible: { type: 'BOOLEAN' },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
    tips: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['document_type_guess', 'readable', 'name_visible', 'number_visible', 'issues', 'tips'],
};

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, audit } = ctx;
    getFirebaseApp();

    const rawBody = event.body || '';
    const approxBytes = event.isBase64Encoded
      ? Math.ceil(rawBody.length * 0.75)
      : Buffer.byteLength(rawBody, 'utf8');
    if (approxBytes > MAX_BODY_BYTES) {
      return { statusCode: 413, headers, body: JSON.stringify({ error: 'File bahut badi hai.', errorCode: 'IMAGE_TOO_LARGE' }) };
    }

    let idToken, documentImage;
    try {
      ({ idToken, documentImage } = JSON.parse(rawBody || '{}'));
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.', errorCode: 'MISSING_FIELDS' }) };
    }
    try {
      if (!idToken) throw new Error('no token');
      await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Login zaroori hai.', errorCode: 'UNAUTHORIZED' }) };
    }

    const match = documentImage && /^data:(.+?);base64,(.+)$/.exec(documentImage);
    if (!match) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ek document photo chahiye (data URI format mein).', errorCode: 'MISSING_FIELDS' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      // Pre-check "nice to have" hai - key na ho to seedha admin queue
      // mein jaane do, signup flow yahan kabhi nahi rukta.
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          document_type_guess: 'unclear', readable: 'yes', name_visible: true, number_visible: true,
          issues: [], tips: ['AI pehli-nazar check abhi available nahi hai - aapka document seedha admin ke paas review ke liye jaa raha hai.'],
        }),
      };
    }

    const promptText = `Tum ek e-commerce marketplace ke seller-onboarding team ke liye ek "pehli nazar" document readability checker ho. Ye Aadhar/PAN/GST jaisa koi ID document ki photo hai.

SIRF ye check karo (kabhi bhi document ka poora naam ya number apne output mein mat likhna/repeat karna - sirf ye batao ki wo VISIBLE/readable hai ya nahi):
- document_type_guess: photo dekhkar lagta hai ye "aadhar", "pan", "gst", "other", ya "unclear" hai
- readable: poori tarah readable hai ("yes"), kuch hissa readable hai ("partial"), ya nahi ("no")
- name_visible: naam ka field clearly padha ja sakta hai kya (true/false) - naam khud mat likhna
- number_visible: ID number ka field clearly padha ja sakta hai kya (true/false) - number khud mat likhna
- issues: kya dikkat hai (jaise "blurry", "glare/chamak hai", "corner kata hua hai", "andhera hai") - Hindi mein chhote points
- tips: 1-2 practical Hindi sujhaav behtar photo lene ke liye (agar sab theek hai to khali array ya ek chhota encouragement)

Yaad rakho: tumhara kaam sirf photo QUALITY/readability judge karna hai, koi identity/eligibility verify karna nahi - final verification hamesha ek insaan (admin) karega.`;

    const parts = [{ text: promptText }, { inlineData: { mimeType: match[1], data: match[2] } }];

    let geminiRes;
    try {
      geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA } }),
      });
    } catch (netErr) {
      console.error('Gemini network error:', netErr);
      return { statusCode: 200, headers, body: JSON.stringify({ document_type_guess: 'unclear', readable: 'yes', name_visible: true, number_visible: true, issues: [], tips: ['Pre-check fail hua (network) - aapka document seedha admin review mein jaa raha hai.'] }) };
    }
    if (geminiRes.status === 429) {
      await audit({ event: 'quota_exceeded' });
      return { statusCode: 200, headers, body: JSON.stringify({ document_type_guess: 'unclear', readable: 'yes', name_visible: true, number_visible: true, issues: [], tips: ['Aaj ka free quota khatam ho gaya hai - aapka document seedha admin review mein jaa raha hai.'] }) };
    }
    if (!geminiRes.ok) {
      console.error('Gemini API error:', geminiRes.status, await geminiRes.text());
      return { statusCode: 200, headers, body: JSON.stringify({ document_type_guess: 'unclear', readable: 'yes', name_visible: true, number_visible: true, issues: [], tips: ['Pre-check fail hua - aapka document seedha admin review mein jaa raha hai.'] }) };
    }

    const data = await geminiRes.json();
    const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
    let result = { document_type_guess: 'unclear', readable: 'yes', name_visible: true, number_visible: true, issues: [], tips: [] };
    try { if (textPart) result = JSON.parse(textPart.text); } catch (e) { /* keep default - admin dekh lega */ }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  },
  { functionName: 'checkKycDocument', methods: ['POST'], rateLimit: { limit: 20, windowMs: 60 * 60 * 1000 } }
);
