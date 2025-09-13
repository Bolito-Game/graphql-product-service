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
const PRODUCTS_TABLE_NAME = process.env.PRODUCTS_TABLE_NAME || "products";
const CATEGORIES_TABLE_NAME = process.env.CATEGORIES_TABLE_NAME || "categories";
const CATEGORY_GSI_NAME = "categoryIndex";

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(path.join(__dirname, "schema.graphql"), "utf8");
const schema = buildSchema(schemaString);

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
 * Formats a DynamoDB category item into a GraphQL Category type, converting the translations map to an array.
 * @param {object} item - The category item from DynamoDB.
 * @returns {object|null} A GraphQL Category object or null if the item is invalid.
 */
const resolveCategory = (item) => {
  if (!item) {
    return null;
  }
  const translationsArray = Object.entries(item.translations || {}).map(([lang, text]) => ({
    lang,
    text,
  }));
  return {
    ...item,
    translations: translationsArray,
  };
};

// Root resolvers for GraphQL operations
const adminRoot = {
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

  getAllProductsByLocalization: async ({ lang, country, limit, nextToken }) => {
    const key = `${lang}-${country}`;
    const params = {
      TableName: PRODUCTS_TABLE_NAME,
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
    const params = { TableName: PRODUCTS_TABLE_NAME, Limit: limit || 20 };
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
      params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf8"));
    }
    try {
      const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
      const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64") : null;
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
      params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, "base64").toString("utf8"));
    }
    
    try {
      const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
      const newNextToken = LastEvaluatedKey ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64") : null;

      const translatedItems = Items.map(item => {
        const text =
          (lang && item.translations[lang]) ||
          item.translations['en'] ||
          Object.values(item.translations)[0] || item.category;

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

  createProduct: async ({ input }) => {
    const localizationsMap = input.localizations.reduce((acc, loc) => {
      const { lang, country, ...locData } = loc;
      acc[`${lang}-${country}`] = locData;
      return acc;
    }, {});

    const item = { ...input, localizations: localizationsMap };
    const params = { TableName: PRODUCTS_TABLE_NAME, Item: item, ConditionExpression: "attribute_not_exists(sku)" };

    try {
      await docClient.send(new PutCommand(params));
      return resolveLocalizations(item);
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
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

    const params = {
      TableName: PRODUCTS_TABLE_NAME,
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
    const params = { TableName: PRODUCTS_TABLE_NAME, Key: { sku }, ReturnValues: "ALL_OLD" };
    try {
      const { Attributes } = await docClient.send(new DeleteCommand(params));
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
      TableName: PRODUCTS_TABLE_NAME,
      Key: { sku },
      UpdateExpression: "SET localizations.#key = :loc",
      ExpressionAttributeNames: { "#key": key },
      ExpressionAttributeValues: { ":loc": locData },
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

  updateLocalization: (args) => adminRoot.addLocalization(args),

  removeLocalization: async ({ sku, lang, country }) => {
    const key = `${lang}-${country}`;
    const params = {
      TableName: PRODUCTS_TABLE_NAME,
      Key: { sku },
      UpdateExpression: "REMOVE localizations.#key",
      ExpressionAttributeNames: { "#key": key },
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

  createCategory: async ({ input }) => {
    const translationsMap = input.translations.reduce((acc, { lang, text }) => {
      acc[lang] = text;
      return acc;
    }, {});

    const item = { category: input.category, translations: translationsMap };
    const params = {
      TableName: CATEGORIES_TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(category)",
    };

    try {
      await docClient.send(new PutCommand(params));
      return resolveCategory(item);
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
        throw new Error(`A category with key '${input.category}' already exists.`);
      }
      console.error("DynamoDB createCategory Error:", error);
      throw new Error("Could not create the category.");
    }
  },

  deleteCategory: async ({ category }) => {
    const params = {
      TableName: CATEGORIES_TABLE_NAME,
      Key: { category },
      ReturnValues: "ALL_OLD",
    };
    try {
      const { Attributes } = await docClient.send(new DeleteCommand(params));
      return resolveCategory(Attributes);
    } catch (error) {
      console.error(`DynamoDB deleteCategory Error for ${category}:`, error);
      throw new Error("Could not delete the category.");
    }
  },

  upsertCategoryTranslation: async ({ input }) => {
    const translationsMap = input.translations.reduce((acc, { lang, text }) => {
      acc[lang] = text;
      return acc;
    }, {});

    const item = { category: input.category, translations: translationsMap };
    const params = {
      TableName: CATEGORIES_TABLE_NAME,
      Item: item,
    };

    try {
      await docClient.send(new PutCommand(params));
      return resolveCategory(item);
    } catch (error) {
      console.error("DynamoDB upsertCategoryTranslation Error:", error);
      throw new Error("Could not update or create the category.");
    }
  },

  removeCategoryTranslation: async ({ category, lang }) => {
    const params = {
      TableName: CATEGORIES_TABLE_NAME,
      Key: { category },
      UpdateExpression: "REMOVE translations.#lang",
      ExpressionAttributeNames: { "#lang": lang },
      ReturnValues: "ALL_NEW",
    };
    try {
      const { Attributes } = await docClient.send(new UpdateCommand(params));
      return resolveCategory(Attributes);
    } catch (error) {
      console.error(`DynamoDB removeCategoryTranslation Error for ${category}:`, error);
      throw new Error("Could not remove category translation.");
    }
  },
};

// Lambda Handler
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);
    
    // The rootValue needs all resolvers at the top level
    const rootValue = { ...adminRoot };

    const result = await graphql({
      schema,
      source: query,
      rootValue: rootValue,
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
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ errors: [{ message: error.message || "Invalid GraphQL request." }] }),
    };
  }
};