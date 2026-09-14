import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

export const DEFAULT_THEME = "pi-student";

export const BUNDLED_THEME_NAMES = [
	DEFAULT_THEME,
	"tokyo-night",
	"catppuccin-mocha",
	"nord",
	"gruvbox-dark",
	"cyber-neon",
	"mono-dark",
	"paper-light",
	"catppuccin-latte",
] as const;

type ThemeBackground =
	| "selectedBg"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

export interface TerminalPalette {
	accent: string;
	secondary: string;
	success: string;
	warning: string;
	error: string;
	text: string;
	muted: string;
	dim: string;
	surface: string;
	surfaceRaised: string;
	selection: string;
	pending: string;
	successSurface: string;
	errorSurface: string;
}

const PALETTES: Readonly<Record<(typeof BUNDLED_THEME_NAMES)[number], TerminalPalette>> = {
	"pi-student": {
		accent: "#71d7ff", secondary: "#a7b4d6", success: "#73daca", warning: "#e0af68", error: "#f7768e",
		text: "#d8dee9", muted: "#8997b3", dim: "#59677f", surface: "#111a27", surfaceRaised: "#172231",
		selection: "#26354a", pending: "#172a3b", successSurface: "#18302f", errorSurface: "#39232b",
	},
	"tokyo-night": {
		accent: "#7aa2f7", secondary: "#bb9af7", success: "#9ece6a", warning: "#e0af68", error: "#f7768e",
		text: "#c0caf5", muted: "#737aa2", dim: "#565f89", surface: "#16161e", surfaceRaised: "#1a1b26",
		selection: "#283457", pending: "#182b46", successSurface: "#1f3028", errorSurface: "#3b222d",
	},
	"catppuccin-mocha": {
		accent: "#cba6f7", secondary: "#89b4fa", success: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8",
		text: "#cdd6f4", muted: "#9399b2", dim: "#6c7086", surface: "#181825", surfaceRaised: "#1e1e2e",
		selection: "#313244", pending: "#202b42", successSurface: "#233326", errorSurface: "#3b2530",
	},
	"nord": {
		accent: "#88c0d0", secondary: "#81a1c1", success: "#a3be8c", warning: "#ebcb8b", error: "#bf616a",
		text: "#e5e9f0", muted: "#a7b0c0", dim: "#687386", surface: "#252b35", surfaceRaised: "#2e3440",
		selection: "#3b4b60", pending: "#2b3c4c", successSurface: "#303e35", errorSurface: "#442d33",
	},
	"gruvbox-dark": {
		accent: "#fabd2f", secondary: "#83a598", success: "#b8bb26", warning: "#fe8019", error: "#fb4934",
		text: "#ebdbb2", muted: "#a89984", dim: "#665c54", surface: "#282828", surfaceRaised: "#32302f",
		selection: "#504945", pending: "#303d3d", successSurface: "#333d29", errorSurface: "#482b28",
	},
	"cyber-neon": {
		accent: "#00f5d4", secondary: "#9b5de5", success: "#7bff6a", warning: "#fee440", error: "#ff4d8d",
		text: "#e8f7ff", muted: "#8ba9c7", dim: "#52647a", surface: "#070b18", surfaceRaised: "#0d1326",
		selection: "#20204a", pending: "#092d3b", successSurface: "#10351f", errorSurface: "#3d122a",
	},
	"mono-dark": {
		accent: "#f2f2f2", secondary: "#c7c7c7", success: "#d9d9d9", warning: "#bdbdbd", error: "#ff7b7b",
		text: "#e5e5e5", muted: "#a3a3a3", dim: "#666666", surface: "#171717", surfaceRaised: "#202020",
		selection: "#383838", pending: "#262626", successSurface: "#2c2c2c", errorSurface: "#412626",
	},
	"paper-light": {
		accent: "#1d4ed8", secondary: "#6d28d9", success: "#047857", warning: "#a16207", error: "#be123c",
		text: "#1f2937", muted: "#5f6b7a", dim: "#8a94a3", surface: "#f4f1ea", surfaceRaised: "#fffdf7",
		selection: "#dbeafe", pending: "#e7f0fb", successSurface: "#e4f3eb", errorSurface: "#f9e4e8",
	},
	"catppuccin-latte": {
		accent: "#8839ef", secondary: "#1e66f5", success: "#40a02b", warning: "#df8e1d", error: "#d20f39",
		text: "#4c4f69", muted: "#6c6f85", dim: "#9ca0b0", surface: "#e6e9ef", surfaceRaised: "#eff1f5",
		selection: "#dce0e8", pending: "#dce8f7", successSurface: "#dfecdc", errorSurface: "#f2dce1",
	},
};

/** Themes use red exclusively for real failures and destructive diff removals. */
export function createBundledThemes(): Theme[] {
	return BUNDLED_THEME_NAMES.map((name) => createTheme(name, PALETTES[name]));
}

export function getTerminalPalette(name: string | undefined): TerminalPalette {
	return PALETTES[name as (typeof BUNDLED_THEME_NAMES)[number]] ?? PALETTES[DEFAULT_THEME];
}

export function resolveThemeAlias(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (normalized === "catppuccin") return "catppuccin-mocha";
	if (normalized === "tokyo") return "tokyo-night";
	if (normalized === "mono") return "mono-dark";
	return normalized;
}

function createTheme(name: string, palette: TerminalPalette): Theme {
	const foregrounds: Record<ThemeColor, string> = {
		accent: palette.accent,
		border: palette.muted,
		borderAccent: palette.accent,
		borderMuted: palette.dim,
		success: palette.success,
		error: palette.error,
		warning: palette.warning,
		muted: palette.muted,
		dim: palette.dim,
		text: palette.text,
		thinkingText: palette.muted,
		scrollbarTrack: palette.dim,
		scrollbarThumb: palette.accent,
		searchMatchText: palette.text,
		userMessageText: palette.text,
		customMessageText: palette.text,
		customMessageLabel: palette.secondary,
		toolTitle: palette.accent,
		toolOutput: palette.text,
		mdHeading: palette.accent,
		mdLink: palette.secondary,
		mdLinkUrl: palette.dim,
		mdCode: palette.secondary,
		mdCodeBlock: palette.text,
		mdCodeBlockBorder: palette.muted,
		mdQuote: palette.muted,
		mdQuoteBorder: palette.secondary,
		mdHr: palette.dim,
		mdListBullet: palette.accent,
		toolDiffAdded: palette.success,
		toolDiffRemoved: palette.error,
		toolDiffContext: palette.muted,
		syntaxComment: palette.dim,
		syntaxKeyword: palette.secondary,
		syntaxFunction: palette.accent,
		syntaxVariable: palette.text,
		syntaxString: palette.success,
		syntaxNumber: palette.warning,
		syntaxType: palette.secondary,
		syntaxOperator: palette.accent,
		syntaxPunctuation: palette.muted,
		thinkingOff: palette.dim,
		thinkingMinimal: palette.muted,
		thinkingLow: palette.secondary,
		thinkingMedium: palette.accent,
		thinkingHigh: palette.warning,
		thinkingXhigh: palette.secondary,
		thinkingMax: palette.accent,
		// Shell activity is informational, so it is deliberately never red.
		bashMode: palette.accent,
	};
	const backgrounds: Record<ThemeBackground, string> = {
		selectedBg: palette.selection,
		searchMatchBg: palette.selection,
		userMessageBg: palette.surfaceRaised,
		customMessageBg: palette.surface,
		toolPendingBg: palette.pending,
		toolSuccessBg: palette.successSurface,
		toolErrorBg: palette.errorSurface,
	};
	return new Theme(foregrounds, backgrounds, "truecolor", { name });
}
