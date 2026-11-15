import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261115114955_add_session_pull_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_pull_request\` (
          \`session_id\` text PRIMARY KEY,
          \`repository\` text NOT NULL,
          \`number\` integer NOT NULL,
          \`base_ref\` text NOT NULL,
          \`head_ref\` text NOT NULL,
          \`base_sha\` text NOT NULL,
          \`head_sha\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_pull_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_pull_request_repository_number_idx\` ON \`session_pull_request\` (\`repository\`,\`number\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
