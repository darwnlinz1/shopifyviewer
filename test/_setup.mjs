// Preloaded by `npm test`: keep every test process's database in a scratch dir
// so runs never read or pollute data/siteviewer.db.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SITEVIEWER_DB_PATH ||= join(mkdtempSync(join(tmpdir(), "siteviewer-test-db-")), "siteviewer.db");
