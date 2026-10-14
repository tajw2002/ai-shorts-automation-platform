/** Unit + integration tests. External APIs are always mocked — see docs/providers.md. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/**/index.ts',
    '!src/**/*.interface.ts',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 20000,
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
};
