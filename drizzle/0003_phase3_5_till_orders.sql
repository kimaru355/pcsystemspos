CREATE TYPE "public"."sync_op_status" AS ENUM('applied', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('payment', 'refund');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'mark_paid', 'mpesa', 'other');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"code" varchar(2) NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"registered_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"last_sync_at" timestamp with time zone,
	"last_order_seq" integer DEFAULT 0 NOT NULL,
	"clock_jumps" integer DEFAULT 0 NOT NULL,
	"last_clock_jump_at" timestamp with time zone,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "devices_outlet_code_unique" UNIQUE("outlet_id","code"),
	CONSTRAINT "devices_code_format" CHECK ("devices"."code" ~ '^[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "sync_ops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_membership_id" uuid,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "sync_op_status" NOT NULL,
	"error_code" text,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "collection_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"qty_milli" bigint NOT NULL,
	"base_qty_milli" bigint NOT NULL,
	"movement_id" uuid NOT NULL,
	CONSTRAINT "collection_lines_movement_id_unique" UNIQUE("movement_id"),
	CONSTRAINT "collection_lines_collection_line_unique" UNIQUE("collection_id","order_line_id"),
	CONSTRAINT "collection_lines_qty_positive" CHECK ("collection_lines"."qty_milli" > 0 and "collection_lines"."base_qty_milli" > 0)
);
--> statement-breakpoint
CREATE TABLE "collections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"value_cents" bigint NOT NULL,
	"credit_granted_cents" bigint DEFAULT 0 NOT NULL,
	"approved_by" uuid,
	"actor_user_id" uuid NOT NULL,
	"device_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collections_value_nonneg" CHECK ("collections"."value_cents" >= 0),
	CONSTRAINT "collections_credit_approved" CHECK ("collections"."credit_granted_cents" = 0 or "collections"."approved_by" is not null)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_business_phone_unique" UNIQUE("business_id","phone")
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"pack_id" uuid,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"unit_label" text NOT NULL,
	"base_qty_per_unit_milli" bigint NOT NULL,
	"qty_milli" bigint NOT NULL,
	"collected_milli" bigint DEFAULT 0 NOT NULL,
	"cancelled_milli" bigint DEFAULT 0 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"list_price_cents" integer NOT NULL,
	"floor_cents" integer NOT NULL,
	"tax_category" "tax_category" NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"price_approved_by" uuid,
	CONSTRAINT "order_lines_order_position_unique" UNIQUE("order_id","position"),
	CONSTRAINT "order_lines_qty_positive" CHECK ("order_lines"."qty_milli" > 0),
	CONSTRAINT "order_lines_base_positive" CHECK ("order_lines"."base_qty_per_unit_milli" > 0),
	CONSTRAINT "order_lines_progress" CHECK ("order_lines"."collected_milli" >= 0 and "order_lines"."cancelled_milli" >= 0 and "order_lines"."collected_milli" + "order_lines"."cancelled_milli" <= "order_lines"."qty_milli"),
	CONSTRAINT "order_lines_price_nonneg" CHECK ("order_lines"."unit_price_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" uuid,
	"number" text NOT NULL,
	"seq" integer NOT NULL,
	"customer_id" uuid,
	"customer_name" text,
	"customer_phone" text,
	"status" "order_status" DEFAULT 'open' NOT NULL,
	"credit_cents" bigint DEFAULT 0 NOT NULL,
	"flagged_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancel_reason" text,
	CONSTRAINT "orders_business_number_unique" UNIQUE("business_id","number"),
	CONSTRAINT "orders_seq_positive" CHECK ("orders"."seq" > 0),
	CONSTRAINT "orders_credit_nonneg" CHECK ("orders"."credit_cents" >= 0),
	CONSTRAINT "orders_customer_complete" CHECK (("orders"."customer_name" is null) = ("orders"."customer_phone" is null))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" "payment_kind" DEFAULT 'payment' NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" text,
	"approved_by" uuid,
	"actor_user_id" uuid NOT NULL,
	"device_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_cents" > 0),
	CONSTRAINT "payments_mark_paid_approved" CHECK ("payments"."method" <> 'mark_paid' or ("payments"."approved_by" is not null and "payments"."reason" is not null)),
	CONSTRAINT "payments_refund_reason" CHECK ("payments"."kind" <> 'refund' or "payments"."reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_user_id_unique";--> statement-breakpoint
DROP INDEX "audit_log_business_created_seq_idx";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "pin_salt" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "pin_verifier" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "op_id" uuid;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_id_business_unique" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_id_business_unique" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_business_fk" FOREIGN KEY ("outlet_id","business_id") REFERENCES "public"."outlets"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_ops" ADD CONSTRAINT "sync_ops_actor_membership_id_memberships_id_fk" FOREIGN KEY ("actor_membership_id") REFERENCES "public"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_lines" ADD CONSTRAINT "collection_lines_collection_id_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."collections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_lines" ADD CONSTRAINT "collection_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_lines" ADD CONSTRAINT "collection_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_lines" ADD CONSTRAINT "collection_lines_movement_id_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collections" ADD CONSTRAINT "collections_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_price_approved_by_users_id_fk" FOREIGN KEY ("price_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_pack_item_fk" FOREIGN KEY ("pack_id","item_id") REFERENCES "public"."item_packs"("id","item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_item_business_fk" FOREIGN KEY ("item_id","business_id") REFERENCES "public"."items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_business_fk" FOREIGN KEY ("outlet_id","business_id") REFERENCES "public"."outlets"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_business_id_idx" ON "devices" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "sync_ops_business_device_received_idx" ON "sync_ops" USING btree ("business_id","device_id","received_at");--> statement-breakpoint
CREATE INDEX "sync_ops_business_rejected_idx" ON "sync_ops" USING btree ("business_id","received_at") WHERE "sync_ops"."status" = 'rejected';--> statement-breakpoint
CREATE INDEX "collections_order_id_idx" ON "collections" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_business_item_idx" ON "order_lines" USING btree ("business_id","item_id");--> statement-breakpoint
CREATE INDEX "orders_business_outlet_status_idx" ON "orders" USING btree ("business_id","outlet_id","status");--> statement-breakpoint
CREATE INDEX "orders_business_occurred_idx" ON "orders" USING btree ("business_id","occurred_at");--> statement-breakpoint
CREATE INDEX "orders_customer_id_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_business_occurred_idx" ON "payments" USING btree ("business_id","occurred_at");--> statement-breakpoint
ALTER TABLE "membership_outlets" ADD CONSTRAINT "membership_outlets_outlet_business_fk" FOREIGN KEY ("outlet_id","business_id") REFERENCES "public"."outlets"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_barcodes" ADD CONSTRAINT "item_barcodes_item_business_fk" FOREIGN KEY ("item_id","business_id") REFERENCES "public"."items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_packs" ADD CONSTRAINT "item_packs_item_business_fk" FOREIGN KEY ("item_id","business_id") REFERENCES "public"."items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_outlet_business_fk" FOREIGN KEY ("outlet_id","business_id") REFERENCES "public"."outlets"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_item_business_fk" FOREIGN KEY ("item_id","business_id") REFERENCES "public"."items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_outlet_business_fk" FOREIGN KEY ("outlet_id","business_id") REFERENCES "public"."outlets"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_business_fk" FOREIGN KEY ("item_id","business_id") REFERENCES "public"."items"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_active_user_unique" ON "memberships" USING btree ("user_id") WHERE "memberships"."active";--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "item_barcodes_item_id_idx" ON "item_barcodes" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "items_category_id_idx" ON "items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "items_brand_id_idx" ON "items" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "items_group_id_idx" ON "items" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "outlet_stock_item_id_idx" ON "outlet_stock" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_movements_order_line_id_idx" ON "stock_movements" USING btree ("order_line_id") WHERE "stock_movements"."order_line_id" is not null;--> statement-breakpoint
CREATE INDEX "audit_log_business_created_seq_idx" ON "audit_log" USING btree ("business_id","created_at" DESC NULLS FIRST,"seq" DESC NULLS FIRST);--> statement-breakpoint
-- The stock ledger is append-only: on-hand must always equal the sum of its rows.
CREATE FUNCTION "stock_movements_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "stock_movements_no_update_delete" BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION "stock_movements_append_only"();
