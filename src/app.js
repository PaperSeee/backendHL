const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
require('dotenv').config();
const { MongoClient } = require('mongodb');

if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in the environment variables');
}

const client = new MongoClient(process.env.MONGO_URI);
let db;

const config = {
    port: process.env.PORT || 3000,
    hyperliquidApiUrl: process.env.HYPERLIQUID_API_URL,
    hypurrscanApiUrl: process.env.HYPURRSCAN_API_URL,
    corsOrigin: process.env.CORS_ORIGIN,
    pollingInterval: parseInt(process.env.POLLING_INTERVAL, 10) || 60000
};

const limit = pLimit(5);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let requestWeightCounter = 0;
const WEIGHT_LIMIT_PER_MINUTE = 1200;
const RESET_INTERVAL = 60000;
const MAX_RETRIES = 5;
const BASE_DELAY = 1000;

setInterval(() => requestWeightCounter = 0, RESET_INTERVAL);

async function makeRateLimitedRequest(requestFn, weight = 1, retryCount = 0) {
    if (requestWeightCounter + weight > WEIGHT_LIMIT_PER_MINUTE) {
        const waitTime = RESET_INTERVAL - (Date.now() % RESET_INTERVAL);
        await delay(waitTime);
    }
    requestWeightCounter += weight;

    try {
        return await limit(requestFn);
    } catch (error) {
        if (error.response?.status === 429 && retryCount < MAX_RETRIES) {
            const backoffDelay = BASE_DELAY * Math.pow(2, retryCount);
            await delay(backoffDelay);
            return makeRateLimitedRequest(requestFn, weight, retryCount + 1);
        }
        throw error;
    }
}

const getSpotMeta = () => makeRateLimitedRequest(async () => {
    const response = await axios.post(config.hyperliquidApiUrl, { type: "spotMeta" });
    if (!response.data?.tokens) throw new Error('Invalid API response for spotMeta.');
    return response.data.tokens.map(token => ({
        name: token.name,
        tokenId: token.tokenId,
        index: token.index
    }));
}, 20);

const getAllDeploys = () => makeRateLimitedRequest(async () => {
    const response = await axios.get(config.hypurrscanApiUrl);
    return response.data;
}, 20);

const getTokenDetails = (tokenId) => makeRateLimitedRequest(async () => {
    const response = await axios.post(config.hyperliquidApiUrl, { type: "tokenDetails", tokenId });
    if (!response.data?.name) throw new Error(`Details not found for tokenId: ${tokenId}`);
    return response.data;
}, 20);

async function updateTokenData() {
    try {
        const currentData = await db.collection('allTokens').find({}).toArray();
        const startPxData = await db.collection('startPx').find({}).toArray();
        const [spotTokens, deploys] = await Promise.all([getSpotMeta(), getAllDeploys()]);
        let hasChanges = false;

        for (const token of spotTokens) {
            const existingToken = currentData.find(t => t.tokenId === token.tokenId);

            try {
                const details = await getTokenDetails(token.tokenId);
                const startPxEntry = startPxData.find(t => t.index === token.index);
                const startPx = startPxEntry?.startPx || null;

                const tokenData = {
                    ...token,
                    startPx: startPx,
                    markPx: details.markPx || null,
                    launchDate: details.deployTime?.split('T')[0] || null,
                    auctionPrice: details.seededUsdc && parseFloat(details.seededUsdc) !== 0
                        ? (parseFloat(details.seededUsdc) / parseFloat(details.circulatingSupply)).toString()
                        : null,
                    launchCircSupply: details.circulatingSupply || null,
                    launchMarketCap: startPx && details.maxSupply
                        ? (parseFloat(startPx) * parseFloat(details.circulatingSupply)).toFixed(2)
                        : null
                };

                if (!existingToken) {
                    console.log(`New token found: ${token.name}`);
                    await db.collection('allTokens').insertOne(tokenData);
                    hasChanges = true;
                } else {
                    await db.collection('allTokens').updateOne({ tokenId: token.tokenId }, { $set: tokenData });
                    hasChanges = true;
                }
            } catch (error) {
                console.error(`Error processing token ${token.name}:`, error.message);
            }
        }

        if (hasChanges) {
            console.log('Token data updated:', new Date().toISOString());
        }
    } catch (error) {
        console.error('Error during token update:', error.message);
    }
}

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
}

app.get('/api/tokens', async (req, res) => {
    try {
        const data = await db.collection('allTokens').find({}).toArray();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'Error reading token data' });
    }
});

app.put('/api/tokens/:index', async (req, res) => {
    try {
        const tokenIndex = parseInt(req.params.index, 10);
        const updates = req.body;

        const result = await db.collection('allTokens').updateOne({ index: tokenIndex }, { $set: updates });

        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Token not found' });
        }

        const updatedToken = await db.collection('allTokens').findOne({ index: tokenIndex });
        res.json({ message: 'Token updated successfully', token: updatedToken });

    } catch (error) {
        res.status(500).json({ error: 'Error updating token data' });
    }
});

client.connect().then(() => {
    db = client.db('backendHL');
    console.log('Connected to MongoDB');

    // Démarrez le serveur uniquement après avoir établi la connexion à la base de données
    app.listen(config.port, () => {
        console.log(`Server running on port ${config.port}`);
        updateTokenData().then(() => {
            cron.schedule('* * * * *', updateTokenData);
        });
    });
}).catch(err => {
    console.error('Error connecting to MongoDB:', err);
    process.exit(1); // Exit the process if the connection fails
        cron.schedule('* * * * *', updateTokenData);
});
    });
});