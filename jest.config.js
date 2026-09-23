/** Unit tests: pure code under src/. */
module.exports = {
  rootDir: '.',
  testRegex: 'src/.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/.superpowers/'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    // svix ships ESM-only (dist/index.mjs); Jest's native require(esm) needs Node 24.9+
    // (we're on 22.14), so downlevel it through ts-jest like any other source file.
    '^.+\\.mjs$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!svix/)'],
  moduleFileExtensions: ['js', 'json', 'ts', 'mjs'],
  // Prisma 7 generated client imports "./x.js"; map to the .ts sources (RESEARCH Q3, nestjs#16051)
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
};
