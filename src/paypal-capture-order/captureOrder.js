const {
  Client,
  Environment,
  OrdersController,
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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const body = JSON.parse(event.body || '{}');
  const { orderID } = body;

  if (!orderID) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Order ID required' }),
    };
  }

  try {
    const client = getPayPalClient();
    // Use the OrdersController
    const ordersController = new OrdersController(client);

    // Call the captureOrder method on the controller
    const apiResponse = await ordersController.captureOrder({
      id: orderID,
      prefer: 'return=representation',
    });

    // Update in DynamoDB
    const ordersTable = process.env.ORDERS_TABLE_NAME;
    await dynamoDb.send(new UpdateCommand({
      TableName: ordersTable,
      Key: { orderId: orderID },
      UpdateExpression: 'set #status = :s, capturedAt = :t',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':s': 'CAPTURED',
        ':t': new Date().toISOString(),
      },
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ details: apiResponse.result }),
    };
  } catch (err) {
    console.error('PayPal capture order error:', err);
    const errorBody = err.result ? JSON.stringify(err.result) : err.message;
    return {
      statusCode: err.statusCode || 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: errorBody }),
    };
  }
};