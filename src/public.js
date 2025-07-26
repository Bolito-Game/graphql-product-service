// public.js - Read-Only GraphQL Lambda Handler

const { graphql, buildSchema } = require("graphql");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");
const fs = require("fs");
const path = require("path");

// --- AWS SDK Setup ---
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || "Products";

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(
  path.join(__dirname, "schema.graphql"),
  "utf8"
);
const schema = buildSchema(schemaString);

// --- Helper Functions ---
// (Helper functions are the same for both files)

const resolveLocalization = (dynamoDBItem, lang, country) => {
  if (!dynamoDBItem) return null;
  const localeKey = `${lang}-${country}`;
  const defaultLocaleKey = "en-us";
  const localizedData =
    dynamoDBItem.Localizations[localeKey] ||
    dynamoDBItem.Localizations[defaultLocaleKey];
  if (!localizedData) {
    return {
      ...dynamoDBItem,
      Category_Text: "Localization Not Found",
      Name: "Localization Not Found",
      Description: "",
      Price: 0,
      Currency: "N/A",
    };
  }
  return {
    SKU: dynamoDBItem.SKU,
    Category: dynamoDBItem.Category,
    Image_URL: dynamoDBItem.Image_URL,
    Status: dynamoDBItem.Status,
    Last_Updated: dynamoDBItem.Last_Updated,
    Quantity_In_Stock: dynamoDBItem.Quantity_In_Stock,
    ...localizedData,
  };
};

// --- GraphQL Resolvers for Public Access ---
const publicRoot = {
  // === QUERIES (Read-Only) ===
  getProductBySKU: async ({ SKU, lang, country }) => {
    const command = new GetCommand({ TableName: TABLE_NAME, Key: { SKU } });
    try {
      const { Item } = await docClient.send(command);
      if (!Item) {
        return {
          errors: [{ message: `Product with SKU '${SKU}' not found.` }],
        };
      }
      return { product: resolveLocalization(Item, lang, country) };
    } catch (error) {
      console.error("DynamoDB Error:", error);
      return {
        errors: [
          { message: "An internal error occurred while fetching the product." },
        ],
      };
    }
  },

  getProductsByCategory: async ({ category, lang, country }) => {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "CategoryIndex",
      KeyConditionExpression: "Category = :category",
      ExpressionAttributeValues: { ":category": category },
    });
    try {
      const { Items } = await docClient.send(command);
      return Items.map((item) => resolveLocalization(item, lang, country));
    } catch (error) {
      console.error("DynamoDB Error:", error);
      return [];
    }
  },

  getAllProducts: async ({ lang, country, limit, nextToken }) => {
    const params = { TableName: TABLE_NAME, Limit: limit };
    if (nextToken) {
      params.ExclusiveStartKey = JSON.parse(
        Buffer.from(nextToken, "base64").toString("utf8")
      );
    }
    try {
      const { Items, LastEvaluatedKey } = await docClient.send(
        new ScanCommand(params)
      );
      const resolvedItems = Items.map((item) =>
        resolveLocalization(item, lang, country)
      );
      const newNextToken = LastEvaluatedKey
        ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
        : null;
      return { items: resolvedItems, nextToken: newNextToken };
    } catch (error) {
      console.error("DynamoDB Error:", error);
      return { items: [], nextToken: null };
    }
  },

  // === MUTATIONS are intentionally omitted for security ===
};

// --- Main Lambda Handler ---
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);

    const result = await graphql({
      schema,
      source: query,
      rootValue: publicRoot, // IMPORTANT: Use the publicRoot object
      variableValues: variables,
      operationName,
    });

    // Check for mutation attempts
    if (
      operationName &&
      result.errors &&
      result.errors.some((e) => e.message.includes("Cannot query field"))
    ) {
      console.warn(
        `Blocked mutation attempt for operation '${operationName}' on public endpoint.`
      );
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error("Unhandled GraphQL Error:", error);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errors: [{ message: error.message || "Invalid GraphQL request." }],
      }),
    };
  }
};
