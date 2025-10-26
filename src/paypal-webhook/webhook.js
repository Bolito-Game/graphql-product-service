const {
  Client,
  Environment,
  WebhooksController, // Use the new WebhooksController
} = require('@paypal/paypal-server-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoDbClient = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(dynamoDbClient);

// Helper function to build the client
function getPayPalClient() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const environment = process.env.PAYPAL_MODE === 'live'
    ? Environment.Production
    : Environment.Sandbox; // Use Environment.Sandbox or Environment.Production

  // Client initialization
  return new Client({
    clientCredentialsAuthCredentials: {
      oAuthClientId: clientId,
      oAuthClientSecret: clientSecret,
    },
    environment: environment,
  });
}

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
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
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
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: ''
    };
  }

  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  if (!webhookId) {
    console.error('PayPal configuration missing: PAYPAL_WEBHOOK_ID');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: ''
    };
  }

  // Verify webhook signature
  const headers = event.headers || {};
  const authAlgo = headers['paypal-auth-algo'] || '';
  const certUrl = headers['paypal-cert-url'] || '';
  const transmissionId = headers['paypal-transmission-id'] || '';
  const transmissionSig = headers['paypal-transmission-sig'] || '';
  const transmissionTime = headers['paypal-transmission-time'] || '';

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    console.error('Missing PayPal webhook headers');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: ''
    };
  }

  try {
    const client = getPayPalClient();
    // Use the WebhooksController
    const webhooksController = new WebhooksController(client);

    // Build the verification request
    const verifyRequest = {
      authAlgo: authAlgo,
      certUrl: certUrl,
      transmissionId: transmissionId,
      transmissionSig: transmissionSig,
      transmissionTime: transmissionTime,
      webhookId: webhookId,
      webhookEvent: webhookEvent, // The parsed JSON body
    };

    // Call the verifyWebhookSignature method
    const verification = await retryAsync(() =>
      webhooksController.verifyWebhookSignature({
        body: verifyRequest,
      })
    );

    if (verification.result.verificationStatus === 'SUCCESS') {
      const eventType = webhookEvent.event_type;
      console.log(`Processing webhook event: ${eventType}`);

      if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
        // NOTE: Check your payload. The order_id is often nested.
        // It might be in resource.supplementary_data.related_ids.order_id
        const orderId = webhookEvent.resource?.supplementary_data?.related_ids?.order_id || webhookEvent.resource?.order_id;
        const ordersTable = process.env.ORDERS_TABLE_NAME;

        if (orderId && ordersTable) {
          try {
            await retryAsync(() =>
              dynamoDb.send(new UpdateCommand({
                TableName: ordersTable,
                Key: { orderId },
                UpdateExpression: 'set #status = :s, completedAt = :t',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':s': 'COMPLETED',
                  ':t': new Date().toISOString()
                }
              }))
            );
            console.log(`Updated order ${orderId} to COMPLETED`);
          } catch (dbErr) {
            console.error(`Failed to update order ${orderId} after retries:`, dbErr);
          }
        } else {
            console.warn('Could not find orderId or ordersTable for PAYMENT.CAPTURE.COMPLETED');
        }
      }
      // Handle other event types as needed
    } else {
      console.error('Webhook verification failed:', verification.result);
    }
  } catch (err) {
    console.error('Webhook verification error after retries:', err);
  }

  // Always return 200 for webhooks
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: ''
  };
};