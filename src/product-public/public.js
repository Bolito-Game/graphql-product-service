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
const GLOBAL_SEARCH_KEY = "PRODUCTS";

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(
  path.join(__dirname, "schema.graphql"),
  "utf8"
);
const schema = buildSchema(schemaString);

// Helper to read both timestamps
const getLastUpdatedTimestamps = async () => {
  const [prod, cat] = await Promise.all([
    docClient.send(
      new GetCommand({
        TableName: METADATA_TABLE_NAME,
        Key: { metadataId: "products_last_update" },
      })
    ),
    docClient.send(
      new GetCommand({
        TableName: METADATA_TABLE_NAME,
        Key: { metadataId: "categories_last_update" },
      })
    ),
  ]);
  return {
    products: prod.Item?.value || null,
    categories: cat.Item?.value || null,
  };
};

// Helper to read the default locale
let cachedDefaultLocale = null;

const getDefaultLocale = async () => {
  if (cachedDefaultLocale !== null) {
    return cachedDefaultLocale;
  }

  try {
    const { Item } = await docClient.send(
      new GetCommand({
        TableName: METADATA_TABLE_NAME,
        Key: { metadataId: "default_locale" },
      })
    );
    cachedDefaultLocale = Item?.value || null;
    return cachedDefaultLocale;
  } catch (err) {
    console.error("Failed to read default_locale from Metadata table", err);
    cachedDefaultLocale = null;
    return null;
  }
};

/**
 * Formats a DynamoDB product item into a GraphQL Product type, converting the localizations map to an array.
 * @param {object} item - The item retrieved from DynamoDB.
 * @param {string} [lang] - Optional language code to filter localizations.
 * @param {string} [country] - Optional country code to filter localizations.
 * @returns {object|null} A GraphQL Product object or null if the item is invalid.
 */
const resolveLocalizations = async (item, lang, country) => {
  if (!item) return null;

  const localizations = item.localizations || {};
  const allKeys = Object.keys(localizations);

  if (allKeys.length === 0) {
    // No localizations at all
    return { ...item, localizations: [] };
  }

  // ———————————————————————————————————————————————
  // 1. Specific locale requested → return exactly ONE
  // ———————————————————————————————————————————————
  if (lang && country) {
    const exactKey = `${lang}-${country}`;

    // Exact match
    if (localizations[exactKey]) {
      const [l, c] = exactKey.split("-");
      return {
        ...item,
        localizations: [{ lang: l, country: c, ...localizations[exactKey] }],
      };
    }

    // Same language, any country
    const langMatch = allKeys.find((k) => k.startsWith(`${lang}-`));
    if (langMatch) {
      const [l, c] = langMatch.split("-");
      return {
        ...item,
        localizations: [{ lang: l, country: c, ...localizations[langMatch] }],
      };
    }

    // Merchant default locale
    const defaultKey = await getDefaultLocale();
    if (defaultKey && localizations[defaultKey]) {
      const [l, c] = defaultKey.split("-");
      return {
        ...item,
        localizations: [{ lang: l, country: c, ...localizations[defaultKey] }],
      };
    }

    // Ultimate fallback: first available
    const [l, c] = allKeys[0].split("-");
    return {
      ...item,
      localizations: [{ lang: l, country: c, ...localizations[allKeys[0]] }],
    };
  }

  // ———————————————————————————————————————————————
  // 2. No specific locale → return ALL, default first
  // ———————————————————————————————————————————————
  const result = [];

  const defaultKey = await getDefaultLocale();

  // Put merchant default first (if it exists in this product)
  if (defaultKey && localizations[defaultKey]) {
    const [l, c] = defaultKey.split("-");
    result.push({ lang: l, country: c, ...localizations[defaultKey] });
  }

  // Add the rest (skip the default if we already added it)
  allKeys.forEach((key) => {
    if (key !== defaultKey) {
      const [l, c] = key.split("-");
      result.push({ lang: l, country: c, ...localizations[key] });
    }
  });

  return { ...item, localizations: result };
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
  const translationsArray = Object.entries(item.translations || {}).map(
    ([lang, text]) => ({
      lang,
      text,
    })
  );
  return {
    ...item,
    translations: translationsArray,
  };
};

// --- Root Resolvers (Read-Only) ---
const readOnlyRoot = {
  Query: {
    
    metadata: async () => {
      const [prod, cat, loc] = await Promise.all([
        docClient.send(
          new GetCommand({
            TableName: METADATA_TABLE_NAME,
            Key: { metadataId: "products_last_update" },
          })
        ),
        docClient.send(
          new GetCommand({
            TableName: METADATA_TABLE_NAME,
            Key: { metadataId: "categories_last_update" },
          })
        ),
        docClient.send(
          new GetCommand({
            TableName: METADATA_TABLE_NAME,
            Key: { metadataId: "default_locale" },
          })
        ),
      ]);
      return {
        productsLastUpdated: prod.Item?.value || null,
        categoriesLastUpdated: cat.Item?.value || null,
        defaultLocale: loc.Item?.value || null,
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

    getProductsByCategory: async ({
      category,
      lang,
      country,
      limit,
      nextToken,
    }) => {
      const params = {
        TableName: PRODUCTS_TABLE_NAME,
        IndexName: CATEGORY_GSI_NAME,
        KeyConditionExpression: "category = :category",
        ExpressionAttributeValues: { ":category": category },
        Limit: limit || 20,
      };
      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, "base64").toString("utf8")
        );
      }
      try {
        const { Items, LastEvaluatedKey } = await docClient.send(
          new QueryCommand(params)
        );
        const resolvedItems = Items.map((item) => resolveLocalizations(item, lang, country));
        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;

        const ts = await getLastUpdatedTimestamps();

        return {
          items: resolvedItems,
          nextToken: newNextToken,
          lastUpdated: ts.products,
        };
      } catch (error) {
        console.error(`DynamoDB Error querying category ${category}:`, error);
        return {
          items: [],
          nextToken: null,
          lastUpdated: new Date().toISOString(),
        };
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
        console.error(`DynamoDB Error scanning for localization ${key}:`, error);
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

    searchProducts: async ({ 
      search, 
      lang,
      country,
      limit,
      nextToken,
    }) => {
      if (!search) {
        const ts = await getLastUpdatedTimestamps();
        return { items: [], nextToken: null, lastUpdated: ts.products };
      }

      const searchPrefix = search.trim().toLowerCase();

      const params = {
        TableName: PRODUCTS_TABLE_NAME,
        IndexName: "productSearchIndex",
        Limit: limit || 20,
        KeyConditionExpression:
          "#hk = :hkVal AND begins_with(#sk, :searchPrefix)",
        ExpressionAttributeNames: {
          "#hk": "searchKey",
          "#sk": "productNameLower",
        },
        ExpressionAttributeValues: {
          ":hkVal": GLOBAL_SEARCH_KEY, // Constant value HASH key
          ":searchPrefix": searchPrefix, // The 'starts with' value for the Sort Key
        },
      };

      if (nextToken) {
        params.ExclusiveStartKey = JSON.parse(
          Buffer.from(nextToken, "base64").toString("utf8")
        );
      }

      try {
        const { Items, LastEvaluatedKey } = await docClient.send(
          new QueryCommand(params)
        );

        const resolvedItems = Items.map((item) => resolveLocalizations(item, lang, country));

        const newNextToken = LastEvaluatedKey
          ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
          : null;
        const ts = await getLastUpdatedTimestamps();

        return {
          items: resolvedItems,
          nextToken: newNextToken,
          lastUpdated: ts.products,
        };
      } catch (error) {
        console.error("DynamoDB Error in searchProducts:", error);
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