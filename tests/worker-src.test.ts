import { describe, expect, it } from "vitest";
import { workerSrcFor } from "../src/utils";

describe("workerSrcFor", () => {
  it("uses the caller's workerSrc, a string or a URL, over anything set", () => {
    expect(workerSrcFor("/assets/w.mjs", "/old.mjs", "5.4.449")).toBe(
      "/assets/w.mjs",
    );
    expect(workerSrcFor(new URL("https://app.test/w.mjs"), "", "5.4.449")).toBe(
      "https://app.test/w.mjs",
    );
  });

  it("keeps a worker the host app already set on this pdf.js", () => {
    expect(workerSrcFor(null, "/pdf.worker.min.mjs", "5.4.449")).toBe(
      "/pdf.worker.min.mjs",
    );
  });

  it("falls back to the matching version on cdnjs", () => {
    expect(workerSrcFor(null, "", "5.4.449")).toBe(
      "//cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.449/pdf.worker.min.mjs",
    );
  });
});
