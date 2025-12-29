const { Client, Environment } = require('@paypal/paypal-server-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoDbClient = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(dynamoDbClient);

/**
 * Retrieves OAuth2 token for manual verification call.
 */
async function getAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const baseUrl = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  
  const data = await response.json();
  return data.access_token;
}

exports.handler = async (event) => {
  // 1. Extract headers (Case-insensitive)
  const getHeader = (name) => {
    const target = name.toLowerCase();
    for (const key in event.headers) {
      if (key.toLowerCase() === target) return event.headers[key];
    }
    return null;
  };

  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const webhookEvent = JSON.parse(rawBody);

  try {
    const accessToken = await getAccessToken();
    const baseUrl = process.env.PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

    // 2. Verify Webhook Signature with PayPal API
    const verifyResponse = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        auth_algo: getHeader('paypal-auth-algo'),
        cert_url: getHeader('paypal-cert-url'),
        transmission_id: getHeader('paypal-transmission-id'),
        transmission_sig: getHeader('paypal-transmission-sig'),
        transmission_time: getHeader('paypal-transmission-time'),
        webhook_id: process.env.PAYPAL_WEBHOOK_ID,
        webhook_event: webhookEvent
      })
    });

    const result = await verifyResponse.json();

    if (result.verification_status === 'SUCCESS') {
      // CORRELATION LOGIC:
      // 1. Try custom_id (Your internal DB ID)
      // 2. Try the related order_id (from supplementary_data)
      // 3. Fallback to the resource ID
      const orderId = webhookEvent.resource.custom_id || 
                      webhookEvent.resource.supplementary_data?.related_ids?.order_id || 
                      webhookEvent.resource.id || 'UNKNOWN_ID';
      const eventType = webhookEvent.event_type;

      // 3. Log to Events Table (Audit Trail)
      if (process.env.EVENTS_TABLE_NAME) {
        await dynamoDb.send(new PutCommand({
          TableName: process.env.EVENTS_TABLE_NAME,
          Item: {
            eventId: webhookEvent.id,
            orderId: orderId,
            logType: "PAYPAL_WEBHOOK",
            timestamp: new Date().toISOString(),
            eventType: eventType,
            details: JSON.stringify(webhookEvent.resource)
          }
        }));
      }

      // 4. Update Order Status
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED' && process.env.ORDERS_TABLE_NAME) {
        await dynamoDb.send(new UpdateCommand({
          TableName: process.env.ORDERS_TABLE_NAME,
          Key: { orderId },
          UpdateExpression: 'set #s = :s, completedAt = :t',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { 
            ':s': 'COMPLETED', 
            ':t': new Date().toISOString() 
          }
        }));
        console.log(`Order ${orderId} successfully updated.`);
      }
    } else {
      console.warn(`Verification failed: ${result.verification_status}`);
    }
  } catch (err) {
    console.error('Critical Error:', err.message);
    return { statusCode: 500, body: 'Error' };
  }

  return { 
    statusCode: 200, 
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ received: true }) 
  };
};