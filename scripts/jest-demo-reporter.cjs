const path = require('node:path');

const RESET = '\u001b[0m';
const BOLD = '\u001b[1m';
const DIM = '\u001b[2m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const CYAN = '\u001b[36m';

const colour = (code, value) => (process.stdout.isTTY ? `${code}${value}${RESET}` : value);

const suiteDetails = {
  'auth.service.spec.ts': [
    'Authentication & session security',
    'Login hardening, MFA, JWT issuance, and refresh-token rotation',
  ],
  'consultations.service.spec.ts': [
    'Consultation lifecycle',
    'Atomic booking, concurrency control, cancellation, and clinical notes',
  ],
  'crypto.service.spec.ts': [
    'Clinical-data encryption',
    'Authenticated encryption, nonce safety, key rotation, and tamper detection',
  ],
  'doctors.service.spec.ts': [
    'Doctor discovery & availability',
    'Safe search, caching, slot ownership, approval, and overlap protection',
  ],
  'guards.spec.ts': ['Authorization guards', 'Role-based access control and MFA enforcement'],
  'idempotency.service.spec.ts': [
    'Idempotent writes',
    'Safe request replay, payload identity, and in-progress conflict handling',
  ],
  'outbox.service.spec.ts': [
    'Reliable event delivery',
    'Leasing, retries, exponential backoff, and dead-letter handling',
  ],
  'payments.service.spec.ts': [
    'Payment state machine',
    'Atomic transitions, replay safety, concurrency, and provider integrity',
  ],
  'rate-limit-health.spec.ts': [
    'Resilience & operations',
    'Distributed rate limiting, Redis fallback, health checks, and metrics',
  ],
  'users-admin.service.spec.ts': [
    'User & admin operations',
    'PII protection, suspension, auditing, analytics, and cache safety',
  ],
  'app.e2e-spec.ts': [
    'End-to-end API journey',
    'Live dependencies, API protection, booking, prescription, and replay',
  ],
};

const line = (character = '─') => character.repeat(72);

class DemoReporter {
  constructor() {
    this.startedAt = Date.now();
  }

  onRunStart(results) {
    this.startedAt = Date.now();
    const checks = results.numTotalTests || 'all';
    process.stdout.write(
      `\n${colour(CYAN + BOLD, line('═'))}\n` +
        `${colour(CYAN + BOLD, '  AMRUTAM TELEMEDICINE BACKEND • SYSTEM VERIFICATION')}\n` +
        `${colour(CYAN + BOLD, line('═'))}\n` +
        `  Running ${colour(BOLD, checks)} automated checks across ` +
        `${colour(BOLD, results.numTotalTestSuites)} test suites.\n` +
        `  Each check below describes the production behavior being verified.\n\n`,
    );
  }

  onTestResult(test, result) {
    const filename = path.basename(test.path);
    const [name, description] = suiteDetails[filename] || [
      filename,
      'Application behavior and safety checks',
    ];
    const passed = result.numFailingTests === 0 && result.testExecError == null;
    const label = passed ? colour(GREEN + BOLD, '✔ PASS') : colour(RED + BOLD, '✘ FAIL');

    process.stdout.write(`${label}  ${colour(BOLD, name)}\n`);
    process.stdout.write(`        ${colour(DIM, description)}\n`);

    for (const assertion of result.testResults) {
      const icon =
        assertion.status === 'passed'
          ? colour(GREEN, '✓')
          : assertion.status === 'pending' || assertion.status === 'todo'
            ? colour(YELLOW, '○')
            : colour(RED, '✗');
      const context = assertion.ancestorTitles.join(' › ');
      const title = context ? `${context}: ${assertion.title}` : assertion.title;
      const duration = assertion.duration == null ? '' : ` (${assertion.duration} ms)`;
      process.stdout.write(`        ${icon} ${title}${colour(DIM, duration)}\n`);
    }

    if (!passed) {
      for (const message of result.failureMessage ? [result.failureMessage] : []) {
        process.stdout.write(`\n${colour(RED, message)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  onRunComplete(_contexts, results) {
    const seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const passed = results.numFailedTestSuites === 0 && results.numFailedTests === 0;
    const status = passed
      ? colour(GREEN + BOLD, 'ALL CHECKS PASSED — THE SYSTEM IS WORKING AS EXPECTED')
      : colour(RED + BOLD, 'VERIFICATION FAILED — REVIEW THE FAILED CHECKS ABOVE');

    process.stdout.write(`${colour(CYAN + BOLD, line('═'))}\n`);
    process.stdout.write(`  ${status}\n`);
    process.stdout.write(`${colour(CYAN + BOLD, line('─'))}\n`);
    process.stdout.write(
      `  Test suites : ${results.numPassedTestSuites}/${results.numTotalTestSuites} passed\n` +
        `  Checks      : ${results.numPassedTests}/${results.numTotalTests} passed` +
        (results.numPendingTests ? `, ${results.numPendingTests} skipped` : '') +
        `\n  Duration    : ${seconds} seconds\n` +
        `${colour(CYAN + BOLD, line('═'))}\n\n`,
    );
  }
}

module.exports = DemoReporter;
