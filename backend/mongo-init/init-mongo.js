// Switch to docker-website database
db = db.getSiblingDB('docker-website');

// Create collections
db.createCollection('serviceCatalog');
db.createCollection('users');
db.createCollection('userServices');

// Create indexes
db.serviceCatalog.createIndex({ serviceName: 1 }, { unique: true });
db.users.createIndex({ email: 1 }, { unique: true });

// Create initial service if none exists
const services = db.serviceCatalog.find({}).toArray();
if (services.length === 0) {
    db.serviceCatalog.insertOne({
        serviceName: 'Basic Hosting - Monthly',
        displayName: 'Basic Hosting',
        description: 'Basic web hosting package',
        price: 9.99,
        billingCycle: 'monthly',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date()
    });
} 