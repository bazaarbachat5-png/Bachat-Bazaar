/**
 * Bachat Bazaar - Order Tracking Assistant (Netlify Function)
 * ====================================================================
 * Customer "mera order kaha hai" jaisa sawaal poochta hai - Order ID
 * aur apna phone number deta hai. `estimateDeliveryTime.js` jaisa hi
 * CODE-FIRST pattern:
 *
 *   Step 1 (CODE): Orders is app mein Firestore ke `store/orders`
 *                  document ke andar ek hi array (`value`) mein store
 *                  hote hain (real per-order collection nahi hai -
 *                  jaisa `adminLogin.js` mein `store/admin-secure` /
 *                  `store/store-settings` pattern hai). Isi array ko
 *                  poora load karke, CODE khud orderId dhoondhta/
 *                  match karta hai - status, courier, tracking number,
 *                  estimated delivery, sab CODE se nikalta hai, AI ka
 *                  koi role nahi.
 *   Step 2 (AI):   Gemini sirf un ASLI, already-fetched facts ko
 *                  dekhkar ek chhota, friendly Hindi status-update
 *                  likhta hai - kabhi koi status/tareekh khud invent
 *                  nahi karta.
 *
 * SECURITY: sirf Order ID kaafi nahi hai (koi bhi guess/type kar sakta
 * hai) - customer ka phone number bhi order ke `custPhone` se match
 * hona chahiye, warna order ka address/status kisi aur ko dikh sakta
 * hai. Match na ho to hum ye reveal nahi karte ki order exist karta
 * hai ya nahi - dono cases mein wahi generic "nahi mila" jawaab jaata
 * hai (taaki koi phone-number guess karke order-existence probe na kar
 * sake).
 *
 * NOTE: `store/orders` doc mein SAARE orders ek hi array mein hote hain
 * (chhoti/medium site ke liye theek hai) - is function ko har request
 * par poora doc padhna padta hai, ek single order ka targeted query
 * nahi ho sakta (Firestore array-field query support nahi karta). Agar
 * orders ki list bahut badi ho jaaye (kai hazaar) to ye dheema ho sakta
 * hai - tab per-order-document migration recommended hoga.
 *
 * GEMINI_API_KEY na ho ya Gemini fail ho, tab bhi ek hardcoded Hindi
 * status-template se order status dikh jaata hai - tracking iski wajah
 * se kabhi nahi rukta.
 *
 * Auth: koi zaroorat nahi (guest tracking customer-facing hai) - sirf
 * Order ID + phone match se identity confirm hoti hai, baaki per-IP
 * rate limit se abuse rokte hain.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, SERVER_NOT_CONFIGURED, RATE_LIMITED, INTERNAL_ERROR
 */

const { withSecurity } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Order document mein status in exact values mein se ek hota hai (jaisa
// admin panel ka ORDER_STATUSES hai) - fallback templates sabko cover
// karte hain taaki AI na ho tab bhi customer ko poora context mile.
const STATUS_TEMPLATES = {
  'Pending': () => 'Aapka order abhi "Pending" hai - seller ne isse ab tak confirm nahi kiya hai.',
  'Confirmed': () => 'Aapka order "Confirm" ho chuka hai, jald hi ship kiya jaayega.',
  'Shipped': (o) => `Aapka order "Shipped" ho chuka hai.${o.courierCompany ? ` Courier: ${o.courierCompany}${o.trackingNumber ? ' (Tracking No: ' + o.trackingNumber + ')' : ''}.` : ''}${o.estimatedDeliveryDate ? ` Ummeed hai ${o.estimatedDeliveryDate} tak pahunch jaayega.` : ''}`,
  'Delivered': () => 'Aapka order "Delivered" ho chuka hai. Ummeed hai aapko pasand aaya hoga!',
  'Delivery Failed': (o) => `Delivery attempt fail ho gayi thi.${o.failedReason ? ` Wajah: ${o.failedReason}.` : ''} Jald hi dobara try kiya jaayega, ya courier/seller se sampark hoga.`,
  'Exchange Requested': () => 'Aapki exchange request mil chuki hai aur process ho rahi hai.',
  'Returned': (o) => `Ye order "Return" ho chuka hai.${o.returnReason ? ` Wajah: ${o.returnReason}.` : ''}`,
  'Cancelled': (o) => `Ye order "Cancel" ho chuka hai.${o.cancelReason ? ` Wajah: ${o.cancelReason}.` : ''}`,
};

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10);
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, db } = ctx;

    let orderId, phone;
    try { ({ orderId, phone } = JSON.parse(event.body || '{}')); } catch (e) {}
    orderId = String(orderId || '').trim().toUpperCase();
    const normPhone = normalizePhone(phone);
    if (!orderId || normPhone.length !== 10) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Order ID aur 10-digit phone number, dono chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }
    if (!db) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configure nahi hai.', errorCode: 'SERVER_NOT_CONFIGURED' }) };
    }

    // ---- Step 1: CODE - `store/orders` se ASLI orders array + match ----
    const notFoundReply = 'Ye Order ID aur phone number match nahi hua. Kripya dono dobara check karke try karein.';
    let orders;
    try {
      const snap = await db.collection('store').doc('orders').get();
      orders = snap.exists ? (snap.data().value || []) : [];
    } catch (e) {
      console.error('Orders fetch failed:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Order dhoondhne mein dikkat aayi. Dobara try karein.', errorCode: 'INTERNAL_ERROR' }) };
    }

    const order = orders.find((o) => String(o.orderId || '').toUpperCase() === orderId);
    if (!order) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, reply: notFoundReply }) };
    }
    // Phone match na ho to order exist karta hai ye bhi reveal nahi karte.
    if (normalizePhone(order.custPhone) !== normPhone) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, reply: notFoundReply }) };
    }

    const status = order.status || 'Pending';
    const facts = {
      orderId,
      status,
      productTitle: order.productName || '',
      courierCompany: order.courierCompany || null,
      trackingNumber: order.trackingNumber || null,
      estimatedDeliveryDate: order.estimatedDeliveryDate || null,
      cancelReason: order.cancelReason || null,
      returnReason: order.returnReason || null,
      failedReason: order.failedReason || null,
    };

    const fallbackReply = (STATUS_TEMPLATES[status] || STATUS_TEMPLATES['Pending'])(facts);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: true, status, reply: fallbackReply, order: facts }) };
    }

    // ---- Step 2: AI - sirf ASLI facts ko friendly Hindi mein pirota hai ----
    let reply = fallbackReply;
    try {
      const promptText = `Tum ek Indian e-commerce order-tracking assistant ho. Neeche is order ka ASLI (code se nikla) status data hai - in facts ko badalna mat, na hi koi nayi tareekh/status/wajah invent karna:

${JSON.stringify(facts)}

Sirf Hindi mein, 2-3 chhoti friendly sentences mein customer ko unke order ka status batao. Agar courier/tracking number diya hai to wo zaroor mention karo. Agar cancel/return/delivery-failed ki wajah di hai to wo bhi saaf bata do.`;
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
      });
      if (res.ok) {
        const data = await res.json();
        const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
        if (textPart) reply = textPart.text.trim();
      } else {
        console.error('Gemini API error:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Order status phrasing failed, fallback template use ho raha hai:', e);
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ found: true, status, reply, order: facts }) };
  },
  { functionName: 'trackOrderStatus', methods: ['POST'], rateLimit: { limit: 60, windowMs: 60 * 60 * 1000 } }
);
