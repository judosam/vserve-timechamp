/**
 * VserveTimeChamp - Master Automated API Test Runner
 * Executes all API test suites under tests/api/ using Node.js native test runner
 * Provides unified summary, execution timing, and clean exit semantics (0 on pass, 1 on fail)
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ensureServerRunning, stopManagedServer, isServerAlive, DEFAULT_SERVER_URL } = require('./helpers');

const SUITES = [
  { name: 'Legacy Compatibility & Telemetry (REA)', file: 'legacy-compat.test.js', tier: 'Legacy' },
  { name: 'Tier 1: Core Feature Coverage (13 Features)', file: 'tier1-features.test.js', tier: 'Tier 1' },
  { name: 'Tier 2: Boundary & Corner Cases (13 Areas)', file: 'tier2-boundaries.test.js', tier: 'Tier 2' },
  { name: 'Tier 3: Cross-Feature Interactions', file: 'tier3-interactions.test.js', tier: 'Tier 3' },
  { name: 'Tier 4: Real-World Application Workloads', file: 'tier4-workloads.test.js', tier: 'Tier 4' }
];

async function runSuite(suite) {
  const filePath = path.join(__dirname, suite.file);
  if (!fs.existsSync(filePath)) {
    return { name: suite.name, file: suite.file, passed: 0, failed: 1, durationMs: 0, error: `File not found: ${filePath}` };
  }

  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', filePath], {
      env: { ...process.env, FORCE_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;

      // Extract pass/fail counts from node:test output
      let passMatch = stdout.match(/ℹ pass (\d+)/);
      let failMatch = stdout.match(/ℹ fail (\d+)/);
      let testsMatch = stdout.match(/ℹ tests (\d+)/);

      const passed = passMatch ? parseInt(passMatch[1], 10) : (code === 0 ? 1 : 0);
      const failed = failMatch ? parseInt(failMatch[1], 10) : (code === 0 ? 0 : 1);
      const total = testsMatch ? parseInt(testsMatch[1], 10) : passed + failed;

      resolve({
        name: suite.name,
        file: suite.file,
        tier: suite.tier,
        code,
        passed,
        failed,
        total,
        durationMs,
        stdout,
        stderr
      });
    });
  });
}

async function main() {
  console.log('================================================================');
  console.log('       VserveTimeChamp — Master API Test Suite Runner           ');
  console.log('================================================================');
  console.log(`Node.js Version: ${process.version}`);
  console.log(`Target Server:   ${DEFAULT_SERVER_URL}`);
  console.log(`Test Directory:  ${__dirname}`);
  console.log('================================================================\n');

  let managedProcess = null;
  try {
    const alive = await isServerAlive(DEFAULT_SERVER_URL);
    if (!alive) {
      console.log('>>> Server not responding. Starting background server instance...');
      managedProcess = await ensureServerRunning(DEFAULT_SERVER_URL);
      console.log('>>> Server started and healthy on port 3000.\n');
    } else {
      console.log('>>> Connected to existing running server instance.\n');
    }
  } catch (err) {
    console.error(`[ERROR] Could not start server: ${err.message}`);
    process.exit(1);
  }

  const startTime = Date.now();
  const results = [];
  let totalPassedTests = 0;
  let totalFailedTests = 0;
  let totalTestCases = 0;

  for (const suite of SUITES) {
    process.stdout.write(`>>> Running ${suite.tier}: ${suite.name} ... `);
    const result = await runSuite(suite);
    results.push(result);

    totalPassedTests += result.passed;
    totalFailedTests += result.failed;
    totalTestCases += (result.total || (result.passed + result.failed));

    if (result.code === 0 && result.failed === 0) {
      console.log(`PASSED (${result.passed} tests, ${(result.durationMs / 1000).toFixed(2)}s)`);
    } else {
      console.log(`FAILED (${result.failed} failed, ${result.passed} passed, ${(result.durationMs / 1000).toFixed(2)}s)`);
      if (result.stdout && result.failed > 0) {
        const lines = result.stdout.split('\n');
        const failingLines = lines.filter(l => l.includes('✖') || l.includes('Error ['));
        console.error(failingLines.slice(0, 10).join('\n'));
      }
      if (result.stderr) {
        console.error(result.stderr.slice(0, 500));
      }
    }
  }

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n================================================================');
  console.log('                     TEST EXECUTION SUMMARY                     ');
  console.log('================================================================');
  console.log(`Total Suites Executed: ${SUITES.length}`);
  console.log(`Total Test Cases:      ${totalTestCases}`);
  console.log(`Passed Test Cases:     ${totalPassedTests}`);
  console.log(`Failed Test Cases:     ${totalFailedTests}`);
  console.log(`Total Elapsed Time:    ${totalDuration}s`);
  console.log('----------------------------------------------------------------');
  console.log('Tier Breakdown:');
  for (const r of results) {
    const statusLabel = r.code === 0 && r.failed === 0 ? 'PASS' : 'FAIL';
    const testCount = `${r.passed}/${r.total || (r.passed + r.failed)}`;
    console.log(`  [${statusLabel}] ${r.tier.padEnd(8)}: ${r.name.padEnd(46)} (${testCount} tests, ${(r.durationMs / 1000).toFixed(2)}s)`);
  }
  console.log('================================================================');

  if (managedProcess) {
    stopManagedServer();
  }

  if (totalFailedTests === 0) {
    console.log('\n>>> SUCCESS: All API test suites passed with 0 failures! <<<\n');
    process.exit(0);
  } else {
    console.error(`\n>>> FAILURE: ${totalFailedTests} test(s) failed. <<<\n`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL] Unhandled error during test run:', err);
  stopManagedServer();
  process.exit(1);
});
