import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	// happy-dom keeps the URL across a file's tests; `?step=` and `?job=` must not leak (F21).
	window.history.replaceState(null, "", "/");
});
