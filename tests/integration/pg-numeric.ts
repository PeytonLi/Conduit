import pg from "pg";

/** node-pg returns numeric as strings; parse so domain/tests keep using JS numbers. */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid numeric value from postgres: ${value}`);
  }
  return parsed;
});
