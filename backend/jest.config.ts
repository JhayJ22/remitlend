import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts', '**/*.spec.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/jest.setup.js'],
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          moduleResolution: 'bundler',
        },
      },
    ],
  },
  extensionsToTreatAsEsm: ['.ts'],
  globals: {
    'ts-jest': {
      useESM: true,
    },
  },
  moduleNameMapper: {
    // Correct pattern - strips .js so Jest finds the .ts source file
    '^(./|../)(.*)\\.js$': '$1$2',
  },
  // Mutation testing for authorization/ownership predicates. Thresholds are
  // stable per critical path and enforced in CI (see stryker.conf.json and
  // docs/security/mutation-testing.md for reproducible evidence).
  // Deterministic, bounded fault-injection suite for dependency outages
  // (RPC, PostgreSQL, Redis). Runs offline with no public network access.
  projects: [
    {
      displayName: 'unit',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['**/*.test.ts', '**/*.spec.ts'],
      testPathIgnorePatterns: ['/node_modules/', '/src/tests/fault-injection/'],
      setupFilesAfterEnv: ['<rootDir>/src/tests/jest.setup.js'],
      moduleFileExtensions: ['ts', 'js', 'json', 'node'],
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        ],
      },
      extensionsToTreatAsEsm: ['.ts'],
      globals: {
        'ts-jest': {
          useESM: true,
        },
      },
      moduleNameMapper: {
        '^(./|../)(.*)\\.js$': '$1$2',
      },
    },
    {
      displayName: 'fault-injection',
      preset: 'ts-jest',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/tests/fault-injection/**/*.test.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/tests/jest.setup.js'],
      moduleFileExtensions: ['ts', 'js', 'json', 'node'],
      // Bounded execution: fail fast on hangs so outages cannot stall CI.
      testTimeout: 15000,
      maxWorkers: 1,
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        ],
      },
      extensionsToTreatAsEsm: ['.ts'],
      globals: {
        'ts-jest': {
          useESM: true,
        },
      },
      moduleNameMapper: {
        '^(./|../)(.*)\\.js$': '$1$2',
      },
    },
    {
      displayName: 'mutation',
      preset: 'ts-jest',
      testEnvironment: 'node',
      // Only the focused authorization/ownership suites are run under
      // mutation; these are the tests that must fail when a guard is removed
      // or inverted.
      testMatch: [
        '<rootDir>/src/tests/mutation/**/*.test.ts',
        '<rootDir>/src/tests/auth/**/*.test.ts',
        '<rootDir>/src/tests/security/**/*.test.ts',
      ],
      setupFilesAfterEnv: ['<rootDir>/src/tests/jest.setup.js'],
      moduleFileExtensions: ['ts', 'js', 'json', 'node'],
      testTimeout: 15000,
      maxWorkers: 1,
      transform: {
        '^.+\\.(ts|tsx)$': [
          'ts-jest',
          {
            useESM: true,
            tsconfig: {
              module: 'esnext',
              moduleResolution: 'bundler',
            },
          },
        ],
      },
      extensionsToTreatAsEsm: ['.ts'],
      globals: {
        'ts-jest': {
          useESM: true,
        },
      },
      moduleNameMapper: {
        '^(./|../)(.*)\\.js$': '$1$2',
      },
    },
  ],
};

export default config;
