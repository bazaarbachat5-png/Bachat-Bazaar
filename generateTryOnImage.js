exports.handler = async function(event) {
  return { statusCode: 410, headers: {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({error:'Try-On ab browser se free IDM-VTON Hugging Face Space ko use karta hai. Is Netlify function ki zarurat nahi hai.', errorCode:'TRYON_MOVED_TO_IDMVTON'}) };
};
