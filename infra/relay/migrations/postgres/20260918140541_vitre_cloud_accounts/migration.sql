CREATE TABLE "relay_cloud_accounts" (
	"user_id" varchar(255) PRIMARY KEY,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL
);
