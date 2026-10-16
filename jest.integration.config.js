// Runs against DynamoDB Local. Set AWS_ENDPOINT_URL_DYNAMODB. `npm run test:int`.
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test/int'],
  testMatch: ['**/*.int.test.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testTimeout: 60000,
};
