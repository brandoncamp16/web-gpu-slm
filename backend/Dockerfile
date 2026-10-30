FROM node:20

WORKDIR /usr/src/app

# Copy package files first
COPY backend/package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Dataset files (VizWiz annotations + cached images) live in a volume mounted here
RUN mkdir -p data

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