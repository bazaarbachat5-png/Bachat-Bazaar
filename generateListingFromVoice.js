/**
 * Bachat Bazaar - Voice-to-Listing (Netlify Function)
 * ====================================================================
 * `generateProductListing.js` jaisa hi structured-output pattern, par
 * input photo/keywords ke bajaye seller ki VOICE RECORDING hai. Seller
 * apni bhasha mein bol deta hai (jaise "ye laal saree hai, silk ki, 500
 * rupaye ki") aur Gemini (jo audio input bhi le sakta hai) usse
 * structured title + description mein badal deta hai - un sellers ke
 * liye helpful jo type karne mein comfortable nahi hain.
 *
 * IMPORTANT: seller jo bhi bola usi se listing banti hai - koi extra
 * cheez invent nahi hoti. Seller ko hamesha `transcript` bhi wapas
 * milta hai taaki wo check kar sake AI ne sahi suna ya nahi, aur final
 * text edit karke hi save kare - ye seedha publish nahi karta.
 *
 * AUDIO HANDLING: `moderateProduct.js` jaisा hi safe pattern - sirf
 * `data:...;base64,...` URI accept hoti hai (audio/webm, audio/mp3,
 * audio/wav, audio/ogg, waghera), koi arbitrary URL kabhi fetch nahi
 * hoti.
 *
 * Auth: koi bhi signed-in user (seller) - idToken verify hota hai,
 * role check nahi, taaki koi anjaan script Gemini quota burn na kare.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, UNAUTHORIZED, AUDIO_TOO_LARGE, API_KEY_MISSING,
 *   GEMINI_API_ERROR, PARSE_FAILED, RATE_LIMITED, INTERNAL_ERROR
 */

const admin = require('firebase-admin');
const { withSecurity, getFirebaseApp } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // audio clips photo se thoda bada ho sakte hain

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    transcript: { type: 'STRING' },
    title_hi: { type: 'STRING' },
    title_en: { type: 'STRING' },
    description_hi: { type: 'STRING' },
    description_en: { type: 'STRING' },
    price_guess: { type: 'NUMBER' },
    category_guess: { type: 'STRING' },
    suggested_keywords: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['transcript', 'title_hi', 'title_en', 'description_hi', 'description_en', 'suggested_keywords'],
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
      return { statusCode: 413, headers, body: JSON.stringify({ error: 'Recording bahut badi hai.', errorCode: 'AUDIO_TOO_LARGE' }) };
    }

    let idToken, voiceNote;
    try {
      ({ idToken, voiceNote } = JSON.parse(rawBody || '{}'));
    } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.', errorCode: 'MISSING_FIELDS' }) };
    }
    try {
      if (!idToken) throw new Error('no token');
      await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Login zaroori hai.', errorCode: 'UNAUTHORIZED' }) };
    }

    const match = voiceNote && /^data:(.+?);base64,(.+)$/.exec(voiceNote);
    if (!match) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ek voice recording chahiye (data URI format mein).', errorCode: 'MISSING_FIELDS' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server par API Key set nahi hai.', errorCode: 'API_KEY_MISSING' }) };
    }

    const promptText = `Tum ek Indian e-commerce marketplace ke liye product-listing assistant ho. Neeche di gayi seller ki VOICE RECORDING suno - seller ismein apna product describe kar raha hai (Hindi/Hinglish ya kisi bhi Indian bhasha mein bol sakta hai).

Sirf wahi likho jo seller ne bola hai - kuch bhi guess karke fact ki tarah mat likhna, aur koi jhoothi/exaggerated claim mat banana (jaise "100% best" ya fake guarantee).

Output:
- transcript: seller ne jo bola usko jaisa-ka-taisa likh do (jis bhasha/script mein bola gaya lage usi mein, ya Hindi mein agar mix hai) - taaki seller check kar sake AI ne sahi suna
- title_hi / title_en: chhota, clear, searchable title
- description_hi / description_en: 2-4 sentences, sirf recording mein bataye gaye details (material/color/use-case waghera)
- price_guess: agar seller ne koi price bola hai (rupees mein number), warna is field ko chhod do (mat likho)
- category_guess: agar bhasha se andaza lagta hai (jaise "saree", "kurta"), warna khali string
- suggested_keywords: 3-6 relevant search keywords`;

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
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Gemini AI se connect nahi ho paaya. Thodi der baad try karein.', errorCode: 'GEMINI_API_ERROR' }) };
    }
    if (geminiRes.status === 429) {
      await audit({ event: 'quota_exceeded' });
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Aaj ka free quota khatam ho gaya hai. Kal dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
    }
    if (!geminiRes.ok) {
      console.error('Gemini API error:', geminiRes.status, await geminiRes.text());
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Listing generate nahi ho paayi. Dobara try karein.', errorCode: 'GEMINI_API_ERROR' }) };
    }

    const data = await geminiRes.json();
    const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
    if (!textPart) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Listing generate nahi ho paayi. Dobara try karein.', errorCode: 'PARSE_FAILED' }) };
    }
    let listing;
    try {
      listing = JSON.parse(textPart.text);
    } catch (e) {
      console.error('JSON parse failed:', textPart.text.slice(0, 500));
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Listing galat format mein aayi. Dobara try karein.', errorCode: 'PARSE_FAILED' }) };
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ listing }) };
  },
  { functionName: 'generateListingFromVoice', methods: ['POST'], rateLimit: { limit: 20, windowMs: 60 * 60 * 1000 } }
);
