const { graphql, buildSchema } = require("graphql");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb"); // Removed write commands
const fs = require("fs");
const path = require("path");

// --- AWS SDK Setup ---
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const PRODUCTS_TABLE_NAME = process.env.PRODUCTS_TABLE_NAME || "products";
const CATEGORIES_TABLE_NAME = process.env.CATEGORIES_TABLE_NAME || "categories";
const CATEGORY_GSI_NAME = "categoryIndex";

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(path.join(__dirname, "schema.graphql"), "utf8");
const schema = buildSchema(schemaString);

// --- Helper Functions ---

/**
 * Formats a DynamoDB product item into a GraphQL Product type. It selects a single
 * best-fit localization based on the provided lang and country, with specific fallback rules.
 *
 * @param {object} item - The item retrieved from DynamoDB.
 * @param {string} [lang] - The desired language code (e.g., "en").
 * @param {string} [country] - The desired country code (e.g., "us").
 * @returns {object|null} A GraphQL Product object with a single localization, or null if the item is invalid.
 */
const resolveLocalizations = (item, lang, country) => {
  // Rule: If there is no item, return null.
  if (!item) {
    return null;
  }

  // Helper to safely access localizations, defaulting to an empty object if undefined.
  const localizations = item.localizations || {};
  const allLocalizationKeys = Object.keys(localizations);
  let selectedKey = null;

  // Rule 1: Look for an exact "lang-country" match.
  const exactKey = `${lang}-${country}`;
  if (localizations[exactKey]) {
    selectedKey = exactKey;
  }

  // Rule 2: If no exact match, find any key with the same language.
  if (!selectedKey && lang) {
    const langMatches = allLocalizationKeys.filter(key => key.startsWith(`${lang}-`));

    if (langMatches.length > 0) {
      // Prioritize "lang-us" if multiple language matches exist.
      const usKey = `${lang}-us`;
      if (langMatches.includes(usKey)) {
        selectedKey = usKey;
      } else {
        // Otherwise, use the first language match found.
        selectedKey = langMatches[0];
      }
    }
  }

  // Rule 3: If still no match, use "en-us" as the default.
  if (!selectedKey && localizations['en-us']) {
    selectedKey = 'en-us';
  }
  
  // Rule 4: If "en-us" is not found, use the very first localization in the response.
  if (!selectedKey && allLocalizationKeys.length > 0) {
    selectedKey = allLocalizationKeys[0];
  }

  let finalLocalizations = [];
  if (selectedKey) {
    const [selectedLang, selectedCountry] = selectedKey.split('-');
    finalLocalizations.push({
      lang: selectedLang,
      country: selectedCountry,
      ...localizations[selectedKey],
    });
  }
  return {
    ...item,
    localizations: finalLocalizations,
  };
};

/**
 * Formats a DynamoDB category item into a GraphQL Category type.
 */
const resolveCategory = (item) => {
  if (!item) {
    return null;
  }
  const translationsArray = Object.entries(item.translations || {}).map(([lang, text]) => ({
    lang,
    text,
  }));
  return { ...item, translations: translationsArray };
};

// --- Root Resolvers (Read-Only) ---
const readOnlyRoot = {
  Query: {
    getProductBySku: async ({ sku, lang, country }) => {
      const params = { TableName: PRODUCTS_TABLE_NAME, Key: { sku } };
      try {
        const { Item } = await docClient.send(new GetCommand(params));
        return resolveLocalizations(Item, lang, country);
      } catch (error) {
        console.error(`DynamoDB Error getting product SKU ${sku}:`, error);
        return null;
      }
    },
    getProductsByCategory: async ({ category, lang, country }) => {
      const params = {
        TableName: PRODUCTS_TABLE_NAME,
        IndexName: CATEGORY_GSI_NAME,
        KeyConditionExpression: "category = :category",
        ExpressionAttributeValues: { ":category": category },
      };
      try {
        const { Items } = await docClient.send(new QueryCommand(params));
        return Items.map((item) => resolveLocalizations(item, lang, country));
      } catch (error) {
        console.error(`DynamoDB Error querying category ${category}:`, error);
        return [];
      }
    },
    getAllProductsByLocalization: async ({
      lang,
      country,
      limit,
      nextToken,
    }) => {
      const key = `${lang}-${country}`;
      const params = {
        TableName: PRODUCTS_TABLE_NAME,
        Limit: limit || 20,
        FilterExpression: "attribute_exists(localizations.#key)",
        ExpressionAttributeNames: { "#key": key },
      };
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
          resolveLocalizations(item, lang, country)
        );
        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;
        return { items: resolvedItems, nextToken: newNextToken };
      } catch (error) {
        console.error(
          `DynamoDB Error scanning for localization ${key}:`,
          error
        );
        return { items: [], nextToken: null };
      }
    },
    getAllProducts: async ({ limit, nextToken }) => {
      const params = { TableName: PRODUCTS_TABLE_NAME, Limit: limit || 20 };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, "base64").toString("utf8")
        );
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(
          new ScanCommand(params)
        );
        const resolvedItems = Items.map((item) => resolveLocalizations(item));
        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;
        return { items: resolvedItems, nextToken: newNextToken };
      } catch (error) {
        console.error("DynamoDB Error in getAllProducts:", error);
        return { items: [], nextToken: null };
      }
    },
    getCategory: async ({ category }) => {
      const params = { TableName: CATEGORIES_TABLE_NAME, Key: { category } };
      try {
        const { Item } = await docClient.send(new GetCommand(params));
        return resolveCategory(Item);
      } catch (error) {
        console.error(`DynamoDB Error getting category ${category}:`, error);
        return null;
      }
    },
    getAllCategories: async ({ limit, nextToken }) => {
      const params = { TableName: CATEGORIES_TABLE_NAME, Limit: limit || 20 };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, "base64").toString("utf8")
        );
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(
          new ScanCommand(params)
        );
        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;
        return {
          items: Items.map(resolveCategory),
          nextToken: newNextToken,
        };
      } catch (error) {
        console.error("DynamoDB Error in getAllCategories:", error);
        return { items: [], nextToken: null };
      }
    },
    getAllCategoriesByLanguage: async ({ lang, limit, nextToken }) => {
      const params = {
        TableName: CATEGORIES_TABLE_NAME,
        Limit: limit || 20,
      };

      if (lang) {
        params.FilterExpression = "attribute_exists(translations.#primary) OR attribute_exists(translations.#fallback)";
        params.ExpressionAttributeNames = {
          "#primary": lang,
          "#fallback": "en",
        };
      } else {
        params.FilterExpression = "attribute_exists(translations.#fallback)";
        params.ExpressionAttributeNames = {
          "#fallback": "en",
        };
      }

      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, "base64").toString("utf8")
        );
      }

      try {
        const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;

        const translatedItems = Items.map((item) => {
          const text =
            (lang && item.translations[lang]) ||
            item.translations["en"] ||
            Object.values(item.translations)[0] ||
            item.category;

          return {
            category: item.category,
            text: text,
          };
        });

        return {
          items: translatedItems,
          nextToken: newNextToken,
        };
        
      } catch (error) {
        console.error(`DynamoDB Error scanning categories:`, error);
        return { items: [], nextToken: null };
      }
    },
  },
};

// --- Lambda Handler ---
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);

    // Safeguard to block mutations if they appear in the query string
    const { definitions } = require('graphql/language/parser').parse(query);
    const isMutation = definitions.some(def => def.kind === 'OperationDefinition' && def.operation === 'mutation');
    
    if (isMutation) {
        throw new Error("Mutations are not allowed in this read-only endpoint.");
    }

    const result = await graphql({
      schema,
      source: query,
      rootValue: readOnlyRoot.Query, // Use only the Query resolvers
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
    console.error("Error in read-only Lambda handler:", error);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ errors: [{ message: error.message || "Invalid GraphQL request." }] }),
    };
  }
};