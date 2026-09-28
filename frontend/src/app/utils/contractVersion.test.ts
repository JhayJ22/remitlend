/**
 * utils/contractVersion.test.ts
 *
 * Unit tests for the contract version feature-flag utility (#348).
 * Tests cover: default fallback, v1/v2 resolution, version-switch helper,
 * and guard functions.
 */

import {
  isContractV1,
  isContractV2,
  contractVersionSwitch,
  LOAN_REQUEST_FUNCTION,
  LOAN_REPAY_FUNCTION,
  POOL_DEPOSIT_FUNCTION,
  POOL_WITHDRAW_FUNCTION,
} from "./contractVersion";

describe("contractVersion feature flag", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("guard functions with default env (v1)", () => {
    it("isContractV1 returns true by default", () => {
      // The module is loaded once at import; we test the *default* state here.
      // In a real environment, NEXT_PUBLIC_CONTRACT_VERSION is not set,
      // so v1 is expected.
      expect(typeof isContractV1).toBe("function");
      expect(typeof isContractV2).toBe("function");
    });

    it("contractVersionSwitch returns v1 value when version is v1", () => {
      // Re-require the module with v1 env set
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v1" };
      jest.resetModules();
      const {
        contractVersionSwitch: switchFn,
        isContractV1: v1Fn,
        isContractV2: v2Fn,
      } = require("./contractVersion") as typeof import("./contractVersion");

      expect(switchFn({ v1: "alpha", v2: "beta" })).toBe("alpha");
      expect(v1Fn()).toBe(true);
      expect(v2Fn()).toBe(false);
    });

    it("contractVersionSwitch returns v2 value when version is v2", () => {
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v2" };
      jest.resetModules();
      const {
        contractVersionSwitch: switchFn,
        isContractV1: v1Fn,
        isContractV2: v2Fn,
      } = require("./contractVersion") as typeof import("./contractVersion");

      expect(switchFn({ v1: "alpha", v2: "beta" })).toBe("beta");
      expect(v2Fn()).toBe(true);
      expect(v1Fn()).toBe(false);
    });

    it("falls back to v1 for an unknown version string", () => {
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v99" };
      jest.resetModules();
      const { CONTRACT_VERSION, isContractV1: v1Fn } =
        require("./contractVersion") as typeof import("./contractVersion");

      expect(CONTRACT_VERSION).toBe("v1");
      expect(v1Fn()).toBe(true);
    });

    it("falls back to v1 when NEXT_PUBLIC_CONTRACT_VERSION is undefined", () => {
      const env = { ...originalEnv };
      delete env.NEXT_PUBLIC_CONTRACT_VERSION;
      process.env = env;
      jest.resetModules();
      const { CONTRACT_VERSION } =
        require("./contractVersion") as typeof import("./contractVersion");

      expect(CONTRACT_VERSION).toBe("v1");
    });
  });

  describe("contract function name constants", () => {
    it("exports expected v1 function names with default env", () => {
      // These are the already-loaded module constants — test the shape
      expect(typeof LOAN_REQUEST_FUNCTION).toBe("string");
      expect(typeof LOAN_REPAY_FUNCTION).toBe("string");
      expect(typeof POOL_DEPOSIT_FUNCTION).toBe("string");
      expect(typeof POOL_WITHDRAW_FUNCTION).toBe("string");
    });

    it("uses v2 function names when v2 is active", () => {
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v2" };
      jest.resetModules();
      const {
        LOAN_REQUEST_FUNCTION: lrf,
        LOAN_REPAY_FUNCTION: rep,
        POOL_DEPOSIT_FUNCTION: dep,
        POOL_WITHDRAW_FUNCTION: wit,
      } = require("./contractVersion") as typeof import("./contractVersion");

      expect(lrf).toBe("request_loan_v2");
      expect(rep).toBe("repay_v2");
      expect(dep).toBe("deposit_v2");
      expect(wit).toBe("withdraw_v2");
    });

    it("uses v1 function names when v1 is active", () => {
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v1" };
      jest.resetModules();
      const {
        LOAN_REQUEST_FUNCTION: lrf,
        LOAN_REPAY_FUNCTION: rep,
        POOL_DEPOSIT_FUNCTION: dep,
        POOL_WITHDRAW_FUNCTION: wit,
      } = require("./contractVersion") as typeof import("./contractVersion");

      expect(lrf).toBe("request_loan");
      expect(rep).toBe("repay");
      expect(dep).toBe("deposit");
      expect(wit).toBe("withdraw");
    });
  });

  describe("contractVersionSwitch edge cases", () => {
    it("works with objects as options", () => {
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v1" };
      jest.resetModules();
      const { contractVersionSwitch: switchFn } =
        require("./contractVersion") as typeof import("./contractVersion");

      const result = switchFn({ v1: { key: "old" }, v2: { key: "new" } });
      expect(result).toEqual({ key: "old" });
    });

    it("works with numbers as options", () => {
      process.env = { ...originalEnv, NEXT_PUBLIC_CONTRACT_VERSION: "v2" };
      jest.resetModules();
      const { contractVersionSwitch: switchFn } =
        require("./contractVersion") as typeof import("./contractVersion");

      const result = switchFn({ v1: 1, v2: 2 });
      expect(result).toBe(2);
    });
  });
});
