// Run the analysis stages (tagging, comment classification, playbook) on the demo page, on every item.
// Visitors cannot do this (the demo is read-only and startAnalysis refuses it), so the maintainer runs the
// stages directly after `demo:seed -- --reset`. Then run `npm run demo:save-analysis`.
// Run: npm run demo:analyze
import { STAGES } from '../src/analysis.js';

let failed = 0;
for (const stage of STAGES) {
  console.log(`${stage.name}...`);
  const result = await stage.run('demo', {
    all: true,
    progress: (done, total) => { if (total && done % 50 === 0) console.log(`  ${done}/${total}`); },
  });
  failed += result?.failed ?? 0;
  console.log(`  done${result?.failed ? `, ${result.failed} items skipped` : ''}`);
}
process.exit(failed && failed > 10 ? 1 : 0);
