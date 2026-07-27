FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY index.js app.js actor-utils.js bridge-auth.js confirmation.js confirmations.js ./
EXPOSE 30001
CMD ["node", "index.js"]
