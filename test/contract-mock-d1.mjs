function normalize(sql) {
  return sql.replace(/\s+/gu, " ").trim().toLowerCase();
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MockStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  first() {
    const result = this.database.execute(this.sql, this.args, "first");
    return Promise.resolve(result.rows[0] ?? null);
  }

  all() {
    const result = this.database.execute(this.sql, this.args, "all");
    return Promise.resolve({ results: result.rows });
  }

  run() {
    const result = this.database.execute(this.sql, this.args, "run");
    return Promise.resolve({ success: true, meta: { changes: result.changes } });
  }
}

export class MockD1 {
  constructor({ adminAccount = null, documents = [], settings = {}, limits = {} } = {}) {
    this.adminAccount = adminAccount ? clone(adminAccount) : null;
    this.documents = new Map(documents.map((document) => [document.id, clone(document)]));
    this.settings = new Map(Object.entries(settings));
    this.limits = new Map(
      Object.entries(limits).map(([key, value]) => [
        key,
        typeof value === "number" ? { count: value, expires: Number.MAX_SAFE_INTEGER } : clone(value),
      ]),
    );
    this.sessions = new Map();
    this.inquiries = new Map();
    this.statements = [];
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  execute(sql, args, mode) {
    const query = normalize(sql);
    this.statements.push({ sql, query, args: clone(args), mode });

    if (query === "select 1" || query.startsWith("select 1 ")) {
      return { rows: [query.includes(" as ok") ? { ok: 1 } : { 1: 1 }], changes: 0 };
    }

    if (query.includes("select id from admin_account")) {
      return { rows: this.adminAccount ? [{ id: 1 }] : [], changes: 0 };
    }

    if (query.includes("select algorithm,iterations,salt,hash from admin_account")) {
      return { rows: this.adminAccount ? [clone(this.adminAccount)] : [], changes: 0 };
    }

    if (query.startsWith("select expires from sessions")) {
      const [hash, minimum] = args;
      const expires = this.sessions.get(hash);
      return { rows: expires > minimum ? [{ expires }] : [], changes: 0 };
    }

    if (query.startsWith("insert into sessions")) {
      this.sessions.set(args[0], args[1]);
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("delete from sessions where hash")) {
      return { rows: [], changes: this.sessions.delete(args[0]) ? 1 : 0 };
    }

    if (query.startsWith("delete from sessions where expires")) {
      let changes = 0;
      for (const [hash, expires] of this.sessions) {
        if (expires <= args[0]) {
          this.sessions.delete(hash);
          changes += 1;
        }
      }
      return { rows: [], changes };
    }

    if (query.startsWith("select value from settings")) {
      const value = this.settings.get(args[0]);
      return { rows: value === undefined ? [] : [{ value }], changes: 0 };
    }

    if (query.startsWith("insert into settings")) {
      this.settings.set(args[0], args[1]);
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("update settings set value")) {
      if (!this.settings.has(args[1])) return { rows: [], changes: 0 };
      if (args.length > 2 && this.settings.get(args[1]) !== args[2]) return { rows: [], changes: 0 };
      this.settings.set(args[1], args[0]);
      return { rows: [], changes: 1 };
    }

    if (query.includes("from documents") && query.startsWith("select id,title,body,url,category")) {
      const rows = [...this.documents.values()]
        .sort((left, right) => String(right.updatedAt ?? right.updated_at).localeCompare(String(left.updatedAt ?? left.updated_at)))
        .map((document) => ({
          id: document.id,
          title: document.title,
          body: document.body,
          url: document.url ?? "",
          category: document.category,
          updatedAt: document.updatedAt ?? document.updated_at,
          published: document.published,
          oaSubmissionState: document.oaSubmissionState ?? document.oa_submission_state ?? "unknown",
          oaItemId: document.oaItemId ?? document.oa_item_id ?? null,
          oaSubmittedAt: document.oaSubmittedAt ?? document.oa_submitted_at ?? null,
          draftRevision: document.draftRevision ?? document.draft_revision ?? 1,
        }));
      return { rows, changes: 0 };
    }

    if (query.startsWith("select id,oa_submission_state as oasubmissionstate")) {
      const document = this.documents.get(args[0]);
      return {
        rows: document ? [{
          id: document.id,
          oaSubmissionState: document.oaSubmissionState ?? document.oa_submission_state ?? "unknown",
          oaItemId: document.oaItemId ?? document.oa_item_id ?? null,
          oaSubmittedAt: document.oaSubmittedAt ?? document.oa_submitted_at ?? null,
          draftRevision: document.draftRevision ?? document.draft_revision ?? 1,
        }] : [],
        changes: 0,
      };
    }

    if (query.startsWith("select id from documents where id")) {
      return { rows: this.documents.has(args[0]) ? [{ id: args[0] }] : [], changes: 0 };
    }

    if (query.startsWith("select count(*) as n from documents")) {
      return { rows: [{ n: this.documents.size }], changes: 0 };
    }

    if (query.startsWith("insert into documents (id,title,body,url,category,updated_at,published,oa_submission_state,draft_revision) select")) {
      const [id, title, body, url, category, updatedAt, published] = args;
      if (query.includes("where (select count(*) from documents) < 200") && this.documents.size >= 200) {
        return { rows: [], changes: 0 };
      }
      if (this.documents.has(id)) throw new Error("UNIQUE constraint failed: documents.id");
      this.documents.set(id, {
        id,
        title,
        body,
        url,
        category,
        updatedAt,
        published,
        oaSubmissionState: "unsubmitted",
        oaItemId: null,
        oaSubmittedAt: null,
        draftRevision: 1,
      });
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("update documents set title=")) {
      const [title, body, url, category, updatedAt, id, draftRevision] = args;
      const document = this.documents.get(id);
      const currentRevision = document?.draftRevision ?? document?.draft_revision ?? 1;
      const currentState = document?.oaSubmissionState ?? document?.oa_submission_state ?? "unknown";
      if (!document || currentRevision !== draftRevision || currentState !== "unsubmitted") {
        return { rows: [], changes: 0 };
      }
      Object.assign(document, {
        title,
        body,
        url,
        category,
        updatedAt,
        published: 0,
        draftRevision: currentRevision + 1,
      });
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("update documents set oa_submission_state='unknown'")) {
      const [id, draftRevision] = args;
      const document = this.documents.get(id);
      const currentRevision = document?.draftRevision ?? document?.draft_revision ?? 1;
      const currentState = document?.oaSubmissionState ?? document?.oa_submission_state ?? "unknown";
      if (!document || currentRevision !== draftRevision || currentState !== "unsubmitted") {
        return { rows: [], changes: 0 };
      }
      Object.assign(document, { oaSubmissionState: "unknown", oaItemId: null, oaSubmittedAt: null });
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("update documents set oa_submission_state='unsubmitted'")) {
      const [id, draftRevision] = args;
      const document = this.documents.get(id);
      const currentRevision = document?.draftRevision ?? document?.draft_revision ?? 1;
      const currentState = document?.oaSubmissionState ?? document?.oa_submission_state ?? "unknown";
      if (!document || currentRevision !== draftRevision || currentState !== "unknown") {
        return { rows: [], changes: 0 };
      }
      Object.assign(document, { oaSubmissionState: "unsubmitted", oaItemId: null, oaSubmittedAt: null });
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("update documents set oa_submission_state='submitted'")) {
      const [oaItemId, oaSubmittedAt, id, draftRevision] = args;
      const document = this.documents.get(id);
      const currentRevision = document?.draftRevision ?? document?.draft_revision ?? 1;
      const currentState = document?.oaSubmissionState ?? document?.oa_submission_state ?? "unknown";
      if (!document || currentRevision !== draftRevision || !["unknown", "unsubmitted"].includes(currentState)) {
        return { rows: [], changes: 0 };
      }
      Object.assign(document, { oaSubmissionState: "submitted", oaItemId, oaSubmittedAt });
      return { rows: [], changes: 1 };
    }

    if (query.startsWith("insert into limits")) {
      const [key, expires] = args;
      const previous = this.limits.get(key);
      const next = { count: (previous?.count ?? 0) + 1, expires };
      this.limits.set(key, next);
      return { rows: [{ count: next.count }], changes: 1 };
    }

    if (query.startsWith("delete from limits where expires")) {
      let changes = 0;
      for (const [key, value] of this.limits) {
        if (value.expires < args[0]) {
          this.limits.delete(key);
          changes += 1;
        }
      }
      return { rows: [], changes };
    }

    if (query.startsWith("select count from limits where key")) {
      const value = this.limits.get(args[0]);
      return { rows: value ? [{ count: value.count }] : [], changes: 0 };
    }

    if (query.startsWith("select reference from inquiries where request_id")) {
      const row = [...this.inquiries.values()].find((item) => item.requestId === args[0]);
      return { rows: row ? [{ reference: row.reference }] : [], changes: 0 };
    }

    if (query.startsWith("insert into inquiries")) {
      const [id, reference, requestId, name, organisation, contact, topic, summary, transcript, createdAt] = args;
      if (![...this.inquiries.values()].some((item) => item.requestId === requestId)) {
        this.inquiries.set(id, {
          id,
          reference,
          requestId,
          name,
          organisation,
          contact,
          topic,
          summary,
          transcript,
          status: "pending",
          createdAt,
        });
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }

    if (query.startsWith("select id,reference,name,organisation,contact,topic,summary,transcript,status")) {
      return { rows: [...this.inquiries.values()].map(clone), changes: 0 };
    }

    if (query.startsWith("update inquiries set status")) {
      const [status, id] = args;
      const inquiry = this.inquiries.get(id);
      if (!inquiry) return { rows: [], changes: 0 };
      inquiry.status = status;
      return { rows: [], changes: 1 };
    }

    throw new Error(`MockD1 does not implement SQL (${mode}): ${sql}`);
  }

  limitKey(prefix) {
    return [...this.limits.keys()].find((key) => key.startsWith(prefix));
  }
}

export function mockAssets() {
  const calls = [];
  return {
    calls,
    async fetch(request) {
      calls.push(new URL(request.url).pathname);
      const pathname = new URL(request.url).pathname;
      const isAsset = pathname.startsWith("/assets/");
      return new Response(isAsset ? "asset" : "<!doctype html><title>ARTS Robotics AI assistant</title>", {
        status: 200,
        headers: {
          "Content-Type": isAsset ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8",
          "Cache-Control": isAsset ? "public,max-age=31536000,immutable" : "no-store",
        },
      });
    },
  };
}
