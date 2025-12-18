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

// Helper to update metadata timestamp
const updateMetadataTimestamp = async (type) => {
  const now = new Date().toISOString();
  await docClient.send(
    new PutCommand({
      TableName: METADATA_TABLE_NAME,
      Item: {
        metadataId:
          type === "product"
            ? "products_last_update"
            : "categories_last_update",
        value: now,
      },
    })
  );
};

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

// Root resolvers for GraphQL operations
const adminRoot = {
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
      return items.map((item) => resolveLocalizations(item));
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
      const resolvedItems = Items.map((item) => resolveLocalizations(item));
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

  searchProducts: async ({ search, limit, nextToken }) => {
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

      const resolvedItems = Items.map((item) => resolveLocalizations(item));

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

  searchCategories: async ({ search, limit, nextToken }) => {
    if (!search) {
      const ts = await getLastUpdatedTimestamps();
      return { items: [], nextToken: null, lastUpdated: ts.categories };
    }

    const params = {
      TableName: CATEGORIES_TABLE_NAME,
      Limit: limit || 20,
      FilterExpression: "begins_with(#categoryAttr, :searchString)",
      ExpressionAttributeNames: { "#categoryAttr": "category" },
      ExpressionAttributeValues: { ":searchString": search },
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

      const resolvedItems = Items.map(resolveCategory);

      const newNextToken = LastEvaluatedKey
        ? Buffer.from(JSON.stringify(LastEvaluatedKey)).toString("base64")
        : null;
      const ts = await getLastUpdatedTimestamps();

      return {
        items: resolvedItems,
        nextToken: newNextToken,
        lastUpdated: ts.categories,
      };
    } catch (error) {
      console.error("DynamoDB Error in searchCategories:", error);
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

  createProduct: async ({ input }) => {
    const localizationsMap = input.localizations.reduce((acc, loc) => {
      const { lang, country, ...locData } = loc;
      acc[`${lang}-${country}`] = locData;
      return acc;
    }, {});

    // Determine productNameLower for GSI keys
    const defaultLocale = await getDefaultLocale();
    let productNameLower = null;

    const defaultLocalization = input.localizations.find(
      (loc) => `${loc.lang}-${loc.country}` === defaultLocale
    );
    if (defaultLocalization && defaultLocalization.productName) {
      productNameLower = defaultLocalization.productName.toLowerCase();
    } else if (
      input.localizations.length > 0 &&
      input.localizations[0].productName
    ) {
      productNameLower = input.localizations[0].productName.toLowerCase();
    }

    const item = {
      ...input,
      localizations: localizationsMap,
      searchKey: GLOBAL_SEARCH_KEY,
    };

    if (productNameLower !== null) {
      item.productNameLower = productNameLower;
    }

    const params = {
      TableName: PRODUCTS_TABLE_NAME,
      Item: item,
      ConditionExpression: "attribute_not_exists(sku)",
    };

    try {
      await docClient.send(new PutCommand(params));
      await updateMetadataTimestamp("product");
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
      throw new Error(
        "Update input must contain at least one field to modify."
      );
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
      await updateMetadataTimestamp("product");
      return resolveLocalizations(Attributes);
    } catch (error) {
      console.error(`DynamoDB updateProduct Error for SKU ${sku}:`, error);
      throw new Error("Could not update the product.");
    }
  },

  deleteProduct: async ({ sku }) => {
    const params = {
      TableName: PRODUCTS_TABLE_NAME,
      Key: { sku },
      ReturnValues: "ALL_OLD",
    };
    try {
      const { Attributes } = await docClient.send(new DeleteCommand(params));
      await updateMetadataTimestamp("product"); // ← ADDED
      return resolveLocalizations(Attributes);
    } catch (error) {
      console.error(`DynamoDB deleteProduct Error for SKU ${sku}:`, error);
      throw new Error("Could not delete the product.");
    }
  },

  addLocalization: async ({ sku, localizations }) => {
    const updateExpressionParts = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};

    const defaultLocaleKey = await getDefaultLocale();

    let productNameLowerValue = null;
    let fallbackProductName = null;

    localizations.forEach((loc, index) => {
      const { lang, country, ...locData } = loc;
      const key = `${lang}-${country}`;

      // Build the SET for localizations
      updateExpressionParts.push(`localizations.#key${index} = :loc${index}`);
      expressionAttributeNames[`#key${index}`] = key;
      expressionAttributeValues[`:loc${index}`] = locData;

      if (!fallbackProductName && locData.productName) {
        fallbackProductName = locData.productName;
      }

      // If this localization matches the default locale → prioritize it
      if (defaultLocaleKey && key === defaultLocaleKey && locData.productName) {
        productNameLowerValue = locData.productName.toLowerCase();
      }
    });

    if (!productNameLowerValue && fallbackProductName) {
      productNameLowerValue = fallbackProductName.toLowerCase();
    }

    // --- Handling GSI Keys ---

    // 1. Always ensure searchKey is set (needed for Query/Scan on the new index)
    updateExpressionParts.push(`searchKey = :searchKeyVal`);
    expressionAttributeValues[`:searchKeyVal`] = GLOBAL_SEARCH_KEY;

    // 2. Add or Remove productNameLower to control indexing/searchability
    if (productNameLowerValue !== null) {
      // If we have a product name, SET it (this updates the Sort Key and indexes the item)
      updateExpressionParts.push(`productNameLower = :productNameLowerVal`);
      expressionAttributeValues[`:productNameLowerVal`] = productNameLowerValue;
    } else {
      // If we don't have a product name (after removing the last one, for example),
      // we must explicitly REMOVE it to de-index the item from the GSI.
      // NOTE: This logic is tricky here as it only runs if no name is found in the *new* localizations.
      // A full removal/clearing of productNameLower would require a separate UpdateExpression
      // or a preceding Get to determine if the name was removed. For simplicity here, we assume
      // if it's set in the update, it will use the value, otherwise it remains or needs a separate REMOVE.
    }

    // Build final Update params
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
      await updateMetadataTimestamp("product");
      return resolveLocalizations(Attributes);
    } catch (error) {
      console.error(`DynamoDB addLocalization Error for SKU ${sku}:`, error);
      throw new Error("Could not add localizations.");
    }
  },

  updateLocalization: async ({ sku, localizations }) => {
    // Reuse the same logic as addLocalization since it overwrites existing keys
    return adminRoot.addLocalization({ sku, localizations });
  },

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
      await updateMetadataTimestamp("product");
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
      await updateMetadataTimestamp("category");
      return resolveCategory(item);
    } catch (error) {
      if (error.name === "ConditionalCheckFailedException") {
        throw new Error(
          `A category with key '${input.category}' already exists.`
        );
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
      await updateMetadataTimestamp("category"); // ← ADDED
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
      await updateMetadataTimestamp("category");
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
      await updateMetadataTimestamp("category");
      return resolveCategory(Attributes);
    } catch (error) {
      console.error(
        `DynamoDB removeCategoryTranslation Error for ${category}:`,
        error
      );
      throw new Error("Could not remove category translation.");
    }
  },

  setDefaultLocale: async ({ locale }) => {
    // Basic validation: ensure it's a valid locale format (xx-xx)
    const localeRegex = /^[a-z]{2}-[a-z]{2}$/i;
    if (!locale || !localeRegex.test(locale.trim())) {
      throw new Error(
        "Invalid locale format. Expected format: 'en-us', 'es-mx', etc."
      );
    }

    const normalizedLocale = locale.trim().toLowerCase();

    const params = {
      TableName: METADATA_TABLE_NAME,
      Item: {
        metadataId: "default_locale",
        value: normalizedLocale,
      },
    };

    try {
      await docClient.send(new PutCommand(params));
      cachedDefaultLocale = normalizedLocale; // Invalidate cache so next read picks up the new value
      await updateMetadataTimestamp("product");
      return normalizedLocale; // success response
    } catch (error) {
      console.error("Failed to set default_locale:", error);
      throw new Error("Could not set default locale.");
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
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(result),
    };
  } catch (error) {
    console.error("Critical error in Lambda handler:", error);
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        errors: [{ message: error.message || "Invalid GraphQL request." }],
      }),
    };
  }
};