import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import pageRoutes from './routes/pages.js';
import { failInterruptedJobs, resumeAnalyses } from './analysis.js';

const app = express();
app.set('trust proxy', 1); // Render sits in front: req.ip is then the visitor, which the rate limit relies on
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/auth', authRoutes);
app.use('/pages', pageRoutes);

app.use((err, _req, res, next) => { // body-parser failures (too large, malformed) as JSON, never an HTML page
  if (res.headersSent) return next(err);
  const tooLarge = err.type === 'entity.too.large';
  res.status(tooLarge ? 413 : err.status || 500).json({ error: tooLarge ? 'That upload is too large (10 MB per photo).' : err.message });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'pagesense-backend', time: new Date().toISOString() });
});

failInterruptedJobs().then(resumeAnalyses);

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`PageSense backend running on :${port}`));
