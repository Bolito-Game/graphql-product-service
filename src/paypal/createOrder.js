// src/paypal/createOrder.js
const paypal = require('@paypal/checkout-server-sdk');
const AWS = require('aws-sdk');

const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const { amount, currency = 'USD' } = body;

  if (!amount || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid amount' }) };
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PayPal configuration missing' }) };
  }

  const environment = new paypal.core.SandboxEnvironment(clientId, clientSecret);
  const client = new paypal.core.PayPalHttpClient(environment);

  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: currency,
        value: amount.toFixed(2)
      }
    }]
  });

  try {
    const response = await client.execute(request);
    const orderId = response.result.id;

    // Store in DynamoDB
    const ordersTable = process.env.ORDERS_TABLE_NAME;
    await dynamoDb.put({
      TableName: ordersTable,
      Item: {
        orderId,
        status: 'CREATED',
        amount,
        currency,
        createdAt: new Date().toISOString()
      }
    }).promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ id: orderId })
    };
  } catch (err) {
    console.error('PayPal create order error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};