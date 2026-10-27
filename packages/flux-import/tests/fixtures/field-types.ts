/**
 * Sources and templates that map one field of every M4a type, for the Node and workerd
 * integration tests. The CSV gives every value as text; the JSON gives typed values (numbers,
 * booleans, arrays, objects). Both use the same column names, so one template serves both.
 */

export const TYPES_COLUMNS = [
	"sku",
	"Name",
	"Code",
	"Price",
	"Stock",
	"Featured",
	"Stage",
	"Colours",
	"Released",
	"SoldAt",
	"Launch",
	"Specs",
	"Handle",
] as const;

/** The template: `released` reads the site timezone, `launch_day` is a calendar date in text. */
export function typesTemplate(collection: string, format: "csv" | "json" = "csv") {
	return {
		version: 1,
		collection,
		locale: "en",
		source: { format },
		key: { from: "sku" },
		fields: {
			title: { from: "Name", type: "text" },
			code: { from: "Code", type: "text" },
			price: { from: "Price", type: "number", decimal: ",", thousands: "." },
			stock: { from: "Stock", type: "number" },
			featured: { from: "Featured", type: "boolean", true: ["ja"], false: ["nein"] },
			stage: {
				from: "Stage",
				type: "select",
				map: { Live: "live", Draft: "draft", Hidden: "hidden" },
			},
			colours: {
				from: "Colours",
				type: "multiSelect",
				separator: "|",
				map: { Rot: "red", Grün: "green", Blau: "blue" },
			},
			released: { from: "Released", type: "date", format: "dd.MM.yyyy HH:mm", tz: "site" },
			sold_on: { from: "SoldAt", type: "date", format: "unix" },
			launch_day: { from: "Launch", type: "date", tz: "Europe/Chisinau", output: "yyyy-MM-dd" },
			specs: { from: "Specs", type: "json" },
			legacy: { from: "Handle", type: "slug" },
		},
	};
}

/** Three rows that fit the fields' rules once the site timezone is Europe/Chisinau. */
export const TYPES_CSV = [
	TYPES_COLUMNS.join(","),
	'C1,Desk,ABC-1,"1.234,50",12,ja,Live,red|Blau,24.01.2025 14:00,1737720000,2025-01-24T23:30:00Z,"{""w"": 120, ""tags"": [""oak""]}",Old Desk',
	'C2,Chair,ABC-2,"99,5",3,NEIN,draft,Grün,01.07.2025 09:30,1751362200.5,2025-07-01T10:00:00Z,"[1,2]",chair',
	"C3,Lamp,ABC-3,0,0,Ja,HIDDEN,,29.03.2026 02:30,1774742400,2026-03-29T00:30:00Z,,Lamp №3",
	"",
].join("\n");

/** What `TYPES_CSV` reads back as through EmDash's content API, by source key. */
export const TYPES_CSV_STORED = {
	C1: {
		title: "Desk",
		code: "ABC-1",
		price: 1234.5,
		stock: 12,
		featured: 1,
		stage: "live",
		colours: ["red", "blue"],
		released: "2025-01-24T12:00:00.000Z",
		sold_on: "2025-01-24T12:00:00.000Z",
		launch_day: "2025-01-25",
		specs: { w: 120, tags: ["oak"] },
		legacy: "old-desk",
	},
	C2: {
		title: "Chair",
		price: 99.5,
		stock: 3,
		featured: 0,
		stage: "draft",
		colours: ["green"],
		released: "2025-07-01T06:30:00.000Z",
		sold_on: "2025-07-01T09:30:00.500Z",
		launch_day: "2025-07-01",
		specs: [1, 2],
		legacy: "chair",
	},
	C3: {
		title: "Lamp",
		price: 0,
		stock: 0,
		featured: 1,
		stage: "hidden",
		released: "2026-03-29T00:30:00.000Z",
		launch_day: "2026-03-29",
		legacy: "lamp-no3",
	},
};

/** Typed JSON records with the same columns. */
export const TYPES_JSON = JSON.stringify([
	{
		sku: "J1",
		Name: "Shelf",
		Code: "XYZ-9",
		Price: 1500.25,
		Stock: 7,
		Featured: true,
		Stage: "Live",
		Colours: ["Grün", "red", "green"],
		Released: "05.05.2025 08:00",
		SoldAt: 1746432000,
		Launch: "2025-05-05T08:00:00Z",
		Specs: { d: { x: 1 }, tags: ["oak", "ash"] },
		Handle: "Shelf Big",
	},
	{
		sku: "J2",
		Name: "Stool",
		Code: "XYZ-10",
		Price: 20,
		Stock: 1,
		Featured: false,
		Stage: "draft",
		Colours: [],
		Released: "06.05.2025 08:00",
		SoldAt: "1746432000",
		Launch: "2025-05-06T08:00:00Z",
		Specs: '{"note":"parsed"}',
		Handle: "stool",
	},
]);
