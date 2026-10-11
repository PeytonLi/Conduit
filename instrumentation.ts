export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { initTelemetry } = await import("./lib/telemetry");
  await initTelemetry(process.env);
}
