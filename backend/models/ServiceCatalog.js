const mongoose = require('mongoose');

const serviceCatalogSchema = new mongoose.Schema({
    serviceName: {
        type: String,
        required: [true, 'Service name is required'],
        trim: true,
        unique: true
    },
    displayName: {
        type: String,
        required: [true, 'Display name is required'],
        trim: true
    },
    description: {
        type: String,
        required: [true, 'Service description is required'],
        trim: true
    },
    price: {
        type: Number,
        required: [true, 'Price is required'],
        min: [0, 'Price cannot be negative']
    },
    billingCycle: {
        type: String,
        required: [true, 'Billing cycle is required'],
        enum: {
            values: ['monthly', 'quarterly', 'yearly'],
            message: 'Invalid billing cycle'
        }
    },
    url: {
        type: String,
        trim: true
    },
    features: [{
        type: String
    }],
    active: {
        type: Boolean,
        default: true
    }
}, {
    timestamps: true,
    collection: 'serviceCatalog',
    versionKey: false
});

// Add a pre-save hook for debugging
serviceCatalogSchema.pre('save', function(next) {
    console.log('Saving service to MongoDB container:', this);
    next();
});

// Ensure indexes are created in the container
serviceCatalogSchema.post('save', function(doc) {
    console.log('Service saved successfully in container:', doc);
});

const ServiceCatalog = mongoose.model('ServiceCatalog', serviceCatalogSchema);
module.exports = ServiceCatalog; 