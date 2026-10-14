/** API-level tests booting the Nest application with mock providers. */
module.exports = {
  ...require('./jest.config.js'),
  testMatch: ['**/*.e2e-spec.ts'],
  testTimeout: 60000,
};
