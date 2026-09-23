/** Integration tests against a real Postgres 16 (Testcontainers). Always --runInBand. */
module.exports = {
  rootDir: '.',
  testRegex: 'test/.*\\.int-spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/.superpowers/'],
  // Prisma 7's generated client uses dynamic import() for its WASM query compiler; Jest's
  // CJS VM can't run that without --experimental-vm-modules, so downlevel to commonjs here
  // (module stays "nodenext" in tsconfig.json for the rest of the app).
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: { module: 'commonjs', moduleResolution: 'node10', resolvePackageJsonExports: false } },
    ],
    // svix ships ESM-only (dist/index.mjs); Jest's native require(esm) needs Node 24.9+
    // (we're on 22.14), so downlevel it through ts-jest like any other source file.
    '^.+\\.mjs$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
  },
  transformIgnorePatterns: ['/node_modules/(?!svix/)'],
  moduleFileExtensions: ['js', 'json', 'ts', 'mjs'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 60000,
};
