import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Pin a DST-observing, positive-offset timezone so date-walk / week-bucket
    // behaviour is deterministic instead of depending on the CI machine's TZ.
    // It also lets the training-load regression test exercise the spring-forward
    // transition that the local-time day-walk used to mishandle.
    env: { TZ: "Europe/Copenhagen" },
  },
});
