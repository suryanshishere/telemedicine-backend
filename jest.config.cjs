/** @type {import('jest').Config} */
module.exports = {
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/worker.ts',
    '!src/tracing.ts',
    '!src/**/*.module.ts',
    '!src/**/dto/*.ts',
  ],
  coverageDirectory: 'coverage',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
