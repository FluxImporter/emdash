import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, expect, vi } from "vitest";
import { takeViolations } from "./harness.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
	// happy-dom keeps the URL across a file's tests; `?step=` and `?job=` must not leak (F21).
	window.history.replaceState(null, "", "/");
	// A request the harness refused fails the test, even when the component caught the error.
	expect(takeViolations(), "requests mockRoutes refused").toEqual([]);
});
