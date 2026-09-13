/**
 * Bachat Bazaar - AI Style Advisor (Netlify Function)
 * =========================================================
 * Existing Selfie Try-On (generateTryOnImage.js) ke Gemini setup ko
 * aage badhate hue — ye function ek product ki photo + naam + category
 * leta hai aur Gemini se structured (JSON) styling suggestions laata
 * hai: blouse/top pairing, jewellery, footwear, hairstyle, occasion.
 *
 * API key kabhi is file mein nahi likhi jaati — wo Netlify dashboard
 * ke "Environment variables" section mein GEMINI_API_KEY naam se set
 * hoti hai (Site settings > Environment variables > Add a variable).
 * Selfie Try-On wala hi API key yahan bhi reuse hota hai.
 *
 * NAYA (shared helper migration): CORS/method-check ab
 * `_shared/security.js` se aata hai, aur is par ab rate limit
 * (20 requests / hour per IP) lag gaya hai - taaki koi Gemini ka free
 * quota jaan-boojh kar burn na kar sake. Agar FIREBASE_SERVICE_ACCOUNT_KEY
 * set nahi hai (rare/dev case) to rate-limit/audit fail-open ho jaata
 * hai (feature kaam karta rehta hai, bas throttle nahi lagta) - is
 * function ke liye Firestore "nice to have" hai, "must have" nahi.
 *
 * ---- Error handling ----
 * Har error response mein `errorCode` field bhi aata hai, taaki
 * frontend alag situation ke liye alag Hindi message dikha sake.
 * Possible errorCode values:
 *   MISSING_NAME        -> productName nahi bheja gaya
 *   IMAGE_TOO_LARGE      -> payload Netlify ki size-limit se bada hai
 *   API_KEY_MISSING      -> GEMINI_API_KEY env var set nahi hai
 *   QUOTA_EXCEEDED       -> Gemini ka daily/per-minute free quota khatam
 *   RATE_LIMITED         -> is IP ne bahut zyada requests bhej di
 *   GEMINI_API_ERROR     -> Gemini ne kuch aur error diya
 *   PARSE_FAILED         -> Gemini ka jawaab expected JSON format mein nahi tha
 *   INTERNAL_ERROR       -> koi anjaani/unexpected problem
 */

const { withSecurity } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_BODY_BYTES = 5.5 * 1024 * 1024;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    top_pairing: { type: 'STRING' },
    jewellery: { type: 'STRING' },
    footwear: { type: 'STRING' },
    hairstyle: { type: 'STRING' },
    occasion: { type: 'STRING' },
    quick_tip: { type: 'STRING' },
  },
  required: ['top_pairing', 'jewellery', 'footwear', 'hairstyle', 'occasion', 'quick_tip'],
};

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, audit } = ctx;

    const rawBody = event.body || '';
    const approxBytes = event.isBase64Encoded
      ? Math.ceil(rawBody.length * 0.75)
      : Buffer.byteLength(rawBody, 'utf8');
    if (approxBytes > MAX_BODY_BYTES) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'Product photo bahut badi hai.', errorCode: 'IMAGE_TOO_LARGE' }),
      };
    }

    const { productImage, productName, category, description } = JSON.parse(rawBody || '{}');
    if (!productName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Product ka naam nahi mila.', errorCode: 'MISSING_NAME' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('GEMINI_API_KEY set nahi hai. Netlify dashboard > Site settings > Environment variables mein set karein.');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Server par API Key set nahi hai. Admin ko Netlify Environment Variables check karne ko kahein.', errorCode: 'API_KEY_MISSING' }),
      };
    }

    const promptText = `Tum ek Indian fashion stylist ho. Neeche diye gaye product ke liye styling suggestions do.
Product ka naam: ${productName}
Category: ${category || 'N/A'}
Description: ${description || 'N/A'}

Har field mein sirf Hindi (Devanagari script) mein, 1-2 chhote sentences ka practical, specific suggestion do — generic baatein mat likho:
- top_pairing: is product ke saath kaunsa blouse/top/kurta pehna jaaye (color/style ke saath)
- jewellery: kaunsi jewellery (necklace/earrings/bangles) suit karegi
- footwear: kaunse footwear ke saath best lagega
- hairstyle: kaunsa hairstyle is look ko complete karega
- occasion: ye kis occasion/event ke liye best suit karta hai
- quick_tip: ek extra styling tip (jaise layering, accessories, ya color combination)`;

    const parts = [{ text: promptText }];
    if (productImage) {
      try {
        parts.push(await toInlinePart(productImage));
      } catch (imgErr) {
        console.error('Product image load failed, text-only continue:', imgErr);
      }
    }

    let geminiRes;
    try {
      geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
      });
    } catch (netErr) {
      console.error('Gemini ko request bhejne mein network error:', netErr);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Gemini AI se connect nahi ho paaya. Thodi der baad try karein.', errorCode: 'GEMINI_API_ERROR' }),
      };
    }

    if (geminiRes.status === 429) {
      await audit({ event: 'quota_exceeded' });
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ error: 'Aaj ka free quota khatam ho gaya hai. Kal dobara try karein.', errorCode: 'QUOTA_EXCEEDED' }),
      };
    }
    if (geminiRes.status === 401 || geminiRes.status === 403) {
      const errText = await geminiRes.text();
      console.error('Gemini API key invalid/forbidden:', geminiRes.status, errText);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'API Key sahi nahi hai. Netlify mein GEMINI_API_KEY dobara check karein.', errorCode: 'API_KEY_MISSING' }),
      };
    }
    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', geminiRes.status, errText);
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Gemini se suggestion nahi mili (server error). Thodi der baad try karein.', errorCode: 'GEMINI_API_ERROR' }),
      };
    }

    const data = await geminiRes.json();
    const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
    if (!textPart) {
      console.error('Gemini response mein text nahi mila:', JSON.stringify(data).slice(0, 500));
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Suggestion nahi mil paayi. Dobara try karein.', errorCode: 'PARSE_FAILED' }),
      };
    }

    let advice;
    try {
      advice = JSON.parse(textPart.text);
    } catch (parseErr) {
      console.error('JSON parse failed:', textPart.text.slice(0, 500));
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'Suggestion galat format mein aayi. Dobara try karein.', errorCode: 'PARSE_FAILED' }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ advice }),
    };
  },
  {
    functionName: 'generateStyleAdvice',
    methods: ['POST'],
    rateLimit: { limit: 20, windowMs: 60 * 60 * 1000 }, // 20 requests / hour per IP
  }
);

/* data:image/...;base64,... string ko Gemini API ke liye chahiye
   format { inlineData: { mimeType, data } } mein badalta hai. */
async function toInlinePart(dataUrlOrString) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrlOrString);
  if (match) {
    return { inlineData: { mimeType: match[1], data: match[2] } };
  }
  const resp = await fetch(dataUrlOrString);
  if (!resp.ok) throw new Error('Image fetch failed: ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  const mimeType = resp.headers.get('content-type') || 'image/jpeg';
  return { inlineData: { mimeType, data: buf.toString('base64') } };
}
