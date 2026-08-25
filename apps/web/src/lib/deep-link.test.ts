import { afterEach, describe, expect, it } from "vitest";
import { expectedScheme, isAllowedRedirect } from "./deep-link";

const original = process.env.MOBILE_DEEP_LINK_SCHEME;

afterEach(() => {
  if (original === undefined) delete process.env.MOBILE_DEEP_LINK_SCHEME;
  else process.env.MOBILE_DEEP_LINK_SCHEME = original;
});

describe("expectedScheme", () => {
  it("defaults to trilog when unset", () => {
    delete process.env.MOBILE_DEEP_LINK_SCHEME;
    expect(expectedScheme()).toBe("trilog");
  });

  it("honours the environment override", () => {
    process.env.MOBILE_DEEP_LINK_SCHEME = "custom";
    expect(expectedScheme()).toBe("custom");
  });
});

describe("isAllowedRedirect", () => {
  it("accepts the configured scheme", () => {
    delete process.env.MOBILE_DEEP_LINK_SCHEME;
    expect(isAllowedRedirect("trilog://callback")).toBe(true);
  });

  it("rejects other schemes and arbitrary URLs", () => {
    delete process.env.MOBILE_DEEP_LINK_SCHEME;
    expect(isAllowedRedirect("trihard://callback")).toBe(false);
    expect(isAllowedRedirect("https://evil.example.com")).toBe(false);
    expect(isAllowedRedirect("//evil.example.com")).toBe(false);
    expect(isAllowedRedirect("")).toBe(false);
  });

  it("does not match a scheme that merely starts the same", () => {
    process.env.MOBILE_DEEP_LINK_SCHEME = "trilog";
    expect(isAllowedRedirect("trilogx://callback")).toBe(false);
  });
});
