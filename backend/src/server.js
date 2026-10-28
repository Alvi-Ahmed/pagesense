import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/auth', authRoutes);

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pagesense-backend', time: new Date().toISOString() });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`PageSense backend running on :${port}`));
