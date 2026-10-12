import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

// From https://docs.emdashcms.com/deployment/cloudflare/ ("Add the Worker entry point").
export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
