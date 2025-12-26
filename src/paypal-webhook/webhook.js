const {
  Client,
  Environment,
  WebhooksController,
} = require('@paypal/paypal-server-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const dynamoDbClient = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(dynamoDbClient);

// Helper function to build the client
function getPayPalClient() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const environment = process.env.PAYPAL_MODE === 'live'
    ? Environment.Production
    : Environment.Sandbox; 

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
  const body = event.body;
  const headers = event.headers;

  const client = getPayPalClient();
  const webhooksController = new WebhooksController(client);

  try {
    const webhookEvent = JSON.parse(body);
    
    // 1. Verify Webhook Authenticity
    const verification = await retryAsync(() => 
      webhooksController.verifyWebhookSignature({
        authAlgo: headers['paypal-auth-algo'] || headers['Paypal-Auth-Algo'],
        certUrl: headers['paypal-cert-url'] || headers['Paypal-Cert-Url'],
        transmissionId: headers['paypal-transmission-id'] || headers['Paypal-Transmission-Id'],
        transmissionSig: headers['paypal-transmission-sig'] || headers['Paypal-Transmission-Sig'],
        transmissionTime: headers['paypal-transmission-time'] || headers['Paypal-Transmission-Time'],
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
        webhookEvent: webhookEvent,
      })
    );

    if (verification.result.verification_status === 'SUCCESS') {
      const eventType = webhookEvent.event_type;
      const orderId = webhookEvent.resource?.supplementary_data?.related_ids?.order_id || 
                      webhookEvent.resource?.order_id || 
                      "UNKNOWN_ORDER";

      // --- CENTRALIZED LOGGING LOGIC ---
      const eventsTable = process.env.EVENTS_TABLE_NAME;
      if (eventsTable) {
        try {
          await retryAsync(() =>
            dynamoDb.send(new PutCommand({
              TableName: eventsTable,
              Item: {
                eventId: webhookEvent.id,
                orderId: orderId,
                logType: "PAYPAL_WEBHOOK", // Matches admin.js query logic
                timestamp: new Date().toISOString(),
                message: `PayPal Event: ${eventType}`,
                details: JSON.stringify(webhookEvent.resource)
              }
            }))
          );
        } catch (logErr) {
          console.error('Failed to log event to DynamoDB:', logErr);
        }
      }

      // --- BUSINESS LOGIC: UPDATE ORDER STATUS ---
      if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
        const ordersTable = process.env.ORDERS_TABLE_NAME;
        if (orderId !== "UNKNOWN_ORDER" && ordersTable) {
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
            console.error(`Failed to update order ${orderId}:`, dbErr);
          }
        }
      }
    } else {
      console.error('Webhook verification failed:', verification.result);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ received: true }),
  };
};