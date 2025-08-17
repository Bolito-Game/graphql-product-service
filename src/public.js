const { graphql, buildSchema } = require("graphql");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb"); // Removed write commands
const fs = require("fs");
const path = require("path");

// --- AWS SDK Setup ---
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || "Products";
const CATEGORY_GSI_NAME = "CategoryIndex";

// --- Load GraphQL Schema ---
// Note: Your schema.graphql should ideally not contain Mutation types for this endpoint.
const schemaString = fs.readFileSync(path.join(__dirname, "schema.graphql"), "utf8");
const schema = buildSchema(schemaString);

/**
 * Formats a DynamoDB item into a GraphQL Product type, converting the localizations map to an array.
 * @param {object} item - The item retrieved from DynamoDB.
 * @param {string} [lang] - Optional language code to filter localizations.
 * @param {string} [country] - Optional country code to filter localizations.
 * @returns {object|null} A GraphQL Product object or null if the item is invalid.
 */
const resolveLocalizations = (item, lang, country) => {
  if (!item) {
    return null;
  }

  let localizationsArray = [];

  if (lang && country) {
    // If a specific locale is requested, find it.
    const key = `${lang}-${country}`;
    const specificLoc = item.localizations?.[key];
    if (specificLoc) {
      localizationsArray.push({ lang, country, ...specificLoc });
    }
  } else {
    // Otherwise, convert the entire map to an array.
    localizationsArray = Object.entries(item.localizations || {}).map(([key, locData]) => {
      const [lang, country] = key.split('-');
      return { lang, country, ...locData };
    });
  }

  return {
    ...item,
    localizations: localizationsArray,
  };
};

// Root resolvers containing only Query operations
const readOnlyRoot = {
  Query: {
    getProductBySku: async ({ sku, lang, country }) => {
      const params = { TableName: TABLE_NAME, Key: { sku } };
      try {
        const { Item } = await docClient.send(new GetCommand(params));
        return resolveLocalizations(Item, lang, country);
      } catch (error) {
        console.error(`DynamoDB Error getting product SKU ${sku}:`, error);
        return null;
      }
    },

    getProductsByCategory: async ({ category, lang, country }) => {
      const params = {
        TableName: TABLE_NAME,
        IndexName: CATEGORY_GSI_NAME,
        KeyConditionExpression: "category = :category",
        ExpressionAttributeValues: { ":category": category },
      };
      try {
        const { Items } = await docClient.send(new QueryCommand(params));
        return Items.map((item) => resolveLocalizations(item, lang, country));
      } catch (error) {
        console.error(`DynamoDB Error querying category ${category}:`, error);
        return [];
      }
    },

    getAllProductsByLocalization: async ({ lang, country, limit, nextToken }) => {
      const key = `${lang}-${country}`;
      const params = {
        TableName: TABLE_NAME,
        Limit: limit || 20,
        FilterExpression: 'attribute_exists(localizations.#key)',
        ExpressionAttributeNames: { '#key': key },
      };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf8"));
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
        const resolvedItems = Items.map((item) => resolveLocalizations(item, lang, country));
        const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64") : null;
        return { items: resolvedItems, nextToken: newNextToken };
      } catch (error) {
        console.error(`DynamoDB Error scanning for localization ${key}:`, error);
        return { items: [], nextToken: null };
      }
    },

    getAllProducts: async ({ limit, nextToken }) => {
      const params = { TableName: TABLE_NAME, Limit: limit || 20 };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf8"));
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
        const resolvedItems = Items.map((item) => resolveLocalizations(item));
        const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64") : null;
        return { items: resolvedItems, nextToken: newNextToken };
      } catch (error) {
        console.error("DynamoDB Error in getAllProducts:", error);
        return { items: [], nextToken: null };
      }
    },
  },
  
};

// Lambda Handler
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);

    // If an operation is a Mutation, block it. 
    // This is a safeguard in case the schema still contains Mutation types.
    const { definitions } = require('graphql/language/parser').parse(query);
    const isMutation = definitions.some(def => def.kind === 'OperationDefinition' && def.operation === 'mutation');
    
    if (isMutation) {
        throw new Error("Mutations are not allowed in this read-only endpoint.");
    }

    const result = await graphql({
      schema,
      source: query,
      rootValue: readOnlyRoot.Query, // Use only the Query resolvers
      variableValues: variables,
      operationName,
    });

    if (result.errors) {
      console.error("GraphQL execution returned errors:", result.errors);
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error("Error in read-only Lambda handler:", error);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ errors: [{ message: error.message || "Invalid GraphQL request." }] }),
    };
  }
};