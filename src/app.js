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
            const existingToken = currentData.find(t => t.tokenIndex === token.index);

            try {
                const details = await getTokenDetails(token.tokenId);
                const startPxEntry = startPxData.find(t => t.index === token.index);
                const startPx = startPxEntry?.startPx || null;

                const tokenData = {
                    name: token.name,
                    tokenId: token.tokenId,
                    index: token.index,
                    tokenIndex: token.index,
                    startPx: startPx,
                    markPx: details.markPx || null,
                    launchDate: details.deployTime?.split('T')[0] || null,
                    auctionPrice: details.seededUsdc && parseFloat(details.seededUsdc) !== 0
                        ? (parseFloat(details.seededUsdc) / parseFloat(details.circulatingSupply)).toString()
                        : null,
                    launchCircSupply: details.circulatingSupply || null,
                    launchMarketCap: startPx && details.circulatingSupply
                        ? (parseFloat(startPx) * parseFloat(details.circulatingSupply)).toFixed(2)
                        : null,
                    teamAllocation: existingToken?.teamAllocation || null,
                    airdrop1: existingToken?.airdrop1 || null,
                    airdrop2: existingToken?.airdrop2 || null,
                    devReputation: existingToken?.devReputation || false,
                    spreadLessThanThree: existingToken?.spreadLessThanThree || false,
                    thickObLiquidity: existingToken?.thickObLiquidity || false,
                    noSellPressure: existingToken?.noSellPressure || false,
                    twitter: existingToken?.twitter || "",
                    telegram: existingToken?.telegram || "",
                    discord: existingToken?.discord || "",
                    website: existingToken?.website || "",
                    comment: existingToken?.comment || ""
                };

                if (!existingToken) {
                    console.log(`New token found: ${token.name}`);
                    const insertResult = await db.collection('allTokens').insertOne(tokenData);
                    console.log('Insert result:', insertResult);
                    hasChanges = true;
                } else {
                    const updateResult = await db.collection('allTokens').findOneAndUpdate(
                        { tokenIndex: token.index },
                        { $set: tokenData },
                        { returnDocument: 'after' }
                    );
                    console.log('Update result:', updateResult.value);
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

// Créer une fonction pour initialiser la connexion à la base de données
async function initializeDatabase() {
    try {
        await client.connect();
        db = client.db('backendHL');
        console.log('Connected to MongoDB');
        return true;
    } catch (error) {
        console.error('Failed to connect to MongoDB:', error);
        return false;
    }
}

// Middleware pour vérifier la connexion à la base de données
const checkDatabaseConnection = async (req, res, next) => {
    if (!db) {
        try {
            const connected = await initializeDatabase();
            if (!connected) {
                return res.status(500).json({ error: 'Database connection failed' });
            }
        } catch (error) {
            return res.status(500).json({ error: 'Database connection failed' });
        }
    }
    next();
};

app.use(checkDatabaseConnection);

app.get('/api/tokens', async (req, res) => {
    try {
        console.log('Checking database connection...');
        if (!db) {
            console.error('Database connection not established');
            return res.status(500).json({ error: 'Database connection not established' });
        }

        console.log('Fetching token data from database...');
        const collection = db.collection('allTokens');
        if (!collection) {
            console.error('Collection not found');
            return res.status(500).json({ error: 'Collection not found' });
        }

        const data = await collection.find({}).toArray();
        console.log(`Found ${data.length} tokens`);
        
        if (!data || data.length === 0) {
            console.log('No tokens found in database');
            return res.json([]);
        }

        console.log('Token data fetched successfully');
        res.json(data);
    } catch (error) {
        console.error('Detailed error:', error);
        res.status(500).json({ 
            error: 'Error reading token data',
            details: error.message,
            stack: error.stack
        });
    }
});

app.put('/api/tokens/:tokenIndex', async (req, res) => {
    try {
        const tokenIndex = parseInt(req.params.tokenIndex, 10);

        if (isNaN(tokenIndex)) {
            return res.status(400).json({ error: 'Invalid token index' });
        }

        const updates = req.body;

        console.log('Attempting to update token with tokenIndex:', tokenIndex);
        console.log('Update payload:', updates);

        if (!db) {
            console.error('Database connection not established');
            return res.status(500).json({ error: 'Database connection not established' });
        }

        // Vérifier si le token existe
        const existingToken = await db.collection('allTokens').findOne({ tokenIndex: tokenIndex });
        
        if (!existingToken) {
            console.log('Token not found with tokenIndex:', tokenIndex);
            return res.status(404).json({ error: 'Token not found' });
        }

        // Mise à jour du document
        const result = await db.collection('allTokens').findOneAndUpdate(
            { tokenIndex: tokenIndex },
            { $set: { 
                ...updates,
                lastUpdated: new Date().toISOString()
            }},
            { 
                returnDocument: 'after'
            }
        );

        if (!result.value) {
            console.error('Update failed - no document returned');
            return res.status(500).json({ error: 'Error updating token' });
        }

        console.log('Token updated successfully:', result.value);
        res.json({ 
            message: 'Token updated successfully', 
            token: result.value
        });

    } catch (error) {
        console.error('Error updating token:', error);
        res.status(500).json({ 
            error: 'Error updating token data',
            details: error.message
        });
    }
});

// Exporter l'application avant d'établir la connexion
module.exports = app;

// Modifier le démarrage du serveur
if (require.main === module) {
    initializeDatabase().then(connected => {
        if (connected) {
            app.listen(config.port, () => {
                console.log(`Server running on port ${config.port}`);
                updateTokenData().then(() => {
                    cron.schedule('* * * * *', updateTokenData);
                });
            });
        } else {
            process.exit(1);
        }
    });
}