import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class D1PreparedAdapter {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new D1PreparedAdapter(this.database, this.sql, values);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) ?? null;
  }

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.values),
      success: true,
    };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

export class D1DatabaseAdapter {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    const migrations = readdirSync(new URL("../migrations/", import.meta.url))
      .filter((name) => /^\d+_.+\.sql$/u.test(name))
      .sort((left, right) => {
        const versionOrder = Number.parseInt(left, 10) - Number.parseInt(right, 10);
        return versionOrder || left.localeCompare(right);
      });
    for (const migration of migrations) {
      this.sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
    }
  }

  prepare(sql) {
    return new D1PreparedAdapter(this.sqlite, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}
