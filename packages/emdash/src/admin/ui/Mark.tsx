/**
 * The Flux Importer mark (Home.dc.html), drawn in currentColor so it follows the admin theme.
 * Decorative: the heading beside it names the page.
 */
export function Mark() {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			viewBox="0 0 24 24"
			className="size-6 shrink-0 text-kumo-default"
		>
			<rect
				x="1"
				y="1"
				width="22"
				height="22"
				rx="5.5"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
			/>
			<rect x="5" y="6.6" width="5" height="2.2" rx="1.1" fill="currentColor" />
			<rect x="5" y="10.9" width="7.3" height="2.2" rx="1.1" fill="currentColor" />
			<rect x="5" y="15.2" width="5" height="2.2" rx="1.1" fill="currentColor" />
			<rect x="13.8" y="5.6" width="5" height="12.8" rx="1.4" fill="currentColor" />
		</svg>
	);
}
