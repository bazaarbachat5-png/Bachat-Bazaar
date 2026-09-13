/**
 * Bachat Bazaar - Support Message Auto-Triage (Netlify Function)
 * ====================================================================
 * `moderateProduct.js` jaisa hi FLAG-ONLY pattern: customer/seller jo
 * bhi support message bheje (chat ya form se), ye function usse ek
 * urgency category mein daal deta hai taaki admin priority se dekh
 * sake. Ye function khud kuch bhi decide/action/reply/close nahi karta -
 * sirf ek label deta hai jo caller (frontend/admin backend) apni
 * support-ticket document ke saath save kar sakta hai.
 *
 * IMPORTANT: ye kabhi kisi message ko block/delete/auto-close nahi
 * karta, aur support form submit hona iski wajah se kabhi nahi rukta -
 * key na ho ya Gemini fail ho to bhi ek reasonable keyword-based
 * fallback category mil jaati hai.
 *
 * categories: "urgent-refund" (paisa/refund/wapas jaisi baat), "delivery-issue"
 * (order na milna, late delivery, damaged/wrong item), "general-query"
 * (baaki sab kuch - product/account/general sawaal).
 *
 * Auth: koi zaroorat nahi (guest bhi support form bhar sakta hai) -
 * sirf per-IP rate limit se abuse rokte hain.
 *
 * ---- errorCode values ----
 *   MISSING_FIELDS, RATE_LIMITED, INTERNAL_ERROR
 */

const { withSecurity, getFirebaseApp } = require('./_shared/security');

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_MESSAGE_CHARS = 4000;

const CATEGORIES = ['urgent-refund', 'delivery-issue', 'general-query'];

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    category: { type: 'STRING', enum: CATEGORIES },
    priority_summary: { type: 'STRING' },
  },
  required: ['category', 'priority_summary'],
};

const KEYWORD_RULES = [
  { category: 'urgent-refund', re: /(refund|paisa\s*wapas|paise\s*wapas|money\s*back|cancel.*order|charge.*wapas)/i },
  { category: 'delivery-issue', re: /(delivery|deliver|order.*nahi\s*mila|late|delay|damage|damaged|galat\s*(item|product)|wrong\s*item|tracking)/i },
];

function fallbackTriage(message) {
  for (const rule of KEYWORD_RULES) {
    if (rule.re.test(message)) return { category: rule.category, priority_summary: message.slice(0, 120) };
  }
  return { category: 'general-query', priority_summary: message.slice(0, 120) };
}

exports.handler = withSecurity(
  async function (event, ctx) {
    const { headers, audit } = ctx;
    getFirebaseApp();

    let message;
    try { ({ message } = JSON.parse(event.body || '{}')); } catch (e) {}
    if (!message || !message.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Support message chahiye.', errorCode: 'MISSING_FIELDS' }) };
    }
    message = message.trim().slice(0, MAX_MESSAGE_CHARS);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 200, headers, body: JSON.stringify(fallbackTriage(message)) };
    }

    let result = fallbackTriage(message);
    try {
      const promptText = `Tum ek Indian e-commerce marketplace ke support-triage assistant ho. Neeche customer/seller ka support message hai:

"${message}"

Isse EXACT in teen categories mein se ek mein daalo (koi nayi category mat banana):
- "urgent-refund": paise/refund/order-cancel se related, jaldi dekhna zaroori hai
- "delivery-issue": order na milna, late delivery, galat/damaged item
- "general-query": baaki sab kuch (product, account, general sawaal)

category: upar mein se ek
priority_summary: admin ke liye 1 chhoti Hindi line (max ~15 words) jisse admin turant samajh jaaye message kis baare mein hai - message ke exact alfaaz copy mat karna, apne alfaaz mein summarize karo`;
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA } }),
      });
      if (res.status === 429) {
        await audit({ event: 'quota_exceeded' });
      } else if (res.ok) {
        const data = await res.json();
        const textPart = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
          data.candidates[0].content.parts && data.candidates[0].content.parts.find((p) => p.text);
        if (textPart) {
          const parsed = JSON.parse(textPart.text);
          if (CATEGORIES.includes(parsed.category)) {
            result = { category: parsed.category, priority_summary: parsed.priority_summary || result.priority_summary };
          }
        }
      } else {
        console.error('Gemini API error:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Triage Gemini call failed, keyword fallback use ho raha hai:', e);
    }

    return { statusCode: 200, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  },
  { functionName: 'triageSupportMessage', methods: ['POST'], rateLimit: { limit: 60, windowMs: 60 * 60 * 1000 } }
);
