const express = require('express');
const app = express();

app.use(express.text({ type: '*/*', limit: '10mb' }));

function wrapNetlifyHandler(handler) {
  return async (req, res) => {
    let bodyStr = req.body;
    if (bodyStr && typeof bodyStr !== 'string') {
      bodyStr = JSON.stringify(bodyStr);
    }

    const event = {
      httpMethod: req.method,
      headers: req.headers,
      body: bodyStr || '',
      queryStringParameters: req.query || {},
      path: req.path,
    };

    try {
      const result = await handler(event);
      const statusCode = (result && result.statusCode) || 200;
      const headers = (result && result.headers) || {};
      Object.entries(headers).forEach(([key, value]) => {
        res.setHeader(key, value);
      });
      res.status(statusCode).send(result ? result.body : '');
    } catch (err) {
      console.error('Unhandled adapter error:', err);
      res.status(500).json({
        error: 'Kuch anjaani gadbad ho gayi. Thodi der baad dobara try karein.',
        errorCode: 'INTERNAL_ERROR',
      });
    }
  };
}

const adminLogin = require('./netlify/functions/adminLogin');
const adminResetPassword = require('./netlify/functions/adminResetPassword');
const generateStyleAdvice = require('./netlify/functions/generateStyleAdvice');
const generateTryOnImage = require('./netlify/functions/generateTryOnImage');
const trackOrderStatus = require('./netlify/functions/trackOrderStatus');
const compareProducts = require('./netlify/functions/compareProducts');
const suggestFestivalStock = require('./netlify/functions/suggestFestivalStock');

const routes = {
  adminLogin: adminLogin.handler,
  adminResetPassword: adminResetPassword.handler,
  generateStyleAdvice: generateStyleAdvice.handler,
  generateTryOnImage: generateTryOnImage.handler,
  trackOrderStatus: trackOrderStatus.handler,
  compareProducts: compareProducts.handler,
  suggestFestivalStock: suggestFestivalStock.handler,
};

Object.entries(routes).forEach(([name, handler]) => {
  const wrapped = wrapNetlifyHandler(handler);
  app.all(`/api/${name}`, wrapped);
  app.all(`/.netlify/functions/${name}`, wrapped);
});

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'bachat-bazaar-backend' });
});
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Bachat Bazaar backend chal raha hai port ${PORT} par`);
});
