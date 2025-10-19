// src/paypal/webhook.js
const https = require('https');
const AWS = require('aws-sdk');

const dynamoDb = new AWS.DynamoDB.DocumentClient();

const verifyWebhook = (postData) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api-m.sandbox.paypal.com',
      port: 443,
      path: '/v1/notifications/verify-webhook-signature',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
};

const retryAsync = async (fn, maxRetries = 3, baseDelay = 1000) => {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i === maxRetries) throw lastError;
      const delay = baseDelay * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;

  let webhookEvent;
  try {
    webhookEvent = JSON.parse(rawBody);
  } catch (e) {
    console.error('Invalid JSON in webhook body:', e);
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: ''
    };
  }

  const headers = event.headers || {};
  const authAlgo = headers['paypal-auth-algo'] || '';
  const certUrl = headers['paypal-cert-url'] || '';
  const transmissionId = headers['paypal-transmission-id'] || '';
  const transmissionSig = headers['paypal-transmission-sig'] || '';
  const transmissionTime = headers['paypal-transmission-time'] || '';
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    console.error('Webhook ID not configured');
    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: ''
    };
  }

  const postData = JSON.stringify({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: webhookEvent
  });

  let verificationSuccess = false;
  try {
    const verifyRes = await retryAsync(() => verifyWebhook(postData), 3, 1000);
    if (verifyRes.statusCode === 200 && verifyRes.body.verification_status === 'SUCCESS') {
      verificationSuccess = true;
      const eventType = webhookEvent.event_type;
      console.log(`Processing webhook event: ${eventType}`);

      if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
        const orderId = webhookEvent.resource.order_id;
        const ordersTable = process.env.ORDERS_TABLE_NAME;

        if (orderId && ordersTable) {
          try {
            await retryAsync(() => dynamoDb.update({
              TableName: ordersTable,
              Key: { orderId },
              UpdateExpression: 'set status = :s, completedAt = :t',
              ExpressionAttributeValues: {
                ':s': 'COMPLETED',
                ':t': new Date().toISOString()
              }
            }).promise(), 3, 1000);
            console.log(`Updated order ${orderId} to COMPLETED`);
          } catch (dbErr) {
            console.error(`Failed to update order ${orderId} after retries:`, dbErr);
          }
        }
      }
      // Handle other event types as needed
    } else {
      console.error('Webhook verification failed:', verifyRes.body);
    }
  } catch (err) {
    console.error('Webhook verification error after retries:', err);
  }

  // Always return 200 for webhooks
  return {
    statusCode: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: ''
  };
};