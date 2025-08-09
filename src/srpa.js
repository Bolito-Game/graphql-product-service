#!/usr/bin/env node

import { SRPClient } from 'amazon-user-pool-srp-client';
import { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } from "@aws-sdk/client-cognito-identity-provider";

// --- Configuration ---
const userPoolId = 'us-east-2_YC19tuGvs'; // Replace with your actual User Pool ID
const clientId = '3npgq69kj14m9ovt5d0novsqr9'; // Replace with your actual App Client ID
const username = 'bolito.game@gmail.com'; // Replace with the user's username
const password = 'R#cub123456789'; // Replace with the user's password (handle securely in production!)

// Initialize AWS Cognito Identity Provider Client
const cognitoClient = new CognitoIdentityProviderClient({ region: 'us-east-2' }); // Replace with your AWS region

async function authenticateWithSrp() {
    try {
        const srp = new SRPClient(userPoolId);

        // Step 1: Initiate Auth with SRP_A
        const srpA = srp.calculateA(); // This generates the SRP_A value
        const initiateAuthParams = {
            AuthFlow: 'USER_SRP_AUTH',
            AuthParameters: {
                USERNAME: username,
                SRP_A: srpA
            },
            ClientId: clientId
        };

        console.log('Initiating Auth...');
        const initiateAuthResponse = await cognitoClient.send(new InitiateAuthCommand(initiateAuthParams));
        console.log('Initiate Auth Response:', initiateAuthResponse);

        if (initiateAuthResponse.ChallengeName === 'PASSWORD_VERIFIER') {
            const challengeSession = initiateAuthResponse.Session;
            const challengeParameters = initiateAuthResponse.ChallengeParameters;

            // Step 2: Calculate PASSWORD_VERIFIER and respond to challenge
            const passwordVerifier = srp.calculatePasswordVerifier({
                username: username,
                password: password,
                challengeParameters: challengeParameters // Contains srp_b and salt
            });

            const respondToChallengeParams = {
                ChallengeName: 'PASSWORD_VERIFIER',
                ChallengeResponses: {
                    USERNAME: username,
                    PASSWORD_VERIFIER: passwordVerifier
                },
                ClientId: clientId,
                Session: challengeSession
            };

            console.log('Responding to PASSWORD_VERIFIER challenge...');
            const respondToChallengeResponse = await cognitoClient.send(new RespondToAuthChallengeCommand(respondToChallengeParams));
            console.log('Respond to Challenge Response:', respondToChallengeResponse);

            // Step 3: Tokens are in the AuthenticationResult!
            if (respondToChallengeResponse.AuthenticationResult) {
                const idToken = respondToChallengeResponse.AuthenticationResult.IdToken;
                const accessToken = respondToChallengeResponse.AuthenticationResult.AccessToken;
                const refreshToken = respondToChallengeResponse.AuthenticationResult.RefreshToken;

                console.log('\nAuthentication Successful!');
                console.log('ID Token:', idToken);
                console.log('Access Token:', accessToken);
                console.log('Refresh Token:', refreshToken);

                // You can now store and use these tokens for subsequent API calls
            } else {
                console.log('Authentication successful, but no tokens received (e.g., if MFA is next challenge).');
                // Handle further challenges if present, e.g., SMS_MFA
            }

        } else if (initiateAuthResponse.ChallengeName) {
            console.log(`Received another challenge: ${initiateAuthResponse.ChallengeName}`);
            // You would need to handle other challenges here, e.g., SMS_MFA, NEW_PASSWORD_REQUIRED
        } else {
            // This might happen if no challenges are needed, and tokens are directly returned
            if (initiateAuthResponse.AuthenticationResult) {
                 const idToken = initiateAuthResponse.AuthenticationResult.IdToken;
                const accessToken = initiateAuthResponse.AuthenticationResult.AccessToken;
                const refreshToken = initiateAuthResponse.AuthenticationResult.RefreshToken;

                console.log('\nAuthentication Successful (direct token return)!');
                console.log('ID Token:', idToken);
                console.log('Access Token:', accessToken);
                console.log('Refresh Token:', refreshToken);
            } else {
                 console.log('Unexpected response from initiateAuth:', initiateAuthResponse);
            }
        }

    } catch (error) {
        console.error('Authentication error:', error);
    }
}

authenticateWithSrp();