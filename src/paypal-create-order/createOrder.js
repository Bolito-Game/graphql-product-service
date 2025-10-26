const {
  Client,
  Environment,
  OrdersController,
  CheckoutPaymentIntent,
} = require('@paypal/paypal-server-sdk');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const body = JSON.parse(event.body || '{}');
  const { amount, currency = 'USD' } = body;

  if (!amount || amount <= 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid amount' }),
    };
  }

  try {
    const client = getPayPalClient();
    // Use the OrdersController
    const ordersController = new OrdersController(client);

    // Build the request body for the controller
    const orderRequestBody = {
      intent: CheckoutPaymentIntent.Capture, // Use the imported enum
      purchaseUnits: [
        {
          amount: {
            currencyCode: currency,
            value: amount.toFixed(2),
          },
        },
      ],
      // Add application_context if needed, e.g., return_url, cancel_url
    };

    // Call the createOrder method on the controller
    const apiResponse = await ordersController.createOrder({
      body: orderRequestBody,
      prefer: 'return=representation',
    });

    const orderId = apiResponse.result.id;

    // Store in DynamoDB
    const ordersTable = process.env.ORDERS_TABLE_NAME;
    await dynamoDb.send(new PutCommand({
      TableName: ordersTable,
      Item: {
        orderId,
        status: 'CREATED',
        amount,
        currency,
        createdAt: new Date().toISOString(),
      },
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ id: orderId }),
    };
  } catch (err) {
    console.error('PayPal create order error:', err);
    const errorBody = err.result ? JSON.stringify(err.result) : err.message;
    return {
      statusCode: err.statusCode || 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: errorBody }),
    };
  }
};