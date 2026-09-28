SELECT name FROM sqlite_master WHERE type='table'
CREATE TABLE "customer" (id INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "email" TEXT)
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE ? ESCAPE '\'
SELECT name FROM sqlite_master WHERE type='table'
CREATE TABLE "order" (id INTEGER PRIMARY KEY AUTOINCREMENT, "title" TEXT, "status" TEXT, "total" INTEGER, "qty" INTEGER, "placed" TEXT, "seen" TEXT, "customer" TEXT, "done" INTEGER)
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE ? ESCAPE '\'
CREATE INDEX IF NOT EXISTS "idx_order_customer" ON "order" ("customer")
CREATE INDEX IF NOT EXISTS "idx_order_title_status" ON "order" ("title", "status")
CREATE INDEX IF NOT EXISTS "idx_order_status" ON "order" ("status")
SELECT name FROM sqlite_master WHERE type='table'
CREATE TABLE "item" (id INTEGER PRIMARY KEY AUTOINCREMENT, "order" TEXT, "qty" INTEGER, "price" INTEGER, "ok" INTEGER, "due" TEXT, "disc" INTEGER)
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE ? ESCAPE '\'
CREATE INDEX IF NOT EXISTS "idx_item_order" ON "item" ("order")
SELECT name FROM sqlite_master WHERE type='table'
CREATE TABLE "blank" (id INTEGER PRIMARY KEY AUTOINCREMENT)
SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE ? ESCAPE '\'
CREATE TABLE IF NOT EXISTS "_outbox" (id INTEGER PRIMARY KEY AUTOINCREMENT, "kind" TEXT, "connector" TEXT, "target" TEXT, "payload" TEXT, "status" TEXT, "code" INTEGER, "error" TEXT, "attempts" INTEGER DEFAULT 0, "at" TEXT, "updatedAt" TEXT, "claimedAt" INTEGER)
PRAGMA table_info("_outbox")
CREATE TABLE IF NOT EXISTS "_session" ("id" TEXT PRIMARY KEY, "user" INTEGER, "at" TEXT)
-- write
SELECT id FROM "order" WHERE "title"=? AND "status"=? AND id!=?
INSERT INTO "order" ("title","status","total","qty","placed","seen","customer","done") VALUES (?,?,?,?,?,?,?,?)
INSERT INTO "blank" DEFAULT VALUES
SELECT * FROM "order" WHERE id=?
SELECT id FROM "order" WHERE "title"=? AND "status"=? AND id!=?
UPDATE "order" SET "title"=?,"total"=? WHERE id=?
DELETE FROM "order" WHERE id=?
SELECT * FROM "order" WHERE id=?
SELECT id FROM "customer" WHERE LOWER("name")=LOWER(?) AND id!=?
SELECT id FROM "order" WHERE "qty"=? AND id!=?
SELECT id FROM "order" WHERE "title"=? AND "status"=? AND id!=?
SELECT COUNT(*) AS n FROM "order" WHERE "qty" >= ?
-- read
SELECT * FROM "order" WHERE "status"=? AND "qty" >= ? AND "qty" <= ? AND "qty" > ? AND "qty" < ? AND "qty" != ? AND "qty" IN (?,?) AND "customer" IS NULL AND "seen" IS NOT NULL AND LOWER("title") LIKE ? ESCAPE '\' AND (LOWER("title") LIKE ? ESCAPE '\' OR LOWER("status") LIKE ? ESCAPE '\') ORDER BY "title" ASC
SELECT * FROM "order" ORDER BY "total" DESC
SELECT * FROM "order" ORDER BY id DESC
SELECT * FROM "order" WHERE "qty"=? ORDER BY "placed" DESC LIMIT ? OFFSET ?
SELECT COUNT(*) AS n FROM "order" WHERE "done"=?
SELECT * FROM "item" WHERE "order" IN (?,?,?) ORDER BY id DESC
-- aggregate
SELECT strftime('%Y-%m', "placed") AS grp, SUM("total") AS "sum_total", COUNT(*) AS "n" FROM "order" WHERE "status"=? GROUP BY grp ORDER BY "grp" ASC LIMIT 5
SELECT "status" AS grp, AVG("qty") AS "a" FROM "order" GROUP BY grp ORDER BY "a" DESC
SELECT "qty" AS grp, MAX("qty") AS "m" FROM "order" GROUP BY grp ORDER BY "grp" DESC
SELECT strftime('%Y', "seen") AS grp, MIN("total") AS "m" FROM "order" GROUP BY grp ORDER BY "grp" ASC
SELECT strftime('%Y-%m-%d', "placed") AS grp, COUNT(*) AS "n" FROM "order" GROUP BY grp
-- compiled aggregates
SELECT SUM(((CASE WHEN (CASE WHEN (CASE WHEN (CASE WHEN COALESCE("ok",0) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN (CASE WHEN "qty" IS NULL OR 1 IS NULL THEN 0 WHEN "qty" > 1 THEN 1 ELSE 0 END) = 0 THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 OR (CASE WHEN "price" IS NULL AND "disc" IS NULL THEN 0 WHEN "price" IS NULL OR "disc" IS NULL THEN 1 WHEN "price" != "disc" THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 THEN ("qty" * "price") ELSE (0 * 100) END) + ("qty" * 100))) AS v FROM "item" AS t0 WHERE t0."order"=?
SELECT t0."order" AS grp, SUM(((CASE WHEN (CASE WHEN (CASE WHEN (CASE WHEN COALESCE("ok",0) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN (CASE WHEN "qty" IS NULL OR 1 IS NULL THEN 0 WHEN "qty" > 1 THEN 1 ELSE 0 END) = 0 THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 OR (CASE WHEN "price" IS NULL AND "disc" IS NULL THEN 0 WHEN "price" IS NULL OR "disc" IS NULL THEN 1 WHEN "price" != "disc" THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 THEN ("qty" * "price") ELSE (0 * 100) END) + ("qty" * 100))) AS v FROM "item" AS t0 WHERE t0."order" IN (?,?) GROUP BY t0."order"
SELECT COUNT(*) AS v FROM "item" AS t0 WHERE t0."order"=? AND ((CASE WHEN (CASE WHEN (CASE WHEN (CASE WHEN (CASE WHEN "due" IS NULL OR $today IS NULL THEN 0 WHEN "due" >= $today THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN COALESCE("ok",0) <> 0 THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN "due" IS NULL OR $now IS NULL THEN 0 WHEN "due" < $now THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN "price" IS NULL AND (2 * 100) IS NULL THEN 1 WHEN "price" IS NULL OR (2 * 100) IS NULL THEN 0 WHEN "price" = (2 * 100) THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN "qty" IS NULL AND 1 IS NULL THEN 0 WHEN "qty" IS NULL OR 1 IS NULL THEN 1 WHEN "qty" != 1 THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0)
SELECT t0."order" AS grp, COUNT(*) AS v FROM "item" AS t0 WHERE t0."order" IN (?) AND ((CASE WHEN (CASE WHEN (CASE WHEN (CASE WHEN (CASE WHEN "due" IS NULL OR $today IS NULL THEN 0 WHEN "due" >= $today THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN COALESCE("ok",0) <> 0 THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN "due" IS NULL OR $now IS NULL THEN 0 WHEN "due" < $now THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN "price" IS NULL AND (2 * 100) IS NULL THEN 1 WHEN "price" IS NULL OR (2 * 100) IS NULL THEN 0 WHEN "price" = (2 * 100) THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0 AND (CASE WHEN "qty" IS NULL AND 1 IS NULL THEN 0 WHEN "qty" IS NULL OR 1 IS NULL THEN 1 WHEN "qty" != 1 THEN 1 ELSE 0 END) <> 0 THEN 1 ELSE 0 END) <> 0) GROUP BY t0."order"
SELECT SUM(("total" + ((SELECT COUNT(*) FROM "item" AS t1 WHERE t1."order" = CAST(t0."id" AS TEXT) AND ((CASE WHEN COALESCE("ok",0) <> 0 THEN 1 ELSE 0 END) <> 0)) * 100))) AS v FROM "order" AS t0 WHERE t0."customer"=?
-- outbox and sessions
INSERT INTO "_outbox" ("kind","connector","target","payload","status","attempts","at","updatedAt") VALUES (?,?,?,?,?,?,?,?)
SELECT * FROM "_outbox" WHERE "status"=? AND "id"=? ORDER BY id DESC
SELECT * FROM "_outbox" WHERE "status"='queued' OR ("status"='sending' AND "claimedAt"<=?) ORDER BY id ASC
UPDATE "_outbox" SET "status"='sending', "claimedAt"=?, "updatedAt"=? WHERE id=? AND ("status"='queued' OR ("status"='sending' AND "claimedAt"<=?))
UPDATE "_outbox" SET "status"=?,"error"=?,"updatedAt"=? WHERE id=?
UPDATE "_outbox" SET "status"=?,"code"=?,"updatedAt"=? WHERE id=? AND "claimedAt"=? AND "status"='sending'
INSERT OR REPLACE INTO "_session" ("id", "user", "at") VALUES (?,?,?)
SELECT "user" FROM "_session" WHERE id=?
DELETE FROM "_session" WHERE id=?
