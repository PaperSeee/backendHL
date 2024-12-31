require('dotenv').config();
const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

async function initAdmin() {
    const client = new MongoClient(process.env.MONGO_URI);
    
    try {
        await client.connect();
        const db = client.db('backendHL');
        
        // Check if admin exists
        const existingAdmin = await db.collection('users').findOne({ username: 'admin' });
        if (!existingAdmin) {
            const adminUser = {
                username: 'admin',
                password: await bcrypt.hash('your_admin_password', 10),
                role: 'admin'
            };
            await db.collection('users').insertOne(adminUser);
            console.log('Admin user created successfully');
        }
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await client.close();
    }
}

initAdmin();
