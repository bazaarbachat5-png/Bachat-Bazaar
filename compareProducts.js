/**
 * Bachat Bazaar - Product Comparison Assistant (Netlify Function)
 * ====================================================================
 * Customer 2-3 similar products select karke poochta hai "kaunsa lena
 * chahiye". `customerShopAssistant.js` jaisa hi do-step pattern:
 *
 *   Step 1 (CODE): Is app mein products `store/products` document ke
 *                  andar ek hi array (`value`) mein store hote hain
 *                  (`index.html` ka `KEYS.products` blob, real
 *                  per-product collection nahi). Poora array load
 *                  karke CODE khud diye gaye productIds dhoondhta hai -
 *                  sirf ASLI, dikhne-laayak products rakhta hai (jaisi
 *                  homepage par visibility rule hai: Meesho resale
 *                  products, ya sellerId na ho, ya seller product
 *                  `status==='approved'` ho - pending/rejected kabhi
 *                  compare mein nahi aate). Cheapest/highest-rated
 *                  jaisi seedhi facts bhi CODE hi nikalta hai (rating
 *                  = product ke `reviews[]` ka average, koi stored
 *                  rating field nahi hai).
 *   Step 2 (AI):   Gemini un ASLI products (name/price/category/
 *                  rating) ko dekhkar Hindi mein ek chhota comparison
 *                  + recommendation likhta hai - kabhi koi naya spec
 *                  ya product invent nahi karta.
 *
 * Agar GEMINI_API_KEY set nahi hai to bhi feature kaam karta rahta hai
 * - step 2 skip hoke seedha fetched products + code-computed
 * (cheapest/top-rated) facts return ho jaati hain, frontend khud simple
 * table dikha sakta hai.
 *
 * NOTE: `store/products` mein SAARE products ek hi array mein hote hain
 * - is function ko har request par poora doc padhna padta hai (ek
 * targeted-id query nahi ho sakta). Chhoti/medium catalog ke liye
 * theek hai.
 *
 * Auth: koi zaroorat nahi (guest browsing customer-facing hai) - sirf
 * per-IP rate limit se abuse rokte hain.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, SERVER_NOT_CONFIGURED, NOT_ENOUGH_PRODUCTS,
 *   RATE_LIMITED, INTERNAL_ERROR
 */

const { withSecurity } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MIN_PRODUCTS = 2;
const MAX_PRODUCTS = 3;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    recommendedProductId: { type: 'STRING' },
    summary: { type: 'STRING' },
  },
  required: ['recommendedProductId', 'summary'],
};

function isVisible(p) {
  // `index.html` ki homepage visibility rule jaisa hi: Meesho resale
  // products hamesha dikhte hain, apna product tabhi jab admin/seller
  // ne approve kiya ho.
  return p.type === 'meesho' || !p.sellerId || p.status === 'approved';
}

function avgRating(p) {
  const reviews = Array.isArray(p.reviews) ? p.reviews : [];
  return reviews.length ? reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length : null;
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, db } = ctx;

    let productIds;
    try { ({ productIds } = JSON.parse(event.body || '{}')); } catch (e) {}
    productIds = Array.isArray(productIds) ? [...new Set(productIds.map((id) => String(id || '').trim()).filter(Boolean))] : [];
    if (productIds.length < MIN_PRODUCTS) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Compare karne ke liye kam se kam 2 product chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }
    productIds = productIds.slice(0, MAX_PRODUCTS); // 3 se zyada bheja ho to bhi sirf pehle 3 hi compare karte hain
    if (!db) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configure nahi hai.', errorCode: 'SERVER_NOT_CONFIGURED' }) };
    }

    // ---- Step 1: CODE - `store/products` se sirf ASLI, dikhne-laayak products ----
    let allProducts;
    try {
      const snap = await db.collection('store').doc('products').get();
      allProducts = snap.exists ? (snap.data().value || []) : [];
    } catch (e) {
      console.error('Products fetch failed:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Products load nahi ho paaye.', errorCode: 'INTERNAL_ERROR' }) };
    }

    const products = productIds
      .map((id) => allProducts.find((p) => p.id === id))
      .filter((p) => p && isVisible(p))
      .map((p) => ({
        id: p.id,
        title: p.name || '',
        price: typeof p.price === 'number' ? p.price : null,
        category: p.category || '',
        rating: avgRating(p),
        description: (p.description || '').slice(0, 200),
      }));

    if (products.length < MIN_PRODUCTS) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Compare karne ke liye kam se kam 2 valid product nahi mile.', errorCode: 'NOT_ENOUGH_PRODUCTS' }) };
    }

    // ---- CODE-computed seedhe facts (AI in numbers ko kabhi na badle) ----
    const cheapest = products.reduce((a, b) => (b.price != null && (a.price == null || b.price < a.price) ? b : a));
    const topRated = products.reduce((a, b) => (b.rating != null && (a.rating == null || b.rating > a.rating) ? b : a));
    const computedFacts = {
      cheapestProductId: cheapest.price != null ? cheapest.id : null,
      topRatedProductId: topRated.rating != null ? topRated.id : null,
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ products, computedFacts }) };
    }

    // ---- Step 2: AI - sirf ASLI products dekhkar Hindi comparison ----
    let summary = null, recommendedProductId = null;
    try {
      const promptText = `Tum ek Indian e-commerce shopping assistant ho. Customer ye products compare kar raha hai (sirf inhi ke baare mein baat karna - koi naya spec ya product invent mat karna, price/rating mat badalna):

${JSON.stringify(products)}

Code se nikle ye facts bhi hain (agar relevant lage to use karo): cheapest hai "${computedFacts.cheapestProductId}", sabse zyada rated hai "${computedFacts.topRatedProductId}" (dono null bhi ho sakte hain agar data available na ho).

- recommendedProductId: in mein se jo overall sabse behtar lage uski id (in diye gaye ids mein se hi ek)
- summary: Hindi mein 2-4 friendly sentences - products ko compare karo (price/rating/category ke hisaab se) aur bataao kaunsa kis type ke customer ke liye behtar hai`;
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
          // AI ne koi ghadi hui id na de di ho - sirf diye gaye products mein se hi maanya
          recommendedProductId = products.some((p) => p.id === parsed.recommendedProductId) ? parsed.recommendedProductId : null;
          summary = parsed.summary || null;
        }
      } else {
        console.error('Gemini API error:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Product comparison failed, raw products bhej rahe hain:', e);
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ products, computedFacts, recommendedProductId, summary }) };
  },
  { functionName: 'compareProducts', methods: ['POST'], rateLimit: { limit: 40, windowMs: 60 * 60 * 1000 } }
);
