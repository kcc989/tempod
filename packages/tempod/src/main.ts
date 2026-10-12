import { Deferred, Effect } from "effect";
import { setupCa } from "./ca.ts";
import { loadConfig, VERSION, type Config } from "./config.ts";
import { errorText, Logger } from "./log.ts";
import { bridgeMain } from "./mcp-bridge.ts";
import { startServer } from "./server.ts";
import { Tempod } from "./tempod.ts";

/** Startup steps 2 to 6 of 01 (tempod). Nothing starts and nothing goes out before `hello`. */
const program = (config: Config, log: Logger) =>
  Effect.gen(function* () {
    const caEnv = yield* Effect.promise(() => setupCa(config, log));
    const exitCode = yield* Deferred.make<number>();
    const exit = (code: number) => Deferred.doneUnsafe(exitCode, Effect.succeed(code));
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => new Tempod(config, { log, caEnv, exit })),
      (app) => Effect.promise(() => Promise.race([app.close(), Bun.sleep(10_000)])),
    );
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => startServer(app, { port: config.port })),
      (s) => Effect.promise(() => Promise.race([s.stop(), Bun.sleep(2_000)])),
    );
    log.info("tempod listening", {
      port: server.port,
      version: VERSION,
      incarnation: app.outbox.incarnation,
    });
    process.on("SIGTERM", () => app.onSigterm());
    process.on("SIGINT", () => app.onSigterm());
    return yield* Deferred.await(exitCode);
  }).pipe(Effect.scoped);

if (process.argv[2] === "mcp-bridge") {
  bridgeMain(process.argv.slice(3)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`mcp-bridge: ${errorText(e)}\n`);
      process.exit(1);
    },
  );
} else {
  const log = new Logger();
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    log.error("bad configuration", { error: errorText(e) });
    process.exit(2);
  }
  // Children must not see the token (01, Container config); the config holds the only copy.
  delete process.env["TEMPOD_TOKEN"];
  process.on("unhandledRejection", (e: unknown) =>
    log.local("error", "unhandled rejection", { error: errorText(e) }),
  );
  process.on("uncaughtException", (e: unknown) =>
    log.local("error", "uncaught exception", { error: errorText(e) }),
  );
  Effect.runPromise(program(config, log)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      log.error("tempod failed", { error: errorText(e) });
      process.exit(1);
    },
  );
}
