const { graphql, buildSchema } = require("graphql");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
} = require("@aws-sdk/lib-dynamodb");
const fs = require("fs");
const path = require("path");

// --- AWS SDK Setup ---
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const PRODUCTS_TABLE_NAME = process.env.PRODUCTS_TABLE_NAME || "products";
const CATEGORIES_TABLE_NAME = process.env.CATEGORIES_TABLE_NAME || "categories";
const METADATA_TABLE_NAME = process.env.METADATA_TABLE_NAME || "metadata"; 
const CATEGORY_GSI_NAME = "categoryIndex";

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(
  path.join(__dirname, "schema.graphql"),
  "utf8"
);
const schema = buildSchema(schemaString);

const getLastUpdatedTimestamps = async () => {
  try {
    const [prod, cat] = await Promise.all([
      docClient.send(new GetCommand({
        TableName: METADATA_TABLE_NAME,
        Key: { metadataId: "products_last_update" }
      })),
      docClient.send(new GetCommand({
        TableName: METADATA_TABLE_NAME,
        Key: { metadataId: "categories_last_update" }
      }))
    ]);
    return {
      products: prod.Item?.lastUpdated || null,
      categories: cat.Item?.lastUpdated || null
    };
  } catch (err) {
    console.error("Failed to read metadata table:", err);
    return { products: null, categories: null };
  }
};

// --- Helper Functions ---

/**
 * Formats a DynamoDB product item into a GraphQL Product type, converting the localizations map to an array.
 */
const resolveLocalizations = (item, lang, country) => {
  if (!item) {
    return null;
  }

  let localizationsArray = [];

  if (lang && country) {
    const key = `${lang}-${country}`;
    const specificLoc = item.localizations?.[key];

    if (specificLoc) {
      localizationsArray.push({ lang, country, ...specificLoc });
    } else {
      const localizations = item.localizations || {};
      const allKeys = Object.keys(localizations);

      const langMatchKey = allKeys.find((k) => k.startsWith(`${lang}-`));

      if (langMatchKey) {
        const [matchLang, matchCountry] = langMatchKey.split("-");
        localizationsArray.push({
          lang: matchLang,
          country: matchCountry,
          ...localizations[langMatchKey],
        });
      } else if (localizations["en-us"]) {
        localizationsArray.push({
          lang: "en",
          country: "us",
          ...localizations["en-us"],
        });
      } else if (allKeys.length > 0) {
        const firstKey = allKeys[0];
        const [firstLang, firstCountry] = firstKey.split("-");
        localizationsArray.push({
          lang: firstLang,
          country: firstCountry,
          ...localizations[firstKey],
        });
      }
    }
  } else {
    localizationsArray = Object.entries(item.localizations || {}).map(
      ([key, locData]) => {
        const [lang, country] = key.split("-");
        return { lang, country, ...locData };
      }
    );
  }

  return {
    ...item,
    localizations: localizationsArray,
  };
};

/**
 * Formats a DynamoDB category item into a GraphQL Category type.
 */
const resolveCategory = (item) => {
  if (!item) {
    return null;
  }
  const translationsArray = Object.entries(item.translations || {}).map(
    ([lang, text]) => ({
      lang,
      text,
    })
  );
  return { ...item, translations: translationsArray };
};

// --- Root Resolvers (Read-Only) ---
const readOnlyRoot = {
  Query: {
    
    metadata: async () => {
      const ts = await getLastUpdatedTimestamps();
      return {
        productsLastUpdated: ts.products,
        categoriesLastUpdated: ts.categories
      };
    },

    getProductsBySku: async ({ skus, lang, country }) => {
      if (!skus || skus.length === 0) {
        return [];
      }
      const keys = skus.map((sku) => ({ sku }));
      const params = {
        RequestItems: {
          [PRODUCTS_TABLE_NAME]: {
            Keys: keys,
          },
        },
      };

      try {
        const { Responses } = await docClient.send(new BatchGetCommand(params));
        const items = Responses[PRODUCTS_TABLE_NAME] || [];
        return items.map((item) => resolveLocalizations(item, lang, country));
      } catch (error) {
        console.error(`DynamoDB Error getting products by SKUs:`, error);
        return [];
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
      console.log(`Querying products for localization: ${lang}-${country}`);
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
        const resolvedItems = Items.map((item) =>
          resolveLocalizations(item, lang, country)
        );
        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;

        const ts = await getLastUpdatedTimestamps();
        return {
          items: resolvedItems,
          nextToken: newNextToken,
          lastUpdated: ts.products
        };
      } catch (error) {
        console.error(`DynamoDB Error scanning for localization:`, error);
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
        const ts = await getLastUpdatedTimestamps();
        return {
          items: resolvedItems,
          nextToken: newNextToken,
          lastUpdated: ts.products
        };
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
        const ts = await getLastUpdatedTimestamps();
        return {
          items: Items.map(resolveCategory),
          nextToken: newNextToken,
          lastUpdated: ts.categories
        };
      } catch (error) {
        console.error("DynamoDB Error in getAllCategories:", error);
        return { items: [], nextToken: null };
      }
    },

    getAllCategoriesByLanguage: async ({ lang, limit, nextToken }) => {
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
        const translatedItems = Items.map((item) => ({
          category: item.category,
          text: item.translations[lang] || item.category,
        }));
        const ts = await getLastUpdatedTimestamps();
        return {
          items: translatedItems,
          nextToken: newNextToken,
          lastUpdated: ts.categories
        };
      } catch (error) {
        console.error(
          `DynamoDB Error scanning categories by language ${lang}:`,
          error
        );
        return { items: [], nextToken: null };
      }
    },
  },
};

// --- Lambda Handler ---
exports.handler = async (event) => {
  try {
    const { query, variables, operationName } = JSON.parse(event.body);

    // Safeguard to block mutations
    const { definitions } = require("graphql/language/parser").parse(query);
    const isMutation = definitions.some(
      (def) =>
        def.kind === "OperationDefinition" && def.operation === "mutation"
    );

    if (isMutation) {
      throw new Error("Mutations are not allowed in this read-only endpoint.");
    }

    const result = await graphql({
      schema,
      source: query,
      rootValue: readOnlyRoot.Query,
      variableValues: variables,
      operationName,
    });

    if (result.errors) {
      console.error("GraphQL execution returned errors:", result.errors);
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
    console.error("Error in read-only Lambda handler:", error);
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errors: [{ message: error.message || "Invalid GraphQL request." }],
      }),
    };
  }
};