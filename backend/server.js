require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const initializeServer = require('./scripts/init');
const contactRoutes = require('./routes/contact');
const ServiceCatalog = require('./models/ServiceCatalog');

const app = express();

// Verify model registration
console.log('Available models:', Object.keys(mongoose.models));
console.log('ServiceCatalog schema:', ServiceCatalog.schema.paths);

// Middleware
app.use(cors());
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`, {
        body: req.body,
        query: req.query,
        headers: {
            authorization: req.headers.authorization ? 'Bearer [hidden]' : 'none',
            'content-type': req.headers['content-type']
        }
    });
    next();
});

// Add this near the top of the file
if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is not set!');
    process.exit(1);
}

// MongoDB connection with retry logic
const connectWithRetry = async () => {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
            serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
            connectTimeoutMS: 10000, // Give up initial connection after 10s
        });
        console.log('Connected to MongoDB');
        // Ensure admin user exists after connection
    } catch (err) {
        console.error('MongoDB connection error:', err);
        console.log('Retrying in 5 seconds...');
        setTimeout(connectWithRetry, 5000);
    }
};

// Initial connection
connectWithRetry();

// Handle MongoDB connection errors
mongoose.connection.on('error', err => {
    console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
    console.log('MongoDB disconnected. Attempting to reconnect...');
    connectWithRetry();
});

// Initialize server and start listening
async function startServer() {
    try {
        console.log('Starting server with environment:', process.env.NODE_ENV);
        
        // Run initialization script
        await initializeServer();

        // Routes
        app.use('/api/contact', contactRoutes);

        // Error handling middleware
        app.use((err, req, res, next) => {
            console.error('Server error:', err);
            res.status(500).json({ 
                message: 'Something went wrong!',
                error: err.message 
            });
        });

        const PORT = process.env.PORT || 1616;
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}

startServer(); 