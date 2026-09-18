import http from 'k6/http';
import execution from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const bookingLatency = new Trend('booking_latency_ms', true);
const readLatency = new Trend('read_latency_ms', true);
const bookingSuccess = new Rate('booking_success');
const replaySuccess = new Rate('idempotent_replay_success');
const doubleBookingWins = new Counter('double_booking_wins');
const doubleBookingConflicts = new Counter('double_booking_conflicts');
const doubleBookingUnexpected = new Rate('double_booking_unexpected');

const targetRate = Number(__ENV.TARGET_RATE || 25);
const preAllocatedVUs = Number(__ENV.PRE_ALLOCATED_VUS || 50);
const maxVUs = Number(__ENV.MAX_VUS || 300);
const conflictSlotId = (__ENV.CONFLICT_SLOT_ID || '').trim();
const testRunId = (__ENV.TEST_RUN_ID || String(Date.now())).slice(0, 24);

const scenarios = {
  conflict_free_booking: {
    executor: 'ramping-arrival-rate',
    startRate: Math.max(1, Math.floor(targetRate / 5)),
    timeUnit: '1s',
    preAllocatedVUs,
    maxVUs,
    stages: [
      { target: targetRate, duration: __ENV.RAMP_DURATION || '30s' },
      { target: targetRate, duration: __ENV.HOLD_DURATION || '2m' },
      { target: 0, duration: __ENV.RAMP_DOWN_DURATION || '15s' },
    ],
    gracefulStop: '15s',
    exec: 'bookUniqueSlot',
  },
};

if (conflictSlotId) {
  scenarios.double_booking_race = {
    executor: 'shared-iterations',
    vus: Number(__ENV.CONFLICT_VUS || 20),
    iterations: Number(__ENV.CONFLICT_REQUESTS || 20),
    maxDuration: '30s',
    startTime: __ENV.CONFLICT_START_TIME || '5s',
    exec: 'raceForSlot',
  };
}

export const options = {
  scenarios,
  thresholds: {
    booking_latency_ms: ['p(95)<500'],
    read_latency_ms: ['p(95)<200'],
    booking_success: ['rate>0.99'],
    idempotent_replay_success: ['rate>0.99'],
    checks: ['rate>0.99'],
    ...(conflictSlotId
      ? {
          double_booking_wins: ['count==1'],
          double_booking_conflicts: ['count>0'],
          double_booking_unexpected: ['rate==0'],
        }
      : {}),
  },
};

const baseUrl = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const loginPath = __ENV.LOGIN_PATH || '/v1/auth/login';
const bookingPath = __ENV.BOOKING_PATH || '/v1/bookings';
const doctorSearchPath = __ENV.DOCTOR_SEARCH_PATH || '/v1/doctors';
const slotIds = (__ENV.SLOT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const replayPercent = Math.min(100, Math.max(0, Number(__ENV.REPLAY_PERCENT || 10)));

function jsonHeaders(token, idempotencyKey) {
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
  };

  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey;
  }

  return headers;
}

function extractAccessToken(response) {
  let payload;
  try {
    payload = response.json();
  } catch (_error) {
    return null;
  }

  return (
    payload.accessToken ||
    payload.access_token ||
    (payload.data && (payload.data.accessToken || payload.data.access_token)) ||
    null
  );
}

function extractResourceId(response) {
  try {
    const payload = response.json();
    return payload.id || (payload.data && payload.data.id) || null;
  } catch (_error) {
    return null;
  }
}

export function setup() {
  if (slotIds.length === 0) {
    execution.test.abort(
      'SLOT_IDS is required. Provide enough comma-separated, future AVAILABLE slot IDs for every planned booking iteration.',
    );
  }

  if (__ENV.ACCESS_TOKEN) {
    return { accessToken: __ENV.ACCESS_TOKEN };
  }

  if (!__ENV.PATIENT_EMAIL || !__ENV.PATIENT_PASSWORD) {
    execution.test.abort(
      'Set ACCESS_TOKEN, or set both PATIENT_EMAIL and PATIENT_PASSWORD for the load-test patient.',
    );
  }

  const response = http.post(
    baseUrl + loginPath,
    JSON.stringify({
      email: __ENV.PATIENT_EMAIL,
      password: __ENV.PATIENT_PASSWORD,
      ...(__ENV.PATIENT_MFA_CODE ? { totpCode: __ENV.PATIENT_MFA_CODE } : {}),
    }),
    {
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      tags: { operation: 'login' },
      timeout: '10s',
    },
  );

  const loginAccepted = check(response, {
    'login succeeds': (res) => res.status === 200 || res.status === 201,
  });
  const accessToken = extractAccessToken(response);

  if (!loginAccepted || !accessToken) {
    execution.test.abort(
      'Login failed or the response did not contain accessToken. Status: ' + response.status,
    );
  }

  return { accessToken };
}

export function bookUniqueSlot(data) {
  const iteration = execution.scenario.iterationInTest;
  if (iteration >= slotIds.length) {
    execution.test.abort(
      'SLOT_IDS exhausted after ' +
        slotIds.length +
        ' bookings. Seed more unique slots or lower the rate/duration.',
    );
  }

  const commonHeaders = jsonHeaders(data.accessToken);
  const readResponse = http.get(baseUrl + doctorSearchPath, {
    headers: commonHeaders,
    tags: { operation: 'read' },
    timeout: '5s',
  });
  readLatency.add(readResponse.timings.duration);
  check(readResponse, {
    'doctor search succeeds': (res) => res.status === 200,
  });

  const slotId = slotIds[iteration];
  const idempotencyKey =
    (__ENV.IDEMPOTENCY_PREFIX || 'k6-booking').slice(0, 32) + '-' + testRunId + '-' + iteration;
  const body = JSON.stringify({
    slotId,
    reason: __ENV.CONSULTATION_REASON || 'Scheduled load-test consultation',
  });
  const headers = jsonHeaders(data.accessToken, idempotencyKey);

  const response = http.post(baseUrl + bookingPath, body, {
    headers,
    tags: { operation: 'booking' },
    timeout: '10s',
  });
  bookingLatency.add(response.timings.duration);

  const accepted = response.status === 200 || response.status === 201;
  bookingSuccess.add(accepted);
  check(response, {
    'booking succeeds': () => accepted,
    'booking stays below 500 ms': (res) => res.timings.duration < 500,
  });

  if (accepted && iteration % 100 < replayPercent) {
    const originalId = extractResourceId(response);
    const replay = http.post(baseUrl + bookingPath, body, {
      headers,
      tags: { operation: 'idempotency-replay' },
      timeout: '10s',
    });
    const replayId = extractResourceId(replay);
    const replayed =
      (replay.status === 200 || replay.status === 201) &&
      originalId !== null &&
      replayId === originalId;

    replaySuccess.add(replayed);
    check(replay, {
      'idempotency replay returns the original result': () => replayed,
    });
  }

  sleep(Number(__ENV.THINK_TIME_SECONDS || 0.1));
}

export function raceForSlot(data) {
  const iteration = execution.scenario.iterationInTest;
  const body = JSON.stringify({
    slotId: conflictSlotId,
    reason: __ENV.CONSULTATION_REASON || 'Concurrent booking invariant test',
  });
  const headers = jsonHeaders(data.accessToken, 'k6-race-' + testRunId + '-' + iteration);
  const response = http.post(baseUrl + bookingPath, body, {
    headers,
    tags: { operation: 'double-booking-race' },
    timeout: '10s',
  });

  const won = response.status === 200 || response.status === 201;
  const conflicted = response.status === 409;
  doubleBookingWins.add(won ? 1 : 0);
  doubleBookingConflicts.add(conflicted ? 1 : 0);
  doubleBookingUnexpected.add(!won && !conflicted);
  check(response, {
    'race returns one booking or a conflict': () => won || conflicted,
  });
}

export default bookUniqueSlot;
