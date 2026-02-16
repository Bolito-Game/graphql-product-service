# GraphQL Product Service

This project contains a unified serverless stack for a GraphQL-based product and order management system. It includes an Admin API, a Public API, and integrated PayPal payment processing. The application is built using the AWS Serverless Application Model (SAM) and is ready for deployment to AWS.

---

## Project Structure

* **`src/`**: Contains the source code for all Lambda functions:
    * **`product-admin`**: GraphQL API for administrative tasks (Products, Categories, Metadata, Order Events).
    * **`product-public`**: GraphQL API for public catalog access.
    * **`paypal-create-order`**: Logic for initiating PayPal transactions.
    * **`paypal-capture-order`**: Logic for finalizing PayPal payments.
    * **`paypal-webhook`**: Handler for PayPal event notifications.
* **`template.yaml`**: The AWS SAM template defining the DynamoDB tables, Lambda functions, API Gateway, Cognito User Pool, and CloudFront distribution.
* **`samconfig.toml`**: Default deployment parameters, including environment-specific overrides for the `us-east-2` region.

---

## Infrastructure Overview

### 1. Database (DynamoDB)
The system uses the following tables:
* **Products**: Managed via `sku` (Hash Key) with GSI for categories and search.
* **Categories**: Managed via category name.
* **Orders**: Stores transaction details with a timeline GSI.
* **OrderEvents**: Logs granular event data for order tracking.
* **Metadata**: Stores system-wide configuration and metadata.

### 2. API Gateway & Security
* **Admin GraphQL**: Protected by **Amazon Cognito**; requires a valid JWT for access.
* **Public GraphQL & PayPal**: Protected by **API Keys**; no user authentication required for catalog browsing.
* **CORS**: Pre-configured `OPTIONS` methods for all endpoints to support web integrations.

### 3. Frontend Hosting
The stack includes a dedicated **S3 Bucket** for web hosting, fronted by a **CloudFront Distribution** using Origin Access Control (OAC) for secure, high-performance content delivery.

---

## Prerequisites

To build and deploy this application, you need:
* **SAM CLI**: [Installation Guide](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html)
* **Node.js 22.x**: The runtime used by the Lambda functions.
* **Docker**: Required for local testing.

---

## Deployment

### Initial Setup
The project is pre-configured to deploy to `us-east-2` with the stack name `graphql-product-service-prod`.

1. **Build the application**:
   ```bash
   sam build

2. **Deploy to AWS**:
   ```bash
   sam deploy --guided

Note: Ensure you provide the required PayPal credentials (PayPalClientId, PayPalClientSecret, etc.) during the prompts if they are not already set in your environment.

### Metadata Initialization
After the first deployment, initialize the metadata table with the following commands (replace region if necessary):

```
aws dynamodb put-item --table-name metadata --item file://products_last_update.json --region us-east-2
aws dynamodb put-item --table-name metadata --item file://categories_last_update.json --region us-east-2
aws dynamodb put-item --table-name metadata --item file://default_locale.json --region us-east-2
```


## ⚖️ License & Liability
This project is licensed under the **Apache License 2.0**.

### Limitation of Liability
This software is provided "AS IS", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability or fitness for a particular purpose. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software.
