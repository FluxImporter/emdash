// @ts-check
// Expressive Code: one navy theme for both colour modes, from the syntax tokens in
// src/styles/flux.css (--fx-syn-*). Blocks stay navy in light mode; only their background
// and border follow the mode (--fx-code-bg, --fx-code-line).
import { defineEcConfig, ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code";
import { pluginLineNumbers } from "@expressive-code/plugin-line-numbers";

const syn = {
	keyword: "#ffd23f",
	string: "#a6e3a1",
	function: "#8fd6ff",
	number: "#ffb4a2",
	comment: "#8aa0b2",
	punct: "#93a7b7",
	plain: "#e6edf2",
};

const fluxNavy = new ExpressiveCodeTheme({
	name: "flux-navy",
	type: "dark",
	colors: {
		"editor.background": "#07131d",
		"editor.foreground": syn.plain,
		"editorLineNumber.foreground": "#8299ad",
		"editor.selectionBackground": "#1d3a55",
	},
	tokenColors: [
		{ settings: { foreground: syn.plain } },
		{
			scope: ["comment", "punctuation.definition.comment"],
			settings: { foreground: syn.comment },
		},
		{
			scope: [
				"keyword",
				"storage",
				"storage.type",
				"storage.modifier",
				"constant.language",
				"variable.language",
				"entity.name.command",
				"support.function.builtin.shell",
			],
			settings: { foreground: syn.keyword },
		},
		{
			scope: ["string", "punctuation.definition.string", "string.quoted"],
			settings: { foreground: syn.string },
		},
		{
			scope: [
				"entity.name.function",
				"support.function",
				"meta.function-call entity.name.function",
				"support.type.property-name",
				"meta.object-literal.key",
				"entity.name.tag",
			],
			settings: { foreground: syn.function },
		},
		{ scope: ["constant.numeric"], settings: { foreground: syn.number } },
		{
			scope: [
				"punctuation",
				"meta.brace",
				"keyword.operator",
				"constant.other.option",
				"punctuation.separator",
			],
			settings: { foreground: syn.punct },
		},
	],
});

export default defineEcConfig({
	themes: [fluxNavy],
	plugins: [pluginLineNumbers()],
	defaultProps: { showLineNumbers: true },
	useStarlightDarkModeSwitch: false,
	useStarlightUiThemeColors: false,
	styleOverrides: {
		borderRadius: "var(--fx-radius-md)",
		borderColor: "var(--fx-code-line)",
		codeBackground: "var(--fx-code-bg)",
		codeFontFamily: "var(--fx-font-mono)",
		codeFontSize: "14px",
		codeLineHeight: "24px",
		uiFontFamily: "var(--fx-font-body)",
		uiFontSize: "13px",
		frames: {
			editorBackground: "var(--fx-code-bg)",
			terminalBackground: "var(--fx-code-bg)",
			editorTabBarBackground: "var(--fx-code-bg)",
			editorActiveTabBackground: "var(--fx-code-bg)",
			editorActiveTabForeground: "#ffffff",
			editorActiveTabIndicatorBottomColor: "transparent",
			editorActiveTabIndicatorTopColor: "transparent",
			editorTabBarBorderBottomColor: "#24425c",
			terminalTitlebarBackground: "var(--fx-code-bg)",
			terminalTitlebarBorderBottomColor: "#24425c",
			terminalTitlebarForeground: "#93a7b7",
			terminalTitlebarDotsForeground: "#3a5a76",
			frameBoxShadowCssValue: "none",
			inlineButtonForeground: "#e6edf2",
			inlineButtonBorder: "#3a5a76",
			tooltipSuccessBackground: "#5fd39a",
			tooltipSuccessForeground: "#0f2233",
		},
		lineNumbers: {
			foreground: "#8299ad",
			highlightForeground: "#c9d5de",
		},
		textMarkers: {
			markBackground: "rgba(255, 210, 63, 0.12)",
			markBorderColor: "#ffd23f",
			insBackground: "rgba(95, 211, 154, 0.12)",
			insBorderColor: "#5fd39a",
			insDiffIndicatorColor: "#5fd39a",
			delBackground: "rgba(255, 122, 122, 0.12)",
			delBorderColor: "#ff7a7a",
			delDiffIndicatorColor: "#ff7a7a",
			lineMarkerAccentWidth: "3px",
		},
	},
});
