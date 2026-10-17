CREATE TYPE "public"."tax_category" AS ENUM('A', 'B', 'C', 'D', 'E');--> statement-breakpoint
CREATE TYPE "public"."adjust_reason" AS ENUM('damaged', 'count_correction', 'lost_stolen', 'other');--> statement-breakpoint
CREATE TYPE "public"."movement_kind" AS ENUM('receive', 'adjust', 'collect');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_business_name_unique" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_business_parent_name_unique" UNIQUE NULLS NOT DISTINCT("business_id","parent_id","name")
);
--> statement-breakpoint
CREATE TABLE "item_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"item_id" uuid NOT NULL,
	"pack_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_barcodes_business_barcode_unique" UNIQUE("business_id","barcode")
);
--> statement-breakpoint
CREATE TABLE "item_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category_id" uuid,
	"brand_id" uuid,
	"attribute_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_groups_business_name_unique" UNIQUE("business_id","name")
);
--> statement-breakpoint
CREATE TABLE "item_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_qty_milli" bigint NOT NULL,
	"price_cents" integer NOT NULL,
	"floor_cents" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_packs_item_name_unique" UNIQUE("item_id","name"),
	CONSTRAINT "item_packs_id_item_unique" UNIQUE("id","item_id"),
	CONSTRAINT "item_packs_base_qty_positive" CHECK ("item_packs"."base_qty_milli" > 0),
	CONSTRAINT "item_packs_floor_le_price" CHECK ("item_packs"."floor_cents" >= 0 and "item_packs"."floor_cents" <= "item_packs"."price_cents")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"group_id" uuid,
	"category_id" uuid,
	"brand_id" uuid,
	"name" text NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sku" text,
	"base_unit" text NOT NULL,
	"fractional" boolean DEFAULT false NOT NULL,
	"price_cents" integer NOT NULL,
	"floor_cents" integer NOT NULL,
	"tax_category" "tax_category" DEFAULT 'B' NOT NULL,
	"low_stock_milli" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_floor_le_price" CHECK ("items"."floor_cents" >= 0 and "items"."floor_cents" <= "items"."price_cents")
);
--> statement-breakpoint
CREATE TABLE "outlet_stock" (
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"on_hand_milli" bigint DEFAULT 0 NOT NULL,
	"flagged_negative_at" timestamp with time zone,
	CONSTRAINT "outlet_stock_outlet_id_item_id_pk" PRIMARY KEY("outlet_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"kind" "movement_kind" NOT NULL,
	"qty_milli" bigint NOT NULL,
	"unit_cost_cents" integer,
	"reason" "adjust_reason",
	"note" text,
	"order_line_id" uuid,
	"actor_user_id" uuid NOT NULL,
	"device_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_qty_nonzero" CHECK ("stock_movements"."qty_milli" <> 0),
	CONSTRAINT "stock_movements_receive_positive" CHECK ("stock_movements"."kind" <> 'receive' or "stock_movements"."qty_milli" > 0),
	CONSTRAINT "stock_movements_collect_negative" CHECK ("stock_movements"."kind" <> 'collect' or "stock_movements"."qty_milli" < 0),
	CONSTRAINT "stock_movements_adjust_reason" CHECK ("stock_movements"."kind" <> 'adjust' or "stock_movements"."reason" is not null),
	CONSTRAINT "stock_movements_other_note" CHECK ("stock_movements"."reason" <> 'other' or "stock_movements"."note" is not null)
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_barcodes" ADD CONSTRAINT "item_barcodes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_barcodes" ADD CONSTRAINT "item_barcodes_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_barcodes" ADD CONSTRAINT "item_barcodes_pack_item_fk" FOREIGN KEY ("pack_id","item_id") REFERENCES "public"."item_packs"("id","item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_groups" ADD CONSTRAINT "item_groups_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_groups" ADD CONSTRAINT "item_groups_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_groups" ADD CONSTRAINT "item_groups_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_packs" ADD CONSTRAINT "item_packs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_packs" ADD CONSTRAINT "item_packs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_group_id_item_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."item_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlet_stock" ADD CONSTRAINT "outlet_stock_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_business_sku_unique" ON "items" USING btree ("business_id","sku") WHERE "items"."sku" is not null;--> statement-breakpoint
CREATE INDEX "stock_movements_business_outlet_item_occurred_idx" ON "stock_movements" USING btree ("business_id","outlet_id","item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "membership_outlets_outlet_id_idx" ON "membership_outlets" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "memberships_business_id_idx" ON "memberships" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_code_format" CHECK ("outlets"."code" ~ '^[A-Z0-9]{2,5}$');