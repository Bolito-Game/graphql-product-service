// admin.js - Full CRUD GraphQL Lambda Handler

const { graphql, buildSchema } = require("graphql");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
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
  // ... (same as in public.js)
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

const createMutationResponse = ({ success, product = null, errors = [] }) => ({
  success,
  product,
  errors,
});

// --- GraphQL Resolvers for Admin Access ---
const adminRoot = {
  // === QUERIES ===
  getProductBySKU: async ({ SKU, lang, country }) => {
    // ... (same as in public.js)
    const command = new GetCommand({ TableName: TABLE_NAME, Key: { SKU } });
    try {
      const { Item } = await docClient.send(command);
      if (!Item)
        return {
          errors: [{ message: `Product with SKU '${SKU}' not found.` }],
        };
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
    // ... (same as in public.js)
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
    // ... (same as in public.js)
    const params = { TableName: TABLE_NAME, Limit: limit };
    if (nextToken)
      params.ExclusiveStartKey = JSON.parse(
        Buffer.from(nextToken, "base64").toString("utf8")
      );
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

  // === MUTATIONS (Included for Admin) ===
  createProduct: async ({ input }) => {
    // ... (code from original index.js)
    const { localizations, ...baseData } = input;
    const localizationsMap = localizations.reduce((acc, loc) => {
      const { lang, country, ...data } = loc;
      acc[`${lang.toLowerCase()}-${country.toLowerCase()}`] = data;
      return acc;
    }, {});
    const item = {
      ...baseData,
      Localizations: localizationsMap,
      Last_Updated: new Date().toISOString(),
    };
    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(SKU)",
    });
    try {
      await docClient.send(command);
      return createMutationResponse({
        success: true,
        product: resolveLocalization(item, "en", "us"),
      });
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return createMutationResponse({
          success: false,
          errors: [
            {
              field: "SKU",
              message: `Product with SKU '${input.SKU}' already exists.`,
            },
          ],
        });
      console.error("DynamoDB Error:", error);
      return createMutationResponse({
        success: false,
        errors: [{ message: "Could not create product." }],
      });
    }
  },
  updateProduct: async ({ input }) => {
    // ... (code from original index.js)
    const { SKU, localizations, ...updates } = input;
    let updateExpression = "SET Last_Updated = :lastUpdated";
    const expressionAttributeValues = {
      ":lastUpdated": new Date().toISOString(),
    };
    const expressionAttributeNames = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && value !== null) {
        updateExpression += `, ${key} = :${key}`;
        expressionAttributeValues[`:${key}`] = value;
      }
    }
    if (localizations && localizations.length > 0) {
      localizations.forEach((loc, index) => {
        const { lang, country, ...data } = loc;
        const localeKey = `${lang.toLowerCase()}-${country.toLowerCase()}`;
        updateExpression += `, #L.#n${index} = :v${index}`;
        expressionAttributeNames["#L"] = "Localizations";
        expressionAttributeNames[`#n${index}`] = localeKey;
        expressionAttributeValues[`:v${index}`] = data;
      });
    }
    const command = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { SKU },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues,
      ExpressionAttributeNames:
        Object.keys(expressionAttributeNames).length > 0
          ? expressionAttributeNames
          : undefined,
      ReturnValues: "ALL_NEW",
      ConditionExpression: "attribute_exists(SKU)",
    });
    try {
      const { Attributes } = await docClient.send(command);
      return createMutationResponse({
        success: true,
        product: resolveLocalization(Attributes, "en", "us"),
      });
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException")
        return createMutationResponse({
          success: false,
          errors: [
            { field: "SKU", message: `Product with SKU '${SKU}' not found.` },
          ],
        });
      console.error("DynamoDB Error:", error);
      return createMutationResponse({
        success: false,
        errors: [{ message: "Could not update product." }],
      });
    }
  },
  deleteProduct: async ({ SKU }) => {
    // ... (code from original index.js)
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { SKU },
      ReturnValues: "ALL_OLD",
    });
    try {
      const { Attributes } = await docClient.send(command);
      if (!Attributes)
        return createMutationResponse({
          success: false,
          errors: [
            { field: "SKU", message: `Product with SKU '${SKU}' not found.` },
          ],
        });
      return createMutationResponse({
        success: true,
        product: resolveLocalization(Attributes, "en", "us"),
      });
    } catch (error) {
      console.error("DynamoDB Error:", error);
      return createMutationResponse({
        success: false,
        errors: [{ message: "Could not delete product." }],
      });
    }
  },
};

// --- Main Lambda Handler ---
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);

    const result = await graphql({
      schema,
      source: query,
      rootValue: adminRoot, // IMPORTANT: Use the adminRoot object
      variableValues: variables,
      operationName,
    });

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
