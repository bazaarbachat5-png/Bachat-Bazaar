/**
 * Bachat Bazaar - Typo-Tolerant Search Helper (Netlify Function)
 * ====================================================================
 * `customerShopAssistant.js` ke "Step 1" (query -> filters) ka hi ek
 * chhota, standalone version - jab customer sirf ek search box mein
 * Hindi/Hinglish mein galat spelling se search kare (jaise "saaree" ya
 * "sadi" ya "kurtaa"), ye function query ko normalize karke keywords +
 * synonyms nikal deta hai, jo frontend phir Firestore products search
 * mein use karta hai.
 *
 * IMPORTANT: ye khud koi Firestore query nahi chalata aur koi product
 * return nahi karta - sirf query ko behtar/normalize karta hai. Actual
 * ASLI product search hamesha CODE-side Firestore query se hi hoti hai
 * (jaise customerShopAssistant mein) - ye function sirf uska pehla step
 * hai, taaki chhoti spelling mistakes ki wajah se "0 results" na aaye.
 *
 * GEMINI_API_KEY na ho tab bhi search kaam karta rahta hai - fallback
 * mein original query hi lowercase/trimmed keywords ban jaati hai (koi
 * spelling-correction nahi hoti, par search rukta nahi).
 *
 * Auth: koi zaroorat nahi (guest browsing/search customer-facing hai) -
 * sirf per-IP rate limit se abuse rokte hain.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, RATE_LIMITED, INTERNAL_ERROR
 */

const { withSecurity, getFirebaseApp } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    normalized_query: { type: 'STRING' },
    category_guess: { type: 'STRING' },
    keywords: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['normalized_query', 'category_guess', 'keywords'],
};

function fallbackNormalize(query) {
  const stopwords = new Set(['ke', 'ki', 'ka', 'liye', 'chahiye', 'tak', 'mein', 'se', 'kam', 'under', 'for', 'a', 'the']);
  const keywords = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopwords.has(w));
  return { normalized_query: query.trim(), category_guess: '', keywords: keywords.length ? keywords : [query.trim().toLowerCase()] };
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers } = ctx;
    getFirebaseApp();

    let query;
    try { ({ query } = JSON.parse(event.body || '{}')); } catch (e) {}
    if (!query || !query.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Kya dhoondh rahe hain, likhein.', errorCode: 'MISSING_FIELDS' }) };
    }
    query = query.trim().slice(0, 200);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify(fallbackNormalize(query)) };
    }

    let result = fallbackNormalize(query);
    try {
      const promptText = `Tum ek Indian e-commerce marketplace ke search-query normalizer ho. Customer ne search box mein ye likha hai (spelling galat ho sakti hai, Hindi/Hinglish/mix ho sakta hai):
Query: "${query}"

- normalized_query: sahi-spelling wala, standard (English/Hinglish) chhota search phrase jo isi cheez ko refer karta ho (jaise "saaree"/"sadi" -> "saree", "kurtaa" -> "kurta")
- category_guess: agar product category clearly pata chalti hai (jaise "saree", "kurta", "shoes", "watch"), warna khali string - guess mat thoko agar spasht nahi hai
- keywords: 2-6 search keywords/synonyms jo Firestore text-match mein madad karein (English spelling mein, common synonyms shamil karo agar relevant hon)

Kisi bhi naye product ka zikar mat karna, sirf query ko samajhkar behtar search-terms do.`;
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA } }),
      });
      if (res.ok) {
        const data = await res.json();
        const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
        if (textPart) {
          const parsed = JSON.parse(textPart.text);
          result = {
            normalized_query: parsed.normalized_query || query,
            category_guess: parsed.category_guess || '',
            keywords: (parsed.keywords && parsed.keywords.length) ? parsed.keywords : fallbackNormalize(query).keywords,
          };
        }
      } else {
        console.error('Gemini API error:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Query normalize failed, fallback keywords use ho rahe hain:', e);
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  },
  { functionName: 'normalizeSearchQuery', methods: ['POST'], rateLimit: { limit: 60, windowMs: 60 * 60 * 1000 } }
);
