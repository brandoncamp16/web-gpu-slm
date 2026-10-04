FROM node:18

WORKDIR /usr/src/app

# Copy package files first
COPY backend/package*.json ./

# Install dependencies
RUN npm install

# Create frontend directory
RUN mkdir -p frontend

# Copy the server code
COPY backend/ .

# Ensure correct permissions
RUN chown -R node:node /usr/src/app

# Switch to non-root user
USER node

# Expose port
EXPOSE 1616

# Start the application
CMD ["npm", "start"] 