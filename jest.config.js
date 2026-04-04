/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testTimeout: 240000,
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['index.js', 'shared/**/*.js', '*/*/adapter.js'],
  coveragePathIgnorePatterns: ['/node_modules/', '/tests/'],
  testPathIgnorePatterns: ['/node_modules/'],
}
