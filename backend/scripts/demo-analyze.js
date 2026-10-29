// Run the analysis job (tagging, comment classification, playbook) on the demo page.
// Visitors cannot do this (the demo is read-only), so the maintainer runs it after `demo:seed -- --reset`.
// Run: npm run demo:analyze, then npm run demo:save-analysis
import { startAnalysis, latestAnalysis } from '../src/analysis.js';

const job = await startAnalysis('demo');
let last;
for (;;) {
  const j = await latestAnalysis('demo');
  const line = `${j.status} ${j.stage ?? ''} ${j.processed}/${j.total}`;
  if (line !== last) console.log(line);
  last = line;
  if (j.status === 'done' || j.status === 'failed') {
    console.log(j.status === 'done' ? `done, ${j.failed_count} items skipped` : `FAILED: ${j.error}`);
    process.exit(j.status === 'done' ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
