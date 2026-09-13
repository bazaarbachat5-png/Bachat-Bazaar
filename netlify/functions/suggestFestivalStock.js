/**
 * Bachat Bazaar - Festival/Seasonal Stock Suggestion (Netlify Function)
 * ====================================================================
 * Seller dashboard mein button dabata hai - "aane wale festival ke
 * liye kya stock badhaayein". `adminLogin.js`/`index.html` jaisa hi
 * asli data-shape follow karta hai:
 *
 *   Step 1 (CODE): Agla upcoming festival CODE se ek chhoti, hardcoded
 *                  calendar se nikalta hai (`estimateDeliveryTime.js`
 *                  jaisa hi "reasonable default" heuristic - koi real
 *                  panchang/festival API se juda nahi hai). Seller ki
 *                  pehchaan idToken se hoti hai, aur `store/sellers`
 *                  array mein us `firebaseUid` wale seller record se
 *                  match ki jaati hai. Isi seller ke `store/orders` aur
 *                  `store/products` array se (in-memory) category-wise
 *                  sales CODE khud tally karta hai (sirf ISI seller ka
 *                  data).
 *   Step 2 (AI):   Gemini un ASLI numbers (top-selling categories +
 *                  upcoming festival) ko dekhkar Hindi mein chhoti
 *                  stock-suggestion likhta hai - koi sales number khud
 *                  invent nahi karta, sirf general festival-shopping
 *                  knowledge (jaise "Diwali mein decor/lights zyada
 *                  bikte hain") us par apply karta hai.
 *
 * SELLER IDENTIFICATION: `index.html` mein sellerSession sirf ek local
 * `{id}` hai, Firebase Auth se seedha nahi juda - par jab seller Mobile
 * OTP se login/register karta hai, uske `sellers` record mein
 * `firebaseUid` save ho jaata hai (README-HI.txt: "Seller Mobile OTP
 * Update" dekhein). Ye function isi `firebaseUid` se idToken ko ASLI
 * seller record se match karta hai. Jo seller abhi bhi sirf legacy
 * email/password se login karta hai (kabhi OTP se login nahi kiya),
 * uska koi `firebaseUid` nahi hoga aur ye feature use nahi kar
 * paayega - unhe ek baar Mobile OTP se login karna hoga.
 *
 * NOTE: Hindu/Muslim festivals lunar calendar follow karte hain, isliye
 * FESTIVAL_CALENDAR neeche 2026 ke liye hardcoded dates hai - agle saal
 * in dates ko update karna hoga (ya seller khud `occasion` field mein
 * koi bhi custom occasion/sale ka naam bhej sakta hai, jaise
 * `generateBannerCopy.js` mein).
 *
 * IMPORTANT: ye sirf ek SUGGESTION hai, seller khud decide karta hai
 * kitna stock badhana hai - ye kabhi inventory/stock count seedha
 * badal/save nahi karta.
 *
 * Auth: koi bhi signed-in (Mobile OTP se) seller - idToken verify hota
 * hai, role check nahi, sellerId client se NAHI aata - idToken ke uid
 * se `store/sellers` mein match karke hi sellerId nikala jaata hai.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, UNAUTHORIZED, SERVER_NOT_CONFIGURED,
 *   NO_UPCOMING_FESTIVAL, RATE_LIMITED, INTERNAL_ERROR
 */

const admin = require('firebase-admin');
const { withSecurity } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const LOOKAHEAD_DAYS = 60; // itne din aage tak ka agla festival dhoondhte hain
const SALES_WINDOW_DAYS = 90; // pichle itne din ka category-wise sales data

// 2026 ke liye approximate dates (source: panchang-based calendars) -
// agle saal isse update karna hoga.
const FESTIVAL_CALENDAR = [
  { name: 'Makar Sankranti', date: '2026-01-14' },
  { name: 'Holi', date: '2026-03-04' },
  { name: 'Raksha Bandhan', date: '2026-08-28' },
  { name: 'Janmashtami', date: '2026-09-04' },
  { name: 'Ganesh Chaturthi', date: '2026-09-14' },
  { name: 'Navratri', date: '2026-10-11' },
  { name: 'Dussehra', date: '2026-10-20' },
  { name: 'Karva Chauth', date: '2026-10-29' },
  { name: 'Dhanteras', date: '2026-11-06' },
  { name: 'Diwali', date: '2026-11-08' },
  { name: 'Bhai Dooj', date: '2026-11-11' },
  { name: 'Christmas', date: '2026-12-25' },
];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intro: { type: 'STRING' },
    suggestions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { category: { type: 'STRING' }, tip: { type: 'STRING' } },
        required: ['category', 'tip'],
      },
    },
  },
  required: ['intro', 'suggestions'],
};

function findUpcomingFestival(now) {
  const cutoff = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const upcoming = FESTIVAL_CALENDAR
    .map((f) => ({ ...f, dateObj: new Date(f.date + 'T00:00:00') }))
    .filter((f) => f.dateObj >= now && f.dateObj <= cutoff)
    .sort((a, b) => a.dateObj - b.dateObj);
  return upcoming[0] || null;
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, db } = ctx;

    let idToken, occasion;
    try { ({ idToken, occasion } = JSON.parse(event.body || '{}')); } catch (e) {}
    occasion = (occasion || '').trim().slice(0, 60); // custom occasion diya ho to calendar ke bajaye ye use hota hai

    let decoded;
    try {
      if (!idToken) throw new Error('no token');
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Login zaroori hai.', errorCode: 'UNAUTHORIZED' }) };
    }
    if (!db) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configure nahi hai.', errorCode: 'SERVER_NOT_CONFIGURED' }) };
    }

    // ---- Seller resolve: idToken.uid -> `store/sellers` mein firebaseUid match ----
    let sellersSnap;
    try {
      sellersSnap = await db.collection('store').doc('sellers').get();
    } catch (e) {
      console.error('Sellers fetch failed:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Seller data load nahi ho paaya.', errorCode: 'INTERNAL_ERROR' }) };
    }
    const sellers = sellersSnap.exists ? (sellersSnap.data().value || []) : [];
    const seller = sellers.find((s) => s.firebaseUid === decoded.uid);
    if (!seller) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Seller account nahi mila. Kripya Mobile OTP se dobara login karein.', errorCode: 'UNAUTHORIZED' }) };
    }
    const sellerId = seller.id; // client-supplied sellerId trust nahi karte, firebaseUid se resolve kiya

    // ---- Step 1a: CODE - agla upcoming festival ----
    const now = new Date();
    let festival;
    if (occasion) {
      festival = { name: occasion, date: null };
    } else {
      const found = findUpcomingFestival(now);
      if (!found) {
        return { statusCode: 200, headers, body: JSON.stringify({ error: `Agle ${LOOKAHEAD_DAYS} din mein calendar mein koi bada festival nahi hai. Chahen to \`occasion\` field mein khud koi sale/occasion likh sakte hain.`, errorCode: 'NO_UPCOMING_FESTIVAL' }) };
      }
      festival = { name: found.name, date: found.date };
    }

    // ---- Step 1b: CODE - isi seller ke apne products (category list) ----
    let allProducts;
    try {
      const productsSnap = await db.collection('store').doc('products').get();
      allProducts = productsSnap.exists ? (productsSnap.data().value || []) : [];
    } catch (e) {
      console.error('Products fetch failed:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Products load nahi ho paaye.', errorCode: 'INTERNAL_ERROR' }) };
    }
    const categoryByProductId = {}; // productId -> category (sales tally join ke liye)
    const sellerCategories = new Set();
    allProducts.forEach((p) => {
      if (p.sellerId === sellerId && p.category) { categoryByProductId[p.id] = p.category; sellerCategories.add(p.category); }
    });

    // ---- Step 1c: CODE - isi seller ke pichle 90 din ke orders se category-wise sales tally ----
    let allOrders;
    try {
      const ordersSnap = await db.collection('store').doc('orders').get();
      allOrders = ordersSnap.exists ? (ordersSnap.data().value || []) : [];
    } catch (e) {
      console.error('Orders fetch failed:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Orders load nahi ho paaye.', errorCode: 'INTERNAL_ERROR' }) };
    }
    const cutoffMs = now.getTime() - SALES_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const byCategory = {}; // category -> { orders, qty }
    allOrders.forEach((o) => {
      if (o.sellerId !== sellerId) return;
      if (typeof o.createdAt !== 'number' || o.createdAt < cutoffMs) return;
      if (o.status === 'Cancelled') return; // cancelled orders sales count mein nahi
      const category = categoryByProductId[o.productId];
      if (!category) return;
      byCategory[category] = byCategory[category] || { orders: 0, qty: 0 };
      byCategory[category].orders += 1;
      byCategory[category].qty += o.qty || 1;
    });

    const topCategoriesBySales = Object.entries(byCategory)
      .map(([category, v]) => ({ category, orders: v.orders, qty: v.qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 5);

    const computedSummary = {
      festival,
      salesWindowDays: SALES_WINDOW_DAYS,
      topCategoriesBySales,
      sellerCategories: [...sellerCategories],
      note: topCategoriesBySales.length ? undefined : `Pichle ${SALES_WINDOW_DAYS} din mein koi valid order nahi mila - suggestion general category list par based hoga.`,
    };

    const fallbackIntro = topCategoriesBySales.length
      ? `${festival.name} ke liye aapke top-selling categories (pichle ${SALES_WINDOW_DAYS} din) hain: ${topCategoriesBySales.map((c) => c.category).join(', ')}. Inka stock badha sakte hain.`
      : `${festival.name} aa raha hai - pichle ${SALES_WINDOW_DAYS} din ka sales data nahi mila, apni listed categories (${[...sellerCategories].join(', ') || 'N/A'}) ke hisaab se stock plan karein.`;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ intro: fallbackIntro, suggestions: [], computedSummary }) };
    }

    // ---- Step 2: AI - sirf ASLI computed data dekhkar Hindi suggestion ----
    let intro = fallbackIntro, suggestions = [];
    try {
      const promptText = `Tum ek Indian e-commerce seller dashboard ke liye stock-planning assistant ho. Neeche is seller ka ASLI (code-computed) data hai - koi sales number khud invent mat karna, jo diya hai wahi use karo:

Upcoming festival/occasion: ${festival.name}${festival.date ? ` (${festival.date})` : ''}
Pichle ${SALES_WINDOW_DAYS} din ke top-selling categories (isi seller ke): ${JSON.stringify(topCategoriesBySales)}
Seller ke paas listed categories: ${JSON.stringify([...sellerCategories])}

Apni general jaankari use karo ki is festival mein aam taur par kya zyada bikta hai (jaise Diwali mein decor/diyas/mithai/ethnic wear, Holi mein colors/white clothes) - par sirf tabhi jab seller ki categories se match kare.

- intro: Hindi mein 1-2 chhoti sentences ka intro
- suggestions: 2-4 category-wise tips (jo seller ki apni categories mein se hi hon), har ek mein "category" aur ek chhota "tip" (kyun stock badhaayein, Hindi mein)`;
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
          intro = parsed.intro || fallbackIntro;
          suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
        }
      } else {
        console.error('Gemini API error:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Festival stock suggestion failed, fallback intro use ho raha hai:', e);
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ intro, suggestions, computedSummary }) };
  },
  { functionName: 'suggestFestivalStock', methods: ['POST'], rateLimit: { limit: 20, windowMs: 60 * 60 * 1000 } }
);
