FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
COPY scripts ./scripts

# تثبيت الحزم بدون الحاجة لمكتبات cairo القديمة
RUN npm install --omit=dev

COPY . .

EXPOSE 3001
CMD ["npm", "start"]
