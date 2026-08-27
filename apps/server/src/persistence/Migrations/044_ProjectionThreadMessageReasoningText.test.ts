import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionThreadMessageReasoningText", (it) => {
  it.effect("adds the nullable reasoning text column to message projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* runMigrations({ toMigrationInclusive: 44 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const reasoningText = columns.find((column) => column.name === "reasoning_text");

      assert.equal(reasoningText?.name, "reasoning_text");
      // Nullable: rows written before this migration have no reasoning to record.
      assert.equal(reasoningText?.notnull, 0);
    }),
  );

  it.effect("preserves messages already projected before the column existed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'answer text',
          0,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 44 });

      const rows = yield* sql<{
        readonly text: string;
        readonly reasoning_text: string | null;
      }>`
        SELECT text, reasoning_text FROM projection_thread_messages WHERE message_id = 'message-1'
      `;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "answer text");
      // Pre-existing rows carry no reasoning rather than an empty string, so the
      // read path can distinguish "never had reasoning" from "reasoned nothing".
      assert.equal(rows[0]?.reasoning_text, null);
    }),
  );
});
