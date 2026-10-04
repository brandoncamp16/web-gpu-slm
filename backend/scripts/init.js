const mongoose = require('mongoose');
require('dotenv').config();
const bcrypt = require('bcryptjs');

// Connect to MongoDB with retry logic
async function connectWithRetry() {
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
        try {
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('Connected to MongoDB');
            // Wait for connection to be ready
            await new Promise(resolve => {
                const db = mongoose.connection;
                if (db.readyState === 1) {
                    resolve();
                } else {
                    db.once('open', resolve);
                }
            });
            return;
        } catch (err) {
            console.log(`MongoDB connection attempt ${i + 1} failed, retrying in 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    throw new Error('Failed to connect to MongoDB after multiple retries');
}

const User = require('../models/User');
const ServiceCatalog = require('../models/ServiceCatalog');

async function initializeServer() {
    try {
        await connectWithRetry();

        // Verify database connection and collections
        const db = mongoose.connection.db;
        if (!db) {
            throw new Error('Database connection not established');
        }

        const collections = await db.listCollections().toArray();
        console.log('Available collections:', collections.map(c => c.name));

        // Check if ServiceCatalog collection exists
        const serviceCatalogExists = collections.some(c => c.name === 'serviceCatalog');
        if (!serviceCatalogExists) {
            console.log('Creating serviceCatalog collection...');
            await db.createCollection('serviceCatalog');
            
            // Create initial service
            const service = new ServiceCatalog({
                serviceName: 'Basic Hosting - Monthly',
                displayName: 'Basic Hosting',
                description: 'Basic web hosting package',
                price: 9.99,
                billingCycle: 'monthly',
                active: true
            });
            await service.save();
            console.log('Created initial service');
        }

        // Update any 'user' roles to 'client'
        const updateResult = await User.updateMany(
            { role: 'user' },
            { $set: { role: 'client' }}
        );
        console.log('Updated user roles:', updateResult.modifiedCount);

        // Ensure admin user exists
        const adminExists = await User.findOne({ role: 'admin' });
        
        if (!adminExists) {
            const adminUser = new User({
                companyName: 'Example Company',
                fullName: 'Mongo Admin',
                email: 'example@email.com',
                password: process.env.ADMIN_DEFAULT_PASSWORD,
                phone: '1234567890',
                role: 'admin'
            });
            await adminUser.save();
            console.log('Admin user created successfully');
        } else {
            console.log('Admin user already exists');
        }

        console.log('Server initialization completed successfully');
        
        // Don't exit - let the server start normally
        return true;
    } catch (error) {
        console.error('Server initialization failed:', error);
        throw error;
    }
}

module.exports = initializeServer; 