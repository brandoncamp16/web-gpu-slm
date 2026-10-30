// Runs once, when the MongoDB volume is first created.
db = db.getSiblingDB('docker-website');

db.createCollection('benchmarkRuns');
db.benchmarkRuns.createIndex({ createdAt: -1 });
db.benchmarkRuns.createIndex({ label: 1 });
