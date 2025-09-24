// api/index.js
import express from 'express';
import { createServer } from 'http';
import { parse } from 'url';

const app = express();

app.get('/', (req, res) => {
  res.send('¡Hola desde Express en Vercel!');
});

export default async function handler(req, res) {
  const parsedUrl = parse(req.url, true);
  app(req, res);
}
