export const EXPORT_THEME_LIGHT_CSS = `
.tms-mde-export-root {
	--tms-bg: #f5f5f5;
	--tms-fg: #1a1a1a;
	--tms-accent: #2563eb;
	--tms-mde-color-bg: #ffffff;
	--tms-mde-color-surface: #ffffff;
	--tms-mde-color-border: #c8c8c8;
	--tms-mde-color-text: #1a1a1a;
	--tms-mde-color-text-muted: #555555;
	--tms-mde-color-syntax-keyword: #7c3aed;
	--tms-mde-color-syntax-atom: #2563eb;
	--tms-mde-color-syntax-number: #0f766e;
	--tms-mde-color-syntax-string: #b91c1c;
	--tms-mde-color-syntax-regexp: #c2410c;
	--tms-mde-color-syntax-comment: #6b7280;
	--tms-mde-color-syntax-variable: #1d4ed8;
	--tms-mde-color-syntax-type: #0f766e;
	--tms-mde-color-syntax-property: #0369a1;
	--tms-mde-color-syntax-invalid: #dc2626;
	--tms-mde-color-code-bg: #eef2f6;
	--tms-mde-color-primary: #2563eb;
	--tms-mde-color-link: #0284c7;
	--tms-mde-color-heading: #111827;
	--tms-mde-color-highlight-bg: rgba(250, 204, 21, 0.4);
	--tms-mde-color-error: #b91c1c;
	--tms-mde-font-family: "Segoe UI", "Meiryo", sans-serif;
	--tms-mde-font-mono: Consolas, "Cascadia Mono", "Meiryo UI", monospace;
	color-scheme: light;
}
`;

export const EXPORT_THEME_DARK_CSS = `
.tms-mde-export-root.tms-mde-theme-dark {
	--tms-bg: #1e1e1e;
	--tms-fg: #f0f0f0;
	--tms-accent: #3b82f6;
	--tms-mde-color-bg: #1e1e1e;
	--tms-mde-color-surface: #2d2d2d;
	--tms-mde-color-border: #5a5a5a;
	--tms-mde-color-text: #f0f0f0;
	--tms-mde-color-text-muted: #bcbcbc;
	--tms-mde-color-syntax-keyword: #c4b5fd;
	--tms-mde-color-syntax-atom: #93c5fd;
	--tms-mde-color-syntax-number: #5eead4;
	--tms-mde-color-syntax-string: #fca5a5;
	--tms-mde-color-syntax-regexp: #fdba74;
	--tms-mde-color-syntax-comment: #9ca3af;
	--tms-mde-color-syntax-variable: #93c5fd;
	--tms-mde-color-syntax-type: #6ee7b7;
	--tms-mde-color-syntax-property: #7dd3fc;
	--tms-mde-color-syntax-invalid: #f87171;
	--tms-mde-color-code-bg: #343e5d;
	--tms-mde-color-primary: #3b82f6;
	--tms-mde-color-link: #38bdf8;
	--tms-mde-color-heading: #f8fafc;
	--tms-mde-color-highlight-bg: rgba(250, 204, 21, 0.28);
	--tms-mde-color-error: #fca5a5;
	color-scheme: dark;
}
`;

export const EXPORT_PREVIEW_CSS = `
.tms-mde-export-root {
	margin: 0;
	background: var(--tms-mde-color-bg);
	color: var(--tms-mde-color-text);
	font-family: var(--tms-mde-font-family);
}
.tms-mde-export {
	max-width: 52rem;
	margin: 0 auto;
	padding: 2rem 1.5rem 3rem;
	line-height: 1.65;
}
.tms-mde-export h1, .tms-mde-export h2, .tms-mde-export h3,
.tms-mde-export h4, .tms-mde-export h5, .tms-mde-export h6 {
	margin: 0;
	scroll-margin-top: 1rem;
	font-size: inherit;
	font-weight: inherit;
}
.tms-mde-export h1, .tms-mde-export .cm-md-h1 { color: var(--tms-mde-color-heading); font-weight: 700; font-size: 1.75em; line-height: 1.25; }
.tms-mde-export h2, .tms-mde-export .cm-md-h2 { color: var(--tms-mde-color-heading); font-weight: 700; font-size: 1.5em; line-height: 1.3; }
.tms-mde-export h3, .tms-mde-export .cm-md-h3 { color: var(--tms-mde-color-heading); font-weight: 700; font-size: 1.25em; line-height: 1.35; }
.tms-mde-export h4, .tms-mde-export .cm-md-h4 { color: var(--tms-mde-color-heading); font-weight: 700; font-size: 1.1em; }
.tms-mde-export h5, .tms-mde-export .cm-md-h5 { color: var(--tms-mde-color-heading); font-weight: 700; font-size: 1em; }
.tms-mde-export h6, .tms-mde-export .cm-md-h6 { color: var(--tms-mde-color-heading); font-weight: 700; font-size: 0.95em; }
.tms-mde-export .cm-md-em { font-style: italic; }
.tms-mde-export .cm-md-strong { font-weight: 700; }
.tms-mde-export .cm-md-strike { text-decoration: line-through; }
.tms-mde-export .cm-md-highlight { border-radius: 2px; background: var(--tms-mde-color-highlight-bg); }
.tms-mde-export .cm-md-code { padding: 0 0.2em; border-radius: 3px; background: var(--tms-mde-color-code-bg); font-family: var(--tms-mde-font-mono); }
.tms-mde-export .cm-md-link { color: var(--tms-mde-color-link); text-decoration: none; }
.tms-mde-export .cm-md-wikilink { color: var(--tms-mde-color-primary); text-decoration: underline; }
.tms-mde-export .tms-underline { text-decoration: underline; text-underline-offset: 0.15em; }
.tms-mde-export blockquote, .tms-mde-export .cm-md-blockquote {
	margin: 0.6em 0;
	padding-left: 0.75em;
	border-left: 3px solid var(--tms-mde-color-primary);
}
.tms-mde-export .cm-md-callout {
	--tms-mde-callout-rgb: 8, 109, 221;
	--tms-mde-callout-accent: rgb(var(--tms-mde-callout-rgb));
	--tms-mde-callout-bg: rgba(var(--tms-mde-callout-rgb), 0.15);
	margin: 0.75em 0;
	padding: 0.15em 0.6em 0.15em 0.75em;
	border-left: 4px solid var(--tms-mde-callout-accent);
	background: rgba(var(--tms-mde-callout-rgb), 0.08);
}
.tms-mde-export .cm-md-callout-note { --tms-mde-callout-rgb: 8, 109, 221; }
.tms-mde-export .cm-md-callout-info { --tms-mde-callout-rgb: 8, 109, 221; }
.tms-mde-export .cm-md-callout-tip { --tms-mde-callout-rgb: 0, 191, 165; }
.tms-mde-export .cm-md-callout-warning { --tms-mde-callout-rgb: 236, 117, 0; }
.tms-mde-export .cm-md-callout-danger { --tms-mde-callout-rgb: 233, 49, 71; }
.tms-mde-export .cm-md-callout-quote { --tms-mde-callout-rgb: 158, 158, 158; }
.tms-mde-export .cm-md-callout-title {
	margin: 0 0 0.35em;
	padding: 0.2em 0;
	background: var(--tms-mde-callout-bg);
	font-weight: 600;
	color: var(--tms-mde-callout-accent);
}
.tms-mde-export hr { border: 0; border-top: 1px solid var(--tms-mde-color-border); }
.tms-mde-export pre, .tms-mde-export .cm-md-fenced-code {
	margin: 0.75em 0;
	padding: 0.75em 1em;
	overflow: auto;
	background: var(--tms-mde-color-code-bg);
	font-family: var(--tms-mde-font-mono);
	font-size: 0.92em;
	white-space: pre;
}
.tms-mde-export .cm-md-syntax-keyword { color: var(--tms-mde-color-syntax-keyword); }
.tms-mde-export .cm-md-syntax-atom { color: var(--tms-mde-color-syntax-atom); }
.tms-mde-export .cm-md-syntax-number { color: var(--tms-mde-color-syntax-number); }
.tms-mde-export .cm-md-syntax-string { color: var(--tms-mde-color-syntax-string); }
.tms-mde-export .cm-md-syntax-regexp { color: var(--tms-mde-color-syntax-regexp); }
.tms-mde-export .cm-md-syntax-comment { color: var(--tms-mde-color-syntax-comment); }
.tms-mde-export .cm-md-syntax-variable { color: var(--tms-mde-color-syntax-variable); }
.tms-mde-export .cm-md-syntax-type { color: var(--tms-mde-color-syntax-type); }
.tms-mde-export .cm-md-syntax-property { color: var(--tms-mde-color-syntax-property); }
.tms-mde-export .cm-md-syntax-invalid { color: var(--tms-mde-color-syntax-invalid); }
.tms-mde-export .cm-md-table-wrap { overflow-x: auto; margin: 0.35em 0; }
.tms-mde-export .cm-md-table { border-collapse: collapse; min-width: 40%; }
.tms-mde-export .cm-md-table th, .tms-mde-export .cm-md-table td {
	padding: 0.35em 0.7em;
	border: 1px solid var(--tms-mde-color-border);
	vertical-align: top;
}
.tms-mde-export .cm-md-table th { font-weight: 600; background: color-mix(in srgb, var(--tms-mde-color-primary) 16%, var(--tms-mde-color-surface)); }
.tms-mde-export .cm-md-image { max-width: min(100%, 720px); height: auto; }
.tms-mde-export .cm-md-image-fallback {
	display: inline-block;
	padding: 0.25em 0.5em;
	border: 1px dashed var(--tms-mde-color-border);
	color: var(--tms-mde-color-text-muted);
}
.tms-mde-export .cm-md-mermaid { margin: 0.75em 0; overflow: auto; }
.tms-mde-export .cm-md-mermaid svg { max-width: 100%; height: auto; }
.tms-mde-export .cm-md-mermaid-error { color: var(--tms-mde-color-error); }
.tms-mde-export .cm-md-checkbox { margin-right: 0.4em; vertical-align: -0.15em; accent-color: var(--tms-mde-color-primary); }
`;

export const EXPORT_OUTLINE_CSS = `
.tms-mde-export-shell {
	display: grid;
	grid-template-columns: minmax(0, 1fr) clamp(200px, 22vw, 320px);
	grid-template-areas: "article outline";
	align-items: start;
	min-height: 100vh;
}
.tms-mde-export-shell:has(#tms-mde-export-outline-side-left:checked) {
	grid-template-columns: clamp(200px, 22vw, 320px) minmax(0, 1fr);
	grid-template-areas: "outline article";
}
.tms-mde-export-shell > .tms-mde-editor-host {
	grid-area: article;
	min-width: 0;
}
.tms-mde-export-outline {
	grid-area: outline;
	position: sticky;
	top: 0;
	box-sizing: border-box;
	max-height: 100vh;
	padding: 16px 12px 32px;
	overflow-y: auto;
	border-left: 1px solid var(--tms-mde-color-border);
	background: var(--tms-mde-color-surface);
	color: var(--tms-mde-color-text);
}
.tms-mde-export-shell:has(#tms-mde-export-outline-side-left:checked) .tms-mde-export-outline {
	border-left: none;
	border-right: 1px solid var(--tms-mde-color-border);
}
.tms-mde-export-outline-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 0.5rem;
}
.tms-mde-export-outline-title {
	margin: 0;
	font-size: 13px;
	font-weight: 600;
}
.tms-mde-export-outline-toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	margin-left: auto;
}
.tms-mde-export-outline-fold-all {
	padding: 3px 6px;
	border: 1px solid var(--tms-mde-color-border);
	border-radius: 4px;
	background: var(--tms-mde-color-bg);
	color: var(--tms-mde-color-text);
	font: inherit;
	font-size: 11px;
	line-height: 1.4;
	white-space: nowrap;
	cursor: pointer;
}
.tms-mde-export-outline-fold-all:hover,
.tms-mde-export-outline-fold-all:focus-visible {
	border-color: var(--tms-mde-color-primary);
}
.tms-mde-export-outline-side {
	position: relative;
	display: inline-flex;
	margin: 0;
	padding: 2px;
	border: 1px solid var(--tms-mde-color-border);
	border-radius: 4px;
	background: var(--tms-mde-color-bg);
}
.tms-mde-export-outline-side-legend {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
}
.tms-mde-export-outline-side input {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
}
.tms-mde-export-outline-side label {
	padding: 2px 8px;
	border-radius: 3px;
	color: var(--tms-mde-color-text-muted);
	font-size: 11px;
	line-height: 1.4;
	cursor: pointer;
}
.tms-mde-export-outline-side input:checked + label {
	background: color-mix(in srgb, var(--tms-mde-color-primary) 22%, transparent);
	color: var(--tms-mde-color-text);
}
.tms-mde-export-outline-side input:focus-visible + label {
	outline: 2px solid var(--tms-mde-color-primary);
	outline-offset: 1px;
}
.tms-mde-export-outline-list {
	--tms-mde-outline-indent: 14px;
	--tms-mde-outline-guide-color: color-mix(in srgb, var(--tms-mde-color-border) 70%, var(--tms-mde-color-text-muted));
}
.tms-mde-export-outline-node {
	position: relative;
}
.tms-mde-export-outline-children {
	margin: 0;
	padding: 0;
	border: none;
}
.tms-mde-export-outline-fold {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
	pointer-events: none;
}
.tms-mde-export-outline-fold:not(:checked) ~ .tms-mde-export-outline-children {
	display: none;
}
.tms-mde-export-outline-row {
	position: relative;
	display: flex;
	align-items: center;
	min-width: 0;
	padding-left: calc(8px + (var(--tms-mde-outline-level) - 1) * var(--tms-mde-outline-indent));
}
.tms-mde-export-outline-guides {
	position: absolute;
	top: 0;
	bottom: 0;
	left: 8px;
	display: flex;
	pointer-events: none;
}
.tms-mde-export-outline-guide {
	position: relative;
	flex: 0 0 var(--tms-mde-outline-indent);
	width: var(--tms-mde-outline-indent);
}
.tms-mde-export-outline-guide::after {
	content: "";
	position: absolute;
	top: 0;
	bottom: 0;
	left: 6px;
	width: 1px;
	background-color: var(--tms-mde-outline-guide-color);
}
.tms-mde-export-outline-twist {
	flex: 0 0 16px;
	width: 16px;
	height: 22px;
	color: var(--tms-mde-color-text-muted);
	font-size: 9px;
	font-weight: 400;
	line-height: 22px;
	text-align: center;
	user-select: none;
	cursor: pointer;
}
.tms-mde-export-outline-twist::before {
	content: "▼";
}
.tms-mde-export-outline-fold:not(:checked) + .tms-mde-export-outline-row .tms-mde-export-outline-twist::before {
	content: "▶";
}
.tms-mde-export-outline-twist.is-leaf {
	cursor: default;
	pointer-events: none;
}
.tms-mde-export-outline-twist.is-leaf::before {
	content: none;
}
.tms-mde-export-outline-item {
	display: block;
	flex: 1 1 auto;
	min-width: 0;
	padding: 5px 8px 5px 2px;
	overflow: hidden;
	border-radius: 4px;
	color: var(--tms-mde-color-text-muted);
	font-size: 12px;
	line-height: 1.4;
	text-decoration: none;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.tms-mde-export-outline-item:hover,
.tms-mde-export-outline-item:focus-visible {
	background-color: var(--tms-mde-color-bg);
	color: var(--tms-mde-color-text);
}
.tms-mde-export-outline-empty {
	margin: 0;
	padding: 8px 4px;
	color: var(--tms-mde-color-text-muted);
	font-size: 12px;
}
.tms-mde-export :target {
	outline: 2px solid color-mix(in srgb, var(--tms-mde-color-primary) 55%, transparent);
	outline-offset: 2px;
}
`;

export const EXPORT_PRINT_CSS = `
@page { size: A4; margin: 16mm 14mm; }
.tms-mde-export-root, .tms-mde-export-root * {
	-webkit-print-color-adjust: exact;
	print-color-adjust: exact;
}
@media print {
	.tms-mde-export-outline { display: none !important; }
	.tms-mde-export-shell { display: block; }
	.tms-mde-export { max-width: none; padding: 0; }
	.tms-mde-export-root {
		--mde-snippet-table-max-height: none;
	}
	.tms-mde-editor-host .cm-md-table-wrap,
	.tms-mde-export .cm-md-table-wrap,
	.tms-mde-editor-host .cm-md-mermaid,
	.tms-mde-export .cm-md-mermaid,
	.tms-mde-editor-host .cm-md-mermaid-wrap,
	.tms-mde-export pre {
		max-height: none !important;
		overflow: visible !important;
	}
	.tms-mde-export .cm-md-table {
		break-inside: auto;
	}
	.tms-mde-export .cm-md-callout, .tms-mde-export .cm-md-mermaid {
		break-inside: avoid;
	}
}
`;
