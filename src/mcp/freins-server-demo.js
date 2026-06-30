process.env.HEADLESS ??= "false";
process.env.DEMO_MODE ??= "true";
process.env.DEMO_SLOW_MO_MS ??= "450";

await import("./freins-server.js");