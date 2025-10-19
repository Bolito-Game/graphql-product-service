// src/paypal/captureOrder.js
const paypal = require('@paypal/checkout-server-sdk');
const AWS = require('aws-sdk');

const dynamoDb = new AWS.DynamoDB.DocumentClient();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const body = JSON.parse(event.body || '{}');
  const { orderID } = body;

  if (!orderID) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Order ID required' }) };
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { statusCode: 500, body: JSON.stringify({ error: 'PayPal configuration missing' }) };
  }

  const environment = new paypal.core.SandboxEnvironment(clientId, clientSecret);
  const client = new paypal.core.PayPalHttpClient(environment);

  const request = new paypal.orders.OrdersCaptureRequest(orderID);
  request.requestBody({});

  try {
    const response = await client.execute(request);

    // Update in DynamoDB
    const ordersTable = process.env.ORDERS_TABLE_NAME;
    await dynamoDb.update({
      TableName: ordersTable,
      Key: { orderId: orderID },
      UpdateExpression: 'set status = :s, capturedAt = :t',
      ExpressionAttributeValues: {
        ':s': 'CAPTURED',
        ':t': new Date().toISOString()
      }
    }).promise();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ details: response.result })
    };
  } catch (err) {
    console.error('PayPal capture order error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};