CREATE TYPE "public"."message_channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mpesa_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."mpesa_match" AS ENUM('matched', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."mpesa_shortcode_type" AS ENUM('paybill', 'till');--> statement-breakpoint
CREATE TYPE "public"."receipt_kind" AS ENUM('order', 'collection');--> statement-breakpoint
CREATE TYPE "public"."stk_status" AS ENUM('pending', 'success', 'failed', 'timeout');--> statement-breakpoint
CREATE TABLE "device_staff" (
	"device_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_staff_device_id_membership_id_pk" PRIMARY KEY("device_id","membership_id")
);
--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"order_id" uuid,
	"channel" "message_channel" NOT NULL,
	"to" text NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"html" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"provider_id" text,
	"segments" integer,
	"dedupe_key" text,
	"requested_by" uuid,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "message_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "mpesa_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"outlet_id" uuid,
	"environment" "mpesa_environment" DEFAULT 'sandbox' NOT NULL,
	"shortcode_type" "mpesa_shortcode_type" NOT NULL,
	"shortcode" text NOT NULL,
	"party_b" text NOT NULL,
	"consumer_key_enc" text NOT NULL,
	"consumer_secret_enc" text NOT NULL,
	"passkey_enc" text NOT NULL,
	"callback_token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"c2b_registered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_configs_callback_token_unique" UNIQUE("callback_token"),
	CONSTRAINT "mpesa_configs_business_outlet_unique" UNIQUE NULLS NOT DISTINCT("business_id","outlet_id"),
	CONSTRAINT "mpesa_configs_codes" CHECK ("mpesa_configs"."shortcode" ~ '^[0-9]{5,10}$' and "mpesa_configs"."party_b" ~ '^[0-9]{5,10}$')
);
--> statement-breakpoint
CREATE TABLE "mpesa_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"merchant_request_id" text,
	"checkout_request_id" text,
	"status" "stk_status" DEFAULT 'pending' NOT NULL,
	"result_code" text,
	"result_desc" text,
	"receipt_number" text,
	"payment_id" uuid,
	"requested_by" uuid NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "mpesa_requests_checkout_request_id_unique" UNIQUE("checkout_request_id"),
	CONSTRAINT "mpesa_requests_amount_positive" CHECK ("mpesa_requests"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "mpesa_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"trans_id" text NOT NULL,
	"trans_type" text,
	"amount_cents" bigint NOT NULL,
	"msisdn" text,
	"payer_name" text,
	"bill_ref" text,
	"trans_time" timestamp with time zone NOT NULL,
	"raw" jsonb NOT NULL,
	"status" "mpesa_match" NOT NULL,
	"order_id" uuid,
	"payment_id" uuid,
	"matched_by" uuid,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mpesa_transactions_trans_id_unique" UNIQUE("business_id","trans_id"),
	CONSTRAINT "mpesa_transactions_amount_positive" CHECK ("mpesa_transactions"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kind" "receipt_kind" NOT NULL,
	"source_id" uuid,
	"doc" jsonb NOT NULL,
	"tax_breakdown" jsonb NOT NULL,
	"kra_invoice_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_order_kind_source_unique" UNIQUE NULLS NOT DISTINCT("order_id","kind","source_id")
);
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "actor_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "device_staff" ADD CONSTRAINT "device_staff_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_staff" ADD CONSTRAINT "device_staff_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_configs" ADD CONSTRAINT "mpesa_configs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_configs" ADD CONSTRAINT "mpesa_configs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_requests" ADD CONSTRAINT "mpesa_requests_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_requests" ADD CONSTRAINT "mpesa_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_requests" ADD CONSTRAINT "mpesa_requests_config_id_mpesa_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mpesa_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_requests" ADD CONSTRAINT "mpesa_requests_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_requests" ADD CONSTRAINT "mpesa_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_requests" ADD CONSTRAINT "mpesa_requests_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_config_id_mpesa_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."mpesa_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpesa_transactions" ADD CONSTRAINT "mpesa_transactions_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_staff_membership_idx" ON "device_staff" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "message_outbox_due_idx" ON "message_outbox" USING btree ("next_attempt_at") WHERE "message_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "message_outbox_business_sent_idx" ON "message_outbox" USING btree ("business_id","channel","sent_at");--> statement-breakpoint
CREATE INDEX "mpesa_requests_pending_idx" ON "mpesa_requests" USING btree ("created_at") WHERE "mpesa_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "mpesa_transactions_unmatched_idx" ON "mpesa_transactions" USING btree ("business_id","trans_time") WHERE "mpesa_transactions"."status" = 'unmatched';--> statement-breakpoint
CREATE INDEX "receipts_business_created_idx" ON "receipts" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_business_reference_unique" ON "payments" USING btree ("business_id","reference") WHERE "payments"."reference" is not null and "payments"."kind" = 'payment';