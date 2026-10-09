import { describe, expect, it } from "vitest";
import { capabilities, parseServerEnv } from "@/lib/env";

const requiredEnvironment = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "local-publishable-key",
  SUPABASE_SECRET_KEY: "local-secret-key",
};

describe("server environment", () => {
  it("defaults to replay and accepts empty optional integration keys", () => {
    const env = parseServerEnv(requiredEnvironment);

    expect(env.APP_ENV).toBe("replay");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(capabilities(env).deepseek).toEqual({
      ready: false,
      missing: ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"],
    });
  });

  it("reports readiness and missing variables without returning values", () => {
    const env = parseServerEnv({
      ...requiredEnvironment,
      APP_ENV: "sandbox",
      DEEPSEEK_API_KEY: "never-return-this",
      DEEPSEEK_MODEL: "model-x",
      EXA_API_KEY: "never-return-this-either",
    });
    const status = capabilities(env);

    expect(status.deepseek).toEqual({ ready: true, missing: [] });
    expect(status.exa).toEqual({ ready: true, missing: [] });
    expect(status.gmail).toEqual({
      ready: false,
      missing: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
    });
    expect(JSON.stringify(status)).not.toContain("never-return-this");
  });

  it("rejects invalid environment modes and missing Supabase configuration", () => {
    expect(() => parseServerEnv({ ...requiredEnvironment, APP_ENV: "production" })).toThrow();
    expect(() =>
      parseServerEnv({ SUPABASE_URL: "http://127.0.0.1:54321" }),
    ).toThrow();
  });
});
