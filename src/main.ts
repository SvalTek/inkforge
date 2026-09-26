import { createApp } from "./app/app.ts";

const app = createApp();
// Expose the app for test harnesses; production code never reads this.
(globalThis as { inkforgeApp?: typeof app }).inkforgeApp = app;
void app.initialise();
