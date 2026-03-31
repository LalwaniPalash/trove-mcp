import type { AppConfig } from "./config.js";

export class Logger {
  constructor(private readonly config: AppConfig) {}

  info(message: string, meta?: unknown): void {
    this.write("info", message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.write("warn", message, meta);
  }

  error(message: string, meta?: unknown): void {
    this.write("error", message, meta);
  }

  debug(message: string, meta?: unknown): void {
    if (!this.config.debug) {
      return;
    }
    this.write("debug", message, meta);
  }

  private write(level: string, message: string, meta?: unknown): void {
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };
    console.error(JSON.stringify(payload));
  }
}
