FROM node:17-alpine
WORKDIR /usr/app
COPY package.json ./

ENV NODE_ENV=production
RUN yarn install

COPY . .
CMD ["node", "."]