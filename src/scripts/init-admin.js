const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
require('dotenv').config();

if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in the environment variables');
}

const client = new MongoClient(process.env.MONGO_URI);

async function initializeAdmin() {
    try {
        await client.connect();
        const db = client.db('backendHL');
        const usersCollection = db.collection('users');

        const adminUser = await usersCollection.findOne({ username: 'admin' });
        if (adminUser) {
            console.log('Admin user already exists');
            return;
        }

        const hashedPassword = await bcrypt.hash('admin_password', 10); // Replace 'admin_password' with a secure password
        await usersCollection.insertOne({
            username: 'admin',
            password: hashedPassword
        });

        console.log('Admin user created successfully');
    } catch (error) {
        console.error('Error initializing admin user:', error);
    } finally {
        await client.close();
    }
}

initializeAdmin();
