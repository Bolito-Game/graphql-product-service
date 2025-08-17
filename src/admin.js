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
// NOTE: You must create a Global Secondary Index (GSI) on your table for this to work.
// GSI Name: CategoryIndex
// Partition Key: category (String)
const CATEGORY_GSI_NAME = "CategoryIndex";

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(path.join(__dirname, "schema.graphql"), "utf8");
const schema = buildSchema(schemaString);

/**
 * NEW HELPER FUNCTION
 * Replaces 'formatProduct'. Assumes DynamoDB item uses camelCase keys matching the schema.
 * Formats a DynamoDB item into a GraphQL Product type, converting the localizations map to an array.
 * @param {object} item - The item retrieved from DynamoDB.
 * @param {string} [lang] - Optional language code to filter localizations.
 * @param {string} [country] - Optional country code to filter localizations.
 * @returns {object|null} A GraphQL Product object or null if the item is invalid.
 */
const resolveLocalizations = (item, lang, country) => {
  if (!item) {
    return null;
  }

  let localizationsArray = [];

  if (lang && country) {
    // If a specific locale is requested, find it.
    const key = `${lang}-${country}`;
    const specificLoc = item.localizations?.[key];
    if (specificLoc) {
      localizationsArray.push({ lang, country, ...specificLoc });
    }
  } else {
    // Otherwise, convert the entire map to an array.
    localizationsArray = Object.entries(item.localizations || {}).map(([key, locData]) => {
      const [lang, country] = key.split('-');
      return { lang, country, ...locData };
    });
  }

  return {
    ...item,
    localizations: localizationsArray,
  };
};

// Root resolvers for GraphQL operations
const adminRoot = {
  Query: {
    getProductBySku: async ({ sku, lang, country }) => {
      const params = { TableName: TABLE_NAME, Key: { sku } };
      try {
        const { Item } = await docClient.send(new GetCommand(params));
        return resolveLocalizations(Item, lang, country);
      } catch (error) {
        console.error(`DynamoDB Error getting product SKU ${sku}:`, error);
        return null; // Return null as the field is nullable
      }
    },

    getProductsByCategory: async ({ category, lang, country }) => {
      const params = {
        TableName: TABLE_NAME,
        IndexName: CATEGORY_GSI_NAME,
        KeyConditionExpression: "category = :category",
        ExpressionAttributeValues: { ":category": category },
      };
      try {
        const { Items } = await docClient.send(new QueryCommand(params));
        return Items.map((item) => resolveLocalizations(item, lang, country));
      } catch (error) {
        console.error(`DynamoDB Error querying category ${category}:`, error);
        return []; // Return empty array for a non-null list field
      }
    },

    getAllProductsByLocalization: async ({ lang, country, limit, nextToken }) => {
      const key = `${lang}-${country}`;
      const params = {
        TableName: TABLE_NAME,
        Limit: limit || 20,
        FilterExpression: 'attribute_exists(localizations.#key)',
        ExpressionAttributeNames: { '#key': key },
      };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf8"));
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
        const resolvedItems = Items.map((item) => resolveLocalizations(item, lang, country));
        const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64") : null;
        return { items: resolvedItems, nextToken: newNextToken };
      } catch (error) {
        console.error(`DynamoDB Error scanning for localization ${key}:`, error);
        return { items: [], nextToken: null };
      }
    },

    getAllProducts: async ({ limit, nextToken }) => {
      const params = { TableName: TABLE_NAME, Limit: limit || 20 };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf8"));
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
        const resolvedItems = Items.map((item) => resolveLocalizations(item));
        const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64") : null;
        return { items: resolvedItems, nextToken: newNextToken };
      } catch (error) {
        console.error("DynamoDB Error in getAllProducts:", error);
        return { items: [], nextToken: null };
      }
    },
  },

  Mutation: {
    createProduct: async ({ input }) => {
      const localizationsMap = input.localizations.reduce((acc, loc) => {
        const { lang, country, ...locData } = loc;
        acc[`${lang}-${country}`] = locData;
        return acc;
      }, {});

      const item = { ...input, localizations: localizationsMap, lastUpdated: new Date().toISOString() };
      const params = { TableName: TABLE_NAME, Item: item, ConditionExpression: "attribute_not_exists(sku)" };

      try {
        await docClient.send(new PutCommand(params));
        console.log(`Successfully created product with SKU: ${input.sku}`);
        return resolveLocalizations(item);
      } catch (error) {
        if (error.name === "ConditionalCheckFailedException") {
          console.error(`Error: Attempted to create a product with a duplicate SKU: ${input.sku}`);
          throw new Error(`A product with SKU '${input.sku}' already exists.`);
        }
        console.error("DynamoDB createProduct Error:", error);
        throw new Error("Could not create the product.");
      }
    },

    updateProduct: async ({ input }) => {
      const { sku, ...fieldsToUpdate } = input;
      const updateExpressionParts = [];
      const expressionAttributeNames = {};
      const expressionAttributeValues = {};

      Object.entries(fieldsToUpdate).forEach(([key, value], index) => {
        if (value !== undefined && value !== null) {
          updateExpressionParts.push(`#key${index} = :val${index}`);
          expressionAttributeNames[`#key${index}`] = key;
          expressionAttributeValues[`:val${index}`] = value;
        }
      });

      if (updateExpressionParts.length === 0) {
        throw new Error("Update input must contain at least one field to modify.");
      }

      // Always update the 'lastUpdated' timestamp
      updateExpressionParts.push("#lastUpdated = :lastUpdated");
      expressionAttributeNames["#lastUpdated"] = "lastUpdated";
      expressionAttributeValues[":lastUpdated"] = new Date().toISOString();

      const params = {
        TableName: TABLE_NAME,
        Key: { sku },
        UpdateExpression: `SET ${updateExpressionParts.join(", ")}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      };

      try {
        const { Attributes } = await docClient.send(new UpdateCommand(params));
        return resolveLocalizations(Attributes);
      } catch (error) {
        console.error(`DynamoDB updateProduct Error for SKU ${sku}:`, error);
        throw new Error("Could not update the product.");
      }
    },

    deleteProduct: async ({ sku }) => {
        const params = { TableName: TABLE_NAME, Key: { sku }, ReturnValues: "ALL_OLD" };
        try {
            const { Attributes } = await docClient.send(new DeleteCommand(params));
            if (!Attributes) {
                console.warn(`Attempted to delete non-existent product with SKU: ${sku}`);
                return null;
            }
            return resolveLocalizations(Attributes);
        } catch (error) {
            console.error(`DynamoDB deleteProduct Error for SKU ${sku}:`, error);
            throw new Error("Could not delete the product.");
        }
    },

    addLocalization: async ({ sku, localization }) => {
      const { lang, country, ...locData } = localization;
      const key = `${lang}-${country}`;
      const params = {
        TableName: TABLE_NAME,
        Key: { sku },
        UpdateExpression: "SET localizations.#key = :loc, lastUpdated = :now",
        ExpressionAttributeNames: { "#key": key },
        ExpressionAttributeValues: { ":loc": locData, ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      };
      try {
        const { Attributes } = await docClient.send(new UpdateCommand(params));
        return resolveLocalizations(Attributes);
      } catch (error) {
        console.error(`DynamoDB addLocalization Error for SKU ${sku}:`, error);
        throw new Error("Could not add localization.");
      }
    },
    
    // updateLocalization re-uses the same logic as addLocalization
    updateLocalization: async (args) => adminRoot.Mutation.addLocalization(args),

    removeLocalization: async ({ sku, lang, country }) => {
      const key = `${lang}-${country}`;
      const params = {
        TableName: TABLE_NAME,
        Key: { sku },
        UpdateExpression: "REMOVE localizations.#key SET lastUpdated = :now",
        ExpressionAttributeNames: { "#key": key },
        ExpressionAttributeValues: { ":now": new Date().toISOString() },
        ReturnValues: "ALL_NEW",
      };
      try {
        const { Attributes } = await docClient.send(new UpdateCommand(params));
        return resolveLocalizations(Attributes);
      } catch (error) {
        console.error(`DynamoDB removeLocalization Error for SKU ${sku}:`, error);
        throw new Error("Could not remove localization.");
      }
    },
  },
};

// Lambda Handler
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);
    const root = { ...adminRoot.Query, ...adminRoot.Mutation };

    const result = await graphql({
      schema,
      source: query,
      rootValue: root,
      variableValues: variables,
      operationName,
    });

    if (result.errors) {
      console.error("GraphQL execution returned errors:", result.errors);
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error("Critical error in Lambda handler:", error);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ errors: [{ message: error.message || "Invalid GraphQL request." }] }),
    };
  }
};