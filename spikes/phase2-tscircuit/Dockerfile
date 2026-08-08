# Proves the tscircuit export pipeline runs headlessly in a plain Linux container:
# no browser, no X display, no GPU.
FROM node:22-slim

WORKDIR /spike

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY export-all-four.js determinism-and-failures.js what-varies.js ./

CMD ["node", "export-all-four.js"]
