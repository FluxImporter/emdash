import {
	createContext,
	type Dispatch,
	type ReactNode,
	useContext,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { initialState, reducer, type WizardAction, type WizardState } from "./state.js";

/** The `once` key of the dry run's job creation, forgotten whenever the draft changes. */
export const DRY_RUN_KEY = "dry-run";

export interface Once {
	/** Runs `run` once per key: a second call while it is in flight, or once it is done, gets the same promise. */
	once(key: string, run: () => Promise<void>): Promise<void>;
	/** Lets the next call with `key` run again. */
	forget(key: string): void;
}

/**
 * Runs each keyed task at most once (preflight F14), so a step that remounts while its
 * `jobs/create` is in flight sends one request. A task that fails is forgotten, so it can be
 * tried again.
 */
export function createOnce(): Once {
	const running = new Map<string, Promise<void>>();
	return {
		once(key, run) {
			const current = running.get(key);
			if (current !== undefined) return current;
			const task = run();
			running.set(key, task);
			task.catch(() => {
				if (running.get(key) === task) running.delete(key);
			});
			return task;
		},
		forget(key) {
			running.delete(key);
		},
	};
}

/**
 * `dispatch` that first forgets the dry run's job creation whenever the action changes the draft
 * (preflight F14), so Preview creates a new one for it. It follows its own dispatches through the
 * pure reducer from `initial`, so a no-op edit forgets nothing (review ruling 3), and two
 * dispatches before a render are both seen.
 */
export function draftDispatch(
	dispatch: Dispatch<WizardAction>,
	tasks: Pick<Once, "forget">,
	initial: WizardState,
): Dispatch<WizardAction> {
	let latest = initial;
	return (action) => {
		const next = reducer(latest, action);
		if (next.generation !== latest.generation) tasks.forget(DRY_RUN_KEY);
		latest = next;
		dispatch(action);
	};
}

interface WizardContextValue {
	state: WizardState;
	dispatch: Dispatch<WizardAction>;
	once: Once["once"];
}

const WizardContext = createContext<WizardContextValue | null>(null);

export function WizardProvider(props: { initial?: Partial<WizardState>; children: ReactNode }) {
	const [start] = useState(() => ({ ...initialState, ...props.initial }));
	const [state, rawDispatch] = useReducer(reducer, start);
	const tasks = useRef<Once | null>(null);
	tasks.current ??= createOnce();
	const once = tasks.current;
	// Kept in a ref, not a memo: its record of the state must never be rebuilt from `start`.
	const dispatchRef = useRef<Dispatch<WizardAction> | null>(null);
	dispatchRef.current ??= draftDispatch(rawDispatch, once, start);
	const dispatch = dispatchRef.current;
	const value = useMemo(() => ({ state, dispatch, once: once.once }), [state, dispatch, once]);
	return <WizardContext.Provider value={value}>{props.children}</WizardContext.Provider>;
}

/** The wizard's state, its dispatch, and `once` for job creation (preflight F14). */
export function useWizard(): WizardContextValue {
	const value = useContext(WizardContext);
	if (value === null) throw new Error("useWizard needs a WizardProvider");
	return value;
}
