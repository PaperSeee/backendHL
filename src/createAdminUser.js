const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');
require('dotenv').config();

process.env.MONGO_URI = 'mongodb+srv://shengen0703:MeribnKzRA7bpNhb@hypurrspot.pezxc.mongodb.net/?retryWrites=true&w=majority&appName=HypurrSpot';

if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in the environment variables');
}

const client = new MongoClient(process.env.MONGO_URI);
const dbName = 'backendHL';
const adminUser = {
    username: 'admin',
    password: 'Pasteke001'
};

async function createAdminUser() {
    try {
        await client.connect();
        const db = client.db(dbName);
        const usersCollection = db.collection('users');

        const existingUser = await usersCollection.findOne({ username: adminUser.username });
        if (existingUser) {
            console.log('Admin user already exists');
            return;
        }

        const hashedPassword = await bcrypt.hash(adminUser.password, 10);
        await usersCollection.insertOne({
            username: adminUser.username,
            password: hashedPassword,
            role: 'admin'
        });

        console.log('Admin user created successfully');
    } catch (error) {
        console.error('Error creating admin user:', error);
    } finally {
        await client.close();
    }
}

createAdminUser();
