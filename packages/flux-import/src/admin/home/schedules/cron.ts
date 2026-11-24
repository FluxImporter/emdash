import type { ScheduleView } from "../../../plugin/schedules.js";
import { ERROR_MESSAGES } from "../../errors.js";
import type { Msg, Values } from "../../i18n.js";
import { type Day, M, PAUSE_MESSAGES, WEEKLY } from "./messages.js";

export { PAUSE_MESSAGES };

/**
 * When a schedule runs, as the dialog builds it (plan Ruling 13). Every time is UTC, as EmDash
 * evaluates plugin cron (Fact V4); nothing is converted. `day` is cron's: 0 is Sunday.
 */
export type Timing =
	| { kind: "hourly"; minute: number }
	| { kind: "daily"; hour: number; minute: number }
	| { kind: "weekly"; day: number; hour: number; minute: number }
	| { kind: "custom"; cron: string };

export function toCron(t: Timing): string {
	switch (t.kind) {
		case "hourly":
			return `${t.minute} * * * *`;
		case "daily":
			return `${t.minute} ${t.hour} * * *`;
		case "weekly":
			return `${t.minute} ${t.hour} * * ${t.day}`;
		case "custom":
			return t.cron;
	}
}

/** A number with no leading zero. */
const N = "(0|[1-9][0-9]?)";
const HOURLY = new RegExp(`^${N} \\* \\* \\* \\*$`);
const DAILY = new RegExp(`^${N} ${N} \\* \\* \\*$`);
const WEEKLY_CRON = new RegExp(`^${N} ${N} \\* \\* ([0-6])$`);

const inRange = (minute: number, hour = 0) => minute <= 59 && hour <= 23;

/**
 * The builder's timing for `cron`, when it is exactly one of the patterns `toCron` writes (single
 * spaces, numbers without leading zeros, in range, Sunday as 0); anything else is custom.
 */
export function fromCron(cron: string): Timing {
	const hourly = HOURLY.exec(cron);
	if (hourly) {
		const minute = Number(hourly[1]);
		if (inRange(minute)) return { kind: "hourly", minute };
	}
	const daily = DAILY.exec(cron);
	if (daily) {
		const minute = Number(daily[1]);
		const hour = Number(daily[2]);
		if (inRange(minute, hour)) return { kind: "daily", hour, minute };
	}
	const weekly = WEEKLY_CRON.exec(cron);
	if (weekly) {
		const minute = Number(weekly[1]);
		const hour = Number(weekly[2]);
		const day = Number(weekly[3]);
		if (inRange(minute, hour)) return { kind: "weekly", day, hour, minute };
	}
	return { kind: "custom", cron };
}

const two = (n: number) => String(n).padStart(2, "0");

/** `HH:MM`, the clock every UTC time in the tab is written with. */
export const clock = (hour: number, minute: number) => `${two(hour)}:${two(minute)}`;

/** When it runs, in words, with "UTC" wherever an hour is named. */
export function describeTiming(t: Timing): { msg: Msg; values: Values } {
	switch (t.kind) {
		case "hourly":
			return { msg: M.hourly, values: { minute: t.minute } };
		case "daily":
			return { msg: M.daily, values: { time: clock(t.hour, t.minute) } };
		case "weekly":
			return { msg: WEEKLY[t.day as Day] ?? M.custom, values: { time: clock(t.hour, t.minute) } };
		case "custom":
			return { msg: M.custom, values: { cron: t.cron } };
	}
}

/** Why a schedule paused; a reason a newer version added reads as unknown. */
export function pauseMessage(reason: string): Msg {
	return Object.hasOwn(PAUSE_MESSAGES, reason)
		? PAUSE_MESSAGES[reason as keyof typeof PAUSE_MESSAGES]
		: M.pauseUnknown;
}

/**
 * The last launch's outcome. A failure is its code's sentence (codes only, spec Ruling 47), or the
 * unknown one; the table words it as "Couldn't start: …".
 */
export function launchMessage(l: NonNullable<ScheduleView["lastLaunch"]>): Msg {
	switch (l.outcome) {
		case "started":
			return M.launchStarted;
		case "unchanged":
			return M.launchUnchanged;
		case "busy":
			return M.launchBusy;
		case "failed": {
			const code = l.errorCode;
			const known = code !== undefined && Object.hasOwn(ERROR_MESSAGES, code);
			return known ? ERROR_MESSAGES[code]! : ERROR_MESSAGES.unknown!;
		}
	}
}
