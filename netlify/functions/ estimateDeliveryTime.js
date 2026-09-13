/**
 * Bachat Bazaar - Delivery Time Estimate (Netlify Function)
 * ====================================================================
 * `checkAddressQuality.js` jaisा hi CODE-FIRST pattern: ASLI estimate
 * (min/max din) ek simple, deterministic pincode-distance heuristic se
 * CODE mein nikalta hai - Gemini ki zaroorat hi nahi is calculation ke
 * liye. Gemini sirf un exact numbers ko ek chhoti, friendly Hindi line
 * mein pirota hai (checkout page par dikhane ke liye) - khud koi naya
 * number invent nahi karta.
 *
 * HEURISTIC (approximate hai, kisi real courier/logistics API se nahi
 * juda - agar aapke paas ek real logistics/courier API hai to usse
 * yahan wire kar sakte hain, ye sirf ek reasonable default hai):
 *   - Same pincode ya pehle 3 digit match (same city/cluster)  -> 1-2 din
 *   - Pehla digit match (same broad zone/region)               -> 3-4 din
 *   - Bilkul alag zone                                          -> 5-7 din
 *
 * GEMINI_API_KEY na ho ya Gemini fail ho, tab bhi checkout page par
 * hardcoded Hindi template se estimate dikh jaata hai - checkout iski
 * wajah se kabhi nahi rukta.
 *
 * Auth: koi zaroorat nahi (checkout flow customer-facing hai) - sirf
 * per-IP rate limit se abuse rokte hain.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, RATE_LIMITED, INTERNAL_ERROR
 */

const { withSecurity, getFirebaseApp } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PINCODE_RE = /^[1-9][0-9]{5}$/; // Indian 6-digit pincode

// Default seller/warehouse pincode agar seller-specific pincode na diya
// jaaye (single-warehouse platforms ke liye) - .env se override karo.
const DEFAULT_SELLER_PINCODE = process.env.DEFAULT_WAREHOUSE_PINCODE || '';

function computeZone(customerPincode, sellerPincode) {
  if (customerPincode === sellerPincode) return { minDays: 1, maxDays: 2, zone: 'same_pincode' };
  if (customerPincode.slice(0, 3) === sellerPincode.slice(0, 3)) return { minDays: 1, maxDays: 2, zone: 'same_city' };
  if (customerPincode[0] === sellerPincode[0]) return { minDays: 3, maxDays: 4, zone: 'same_region' };
  return { minDays: 5, maxDays: 7, zone: 'other_region' };
}

const FALLBACK_TEMPLATES = {
  same_pincode: (min, max) => `Aapke area mein - order ${min}-${max} din mein pahunch jaayega.`,
  same_city: (min, max) => `Aapke shehar/area ke aas-paas se - order ${min}-${max} din mein pahunch jaayega.`,
  same_region: (min, max) => `Order ${min}-${max} din mein pahunch jaayega.`,
  other_region: (min, max) => `Order ${min}-${max} din mein pahunch jaayega (dooriyat thodi zyada hai).`,
};

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers } = ctx;
    getFirebaseApp();

    let customerPincode, sellerPincode;
    try { ({ customerPincode, sellerPincode } = JSON.parse(event.body || '{}')); } catch (e) {}
    customerPincode = String(customerPincode || '').trim();
    sellerPincode = String(sellerPincode || DEFAULT_SELLER_PINCODE || '').trim();

    if (!PINCODE_RE.test(customerPincode)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid 6-digit delivery pincode chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }
    if (!PINCODE_RE.test(sellerPincode)) {
      // Seller pincode na diya/invalid ho to bhi ek generic estimate de
      // do - checkout kabhi is wajah se nahi rukta.
      return { statusCode: 200, headers, body: JSON.stringify({ minDays: 3, maxDays: 7, message: 'Order aam taur par 3-7 din mein pahunch jaata hai.' }) };
    }

    const { minDays, maxDays, zone } = computeZone(customerPincode, sellerPincode);
    const fallbackMessage = FALLBACK_TEMPLATES[zone](minDays, maxDays);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ minDays, maxDays, message: fallbackMessage }) };
    }

    let message = fallbackMessage;
    try {
      const promptText = `Tum ek Indian e-commerce checkout page ke liye delivery-estimate assistant ho. Code se ye EXACT estimate nikla hai (in numbers ko badalna mat, na hi koi tareekh/din ka naya number invent karna):

Minimum din: ${minDays}
Maximum din: ${maxDays}

Isi jaankari se EK chhoti, friendly Hindi line banao (jaise "2-3 din mein pahunch jaayega") jo checkout page par dikhe. Sirf ek line, koi extra promise (jaise "guaranteed" ya "free") mat jodna.`;
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
        if (textPart) message = textPart.text.trim();
      } else {
        console.error('Gemini API error:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Delivery-estimate phrasing failed, fallback message use ho raha hai:', e);
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ minDays, maxDays, message }) };
  },
  { functionName: 'estimateDeliveryTime', methods: ['POST'], rateLimit: { limit: 100, windowMs: 60 * 60 * 1000 } }
);
