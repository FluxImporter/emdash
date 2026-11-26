import { useCallback, useEffect, useRef, useState } from "react";

/** Below this content width, tables become stacked rows (Critique 1: the sidebar is 260px wide). */
export const NARROW_WIDTH = 700;

/**
 * Whether the element the returned ref is attached to is narrower than `width`, measured with a
 * ResizeObserver: the plugin page knows its own width, not the viewport's (Spec "Narrow layout").
 * Without ResizeObserver (old browsers, test DOMs) it stays wide.
 */
export function useNarrow<T extends HTMLElement>(
	width = NARROW_WIDTH,
): [(node: T | null) => void, boolean] {
	const [narrow, setNarrow] = useState(false);
	const observer = useRef<ResizeObserver | null>(null);
	const ref = useCallback(
		(node: T | null) => {
			observer.current?.disconnect();
			observer.current = null;
			if (node === null || typeof ResizeObserver === "undefined") return;
			const measure = (w: number) => setNarrow(w > 0 && w < width);
			measure(node.getBoundingClientRect().width);
			observer.current = new ResizeObserver(([entry]) => {
				if (entry) measure(entry.contentRect.width);
			});
			observer.current.observe(node);
		},
		[width],
	);
	useEffect(() => () => observer.current?.disconnect(), []);
	return [ref, narrow];
}
