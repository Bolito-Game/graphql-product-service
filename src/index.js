// index.js - Production-Ready GraphQL Lambda Handler

const { graphql, buildSchema } = require('graphql');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
    DynamoDBDocumentClient, 
    GetCommand, 
    PutCommand, 
    UpdateCommand, 
    DeleteCommand, 
    QueryCommand,
    ScanCommand // For getAllProducts
} = require('@aws-sdk/lib-dynamodb');
const fs = require('fs');
const path = require('path');

// --- AWS SDK Setup ---
const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME || 'Products'; // Use environment variable for table name

// --- Load GraphQL Schema ---
const schemaString = fs.readFileSync(path.join(__dirname, 'schema.graphql'), 'utf8');
const schema = buildSchema(schemaString);

// --- Helper Functions ---

/**
 * Resolves the correct localized data for a product.
 * Falls back to 'en-us' if the requested locale is not found.
 * @param {object} dynamoDBItem - The full item retrieved from DynamoDB.
 * @param {string} lang - ISO 2-letter language code.
 * @param {string} country - ISO 2-letter country code.
 * @returns {object} A fully resolved Product object.
 */
const resolveLocalization = (dynamoDBItem, lang, country) => {
    if (!dynamoDBItem) return null;
    
    const localeKey = `${lang}-${country}`;
    const defaultLocaleKey = 'en-us';
    
    const localizedData = dynamoDBItem.Localizations[localeKey] || dynamoDBItem.Localizations[defaultLocaleKey];
    
    if (!localizedData) {
        // This case occurs if even the 'en-us' default is missing.
        // Return base data with placeholders to indicate missing localization.
        return {
            ...dynamoDBItem,
            Category_Text: "Localization Not Found",
            Name: "Localization Not Found",
            Description: "",
            Price: 0,
            Currency: "N/A"
        };
    }
    
    // Combine base data with the resolved localized data
    return {
        SKU: dynamoDBItem.SKU,
        Category: dynamoDBItem.Category,
        Image_URL: dynamoDBItem.Image_URL,
        Status: dynamoDBItem.Status,
        Last_Updated: dynamoDBItem.Last_Updated,
        Quantity_In_Stock: dynamoDBItem.Quantity_In_Stock,
        ...localizedData
    };
};

/**
 * Creates a standardized mutation response object.
 * @param {boolean} success - Whether the mutation was successful.
 * @param {object} product - The resulting product object.
 * @param {Array<object>} errors - A list of error objects.
 * @returns {object} A MutationResponse object.
 */
const createMutationResponse = ({ success, product = null, errors = [] }) => ({
    success,
    product,
    errors,
});

// --- GraphQL Resolvers ---
const root = {
    // === QUERIES ===
    getProductBySKU: async ({ SKU, lang, country }) => {
        const command = new GetCommand({ TableName: TABLE_NAME, Key: { SKU } });
        try {
            const { Item } = await docClient.send(command);
            if (!Item) {
                return { errors: [{ message: `Product with SKU '${SKU}' not found.` }] };
            }
            return { product: resolveLocalization(Item, lang, country) };
        } catch (error) {
            console.error("DynamoDB Error:", error);
            return { errors: [{ message: 'An internal error occurred while fetching the product.' }] };
        }
    },

    getProductsByCategory: async ({ category, lang, country }) => {
        const command = new QueryCommand({
            TableName: TABLE_NAME,
            IndexName: 'CategoryIndex',
            KeyConditionExpression: 'Category = :category',
            ExpressionAttributeValues: { ':category': category },
        });
        try {
            const { Items } = await docClient.send(command);
            return Items.map(item => resolveLocalization(item, lang, country));
        } catch (error) {
            console.error("DynamoDB Error:", error);
            return []; // Return empty array on error as per schema `[Product]!`
        }
    },
    
    getAllProducts: async ({ lang, country, limit, nextToken }) => {
        const params = {
            TableName: TABLE_NAME,
            Limit: limit,
        };

        if (nextToken) {
            // The token from the client is a Base64 encoded JSON string of the ExclusiveStartKey
            params.ExclusiveStartKey = JSON.parse(Buffer.from(nextToken, 'base64').toString('utf8'));
        }

        try {
            const { Items, LastEvaluatedKey } = await docClient.send(new ScanCommand(params));
            const resolvedItems = Items.map(item => resolveLocalization(item, lang, country));
            
            let newNextToken = null;
            if (LastEvaluatedKey) {
                // Encode the LastEvaluatedKey to be sent back to the client
                newNextToken = Buffer.from(JSON.stringify(LastEvaluatedKey)).toString('base64');
            }

            return { items: resolvedItems, nextToken: newNextToken };
        } catch (error) {
            console.error("DynamoDB Error:", error);
            // Return an empty connection on error to satisfy the non-null schema
            return { items: [], nextToken: null };
        }
    },

    // === MUTATIONS ===
    createProduct: async ({ input }) => {
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
            ConditionExpression: 'attribute_not_exists(SKU)', // Prevent overwriting existing items
        });

        try {
            await docClient.send(command);
            const resolvedProduct = resolveLocalization(item, 'en', 'us');
            return createMutationResponse({ success: true, product: resolvedProduct });
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') {
                return createMutationResponse({ success: false, errors: [{ field: 'SKU', message: `Product with SKU '${input.SKU}' already exists.` }] });
            }
            console.error("DynamoDB Error:", error);
            return createMutationResponse({ success: false, errors: [{ message: 'Could not create product due to an internal error.' }] });
        }
    },
    
    updateProduct: async ({ input }) => {
        const { SKU, localizations, ...updates } = input;
        
        let updateExpression = 'SET Last_Updated = :lastUpdated';
        const expressionAttributeValues = { ':lastUpdated': new Date().toISOString() };
        const expressionAttributeNames = {};

        // Dynamically build the update expression for top-level attributes
        for (const [key, value] of Object.entries(updates)) {
            if (value !== undefined && value !== null) {
                const attrValue = `:${key}`;
                updateExpression += `, ${key} = ${attrValue}`;
                expressionAttributeValues[attrValue] = value;
            }
        }
        
        // Dynamically build the update expression for nested localizations
        if (localizations && localizations.length > 0) {
            localizations.forEach((loc, index) => {
                const { lang, country, ...data } = loc;
                const localeKey = `${lang.toLowerCase()}-${country.toLowerCase()}`;
                const attrNameKey = `#loc${index}`;
                const attrValueKey = `:loc${index}`;
                
                updateExpression += `, #Localizations.#${attrNameKey} = ${attrValueKey}`;
                expressionAttributeNames[`#Localizations`] = 'Localizations';
                expressionAttributeNames[`#${attrNameKey}`] = localeKey;
                expressionAttributeValues[attrValueKey] = data;
            });
        }
        
        const command = new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { SKU },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ReturnValues: 'ALL_NEW', // Return the entire item as it appears after the update
            ConditionExpression: 'attribute_exists(SKU)', // Ensure the item exists before updating
        });
        
        try {
            const { Attributes } = await docClient.send(command);
            const resolvedProduct = resolveLocalization(Attributes, 'en', 'us');
            return createMutationResponse({ success: true, product: resolvedProduct });
        } catch (error) {
            if (error.name === 'ConditionalCheckFailedException') {
                return createMutationResponse({ success: false, errors: [{ field: 'SKU', message: `Product with SKU '${SKU}' not found.` }] });
            }
            console.error("DynamoDB Error:", error);
            return createMutationResponse({ success: false, errors: [{ message: 'Could not update product due to an internal error.' }] });
        }
    },

    deleteProduct: async ({ SKU }) => {
        const command = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { SKU },
            ReturnValues: 'ALL_OLD', // Returns the item that was deleted
        });

        try {
            const { Attributes } = await docClient.send(command);
            if (!Attributes) {
                return createMutationResponse({ success: false, errors: [{ field: 'SKU', message: `Product with SKU '${SKU}' not found.` }] });
            }
            const resolvedProduct = resolveLocalization(Attributes, 'en', 'us');
            return createMutationResponse({ success: true, product: resolvedProduct });
        } catch (error) {
            console.error("DynamoDB Error:", error);
            return createMutationResponse({ success: false, errors: [{ message: 'Could not delete product due to an internal error.' }] });
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
            rootValue: root,
            variableValues: variables,
            operationName,
        });

        return {
            statusCode: 200,
            headers: { 
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*" // Be more restrictive in a real production environment
            },
            body: JSON.stringify(result),
        };

    } catch (error) {
        console.error('Unhandled GraphQL Error:', error);
        return {
            statusCode: 400,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ errors: [{ message: error.message || 'Invalid GraphQL request.' }] }),
        };
    }
};